import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEW_PROTOCOL_VERSION,
  buildReviewMessages,
  findCatalogDuplicate,
  parseCandidateIssue,
  renderDuplicateComment,
  renderReviewComment,
  validateReviewReport,
} from "./lib/ai-review.mjs";
import { buildResourceArtifacts, buildResourceProposal, prevalidateResourceArtifacts, resourceIdFromRepository } from "./lib/ai-resource-artifacts.mjs";
import { evaluateResourceQualification } from "./lib/ai-resource-qualification.mjs";
import { createDeepSeekClient } from "./lib/deepseek-client.mjs";
import {
  closeCandidateIssue,
  commentHasFingerprint,
  findPendingCandidateIssue,
  findReviewComment,
  getIssue,
  hasOpenResourcePullRequest,
  readCandidateSources,
  upsertIssueReadmeSnapshot,
  upsertReviewComment,
} from "./lib/github-ai-review.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function issueNumber({ fetchImpl, token, repository }) {
  const raw = process.env.AI_REVIEW_ISSUE_NUMBER?.trim();
  if (!raw) return findPendingCandidateIssue({ fetchImpl, token, repository });
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("AI_REVIEW_ISSUE_NUMBER must be a positive integer");
  return value;
}

function fingerprint(parts) {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 20);
}

async function loadCatalog() {
  const payload = JSON.parse(await readFile(path.join(ROOT, "public", "catalog.json"), "utf8"));
  if (!Array.isArray(payload.resources)) throw new Error("public/catalog.json is invalid");
  return payload.resources;
}

async function loadAllowedTags() {
  const payload = JSON.parse(await readFile(path.join(ROOT, "catalog", "tags.json"), "utf8"));
  if (!Array.isArray(payload.tags)) throw new Error("catalog/tags.json is invalid");
  return payload.tags.map((tag) => tag.id).filter((id) => typeof id === "string");
}

function hasLabel(issue, expected) {
  return issue.labels.some((label) => (typeof label === "string" ? label : label?.name) === expected);
}

function automationResult(body, { eligible, reasons }) {
  const lines = [body, "", "## 自动处理结果", ""];
  if (eligible) {
    lines.push("已通过确定性资格检查，等待发布步骤创建资源 PR。");
  } else {
    lines.push(`未创建资源 PR。确定性检查结果：${reasons.join("、") || "不符合收录条件"}。`);
  }
  return lines.join("\n");
}

function addUsage(total, usage) {
  return {
    inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + (usage?.totalTokens ?? 0),
  };
}

const REVIEW_BASIS = new Set(["github_api", "upstream", "ai_summary", "unknown"]);
const COMPATIBILITY_STATUS = new Set(["native", "supported", "partial", "unsupported", "unknown"]);
const RISK_LEVEL = new Set(["low", "medium", "high"]);
const MAINTENANCE_STATUS = new Set(["active", "inactive", "archived", "unknown"]);

function basisFields(item) {
  const requestedBasis = REVIEW_BASIS.has(item?.basis) ? item.basis : "unknown";
  const hasEvidence = typeof item?.evidenceUrl === "string" && item.evidenceUrl.startsWith("https://");
  const basis = ["github_api", "upstream"].includes(requestedBasis) && !hasEvidence ? "unknown" : requestedBasis;
  const evidenceUrl = basis === "unknown" || basis === "ai_summary" ? null : item.evidenceUrl;
  return { basis, evidenceUrl };
}

function shortText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return value?.trim() ?? null;
}

function platformSlug(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export function normalizeReviewReportShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const useCases = Array.isArray(value.useCases) ? value.useCases.flatMap((item) => {
    const text = shortText(item?.value, item?.description, item?.title, item?.name);
    return text ? [{ value: text.slice(0, 300), ...basisFields(item) }] : [];
  }).slice(0, 8) : [];
  const compatibility = Array.isArray(value.compatibility) ? value.compatibility.flatMap((item) => {
    const platform = platformSlug(item?.platform ?? item?.name);
    if (!platform) return [];
    const evidence = basisFields(item);
    const requestedStatus = COMPATIBILITY_STATUS.has(item?.status) ? item.status : "unknown";
    const status = ["github_api", "upstream"].includes(evidence.basis) ? requestedStatus : "unknown";
    const note = shortText(item?.note, item?.description, "证据不足。");
    return [{ platform, status, ...evidence, note: note.length >= 2 ? note.slice(0, 240) : "证据不足。" }];
  }).slice(0, 12) : [];
  const risks = Array.isArray(value.risks) ? value.risks.flatMap((item) => {
    const title = shortText(item?.title, item?.risk, item?.description, item?.name);
    if (!title || title.length < 2) return [];
    const levelCandidate = item?.level ?? item?.severity;
    const level = RISK_LEVEL.has(levelCandidate) ? levelCandidate : "medium";
    return [{ level, title: title.slice(0, 160), ...basisFields(item) }];
  }).slice(0, 12) : [];
  const scopeEvidence = {
    ...basisFields(value.scopeEvidence),
    evidenceExcerpt: shortText(value.scopeEvidence?.evidenceExcerpt)?.slice(0, 300) ?? null,
  };
  const kind = {
    value: value.kind?.value,
    ...basisFields(value.kind),
    evidenceExcerpt: shortText(value.kind?.evidenceExcerpt)?.slice(0, 300) ?? null,
  };
  const license = {
    value: shortText(value.license?.value, "unknown").slice(0, 300),
    ...basisFields(value.license),
  };
  const maintenanceEvidence = basisFields(value.maintenance);
  const maintenance = {
    status: MAINTENANCE_STATUS.has(value.maintenance?.status) ? value.maintenance.status : "unknown",
    ...maintenanceEvidence,
    note: shortText(value.maintenance?.note, value.maintenance?.description, "证据不足。").slice(0, 240),
  };
  const stringList = (items, maximum, length) => Array.isArray(items)
    ? [...new Set(items.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
        .slice(0, maximum)
        .map((item) => item.slice(0, length))
    : [];
  return {
    schemaVersion: value.schemaVersion,
    candidateId: value.candidateId,
    repository: value.repository,
    inScope: value.inScope,
    scopeEvidence,
    kind,
    summaryZh: value.summaryZh,
    suggestedTags: stringList(value.suggestedTags, 12, 64),
    targetUsers: stringList(value.targetUsers, 8, 100),
    useCases,
    license,
    maintenance,
    compatibility,
    risks,
    missingInformation: stringList(value.missingInformation, 12, 160),
    recommendation: value.recommendation,
    recommendationReason: value.recommendationReason,
  };
}

export async function completeValidatedReview({ client, messages, readme, candidate, maxValidationAttempts = 2 }) {
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastError;
  for (let attempt = 1; attempt <= maxValidationAttempts; attempt += 1) {
    const retryMessage = attempt === 1 ? [] : [{
      role: "user",
      content: [
        "上一份 JSON 未通过结构校验，请丢弃并重新生成完整 JSON。",
        `校验错误：${String(lastError?.message ?? "invalid review report").slice(0, 1800)}`,
        "kind.value 只能是 mcp、skill、plugin、unknown。",
        "useCases 每项只能包含 value、basis、evidenceUrl。",
        "compatibility 每项必须且只能包含 platform、status、basis、evidenceUrl、note；证据不足可返回空数组。",
        "risks 每项必须且只能包含 level、title、basis、evidenceUrl；没有可验证风险可返回空数组。",
        "license 只能包含 value、basis、evidenceUrl；maintenance 只能包含 status、basis、evidenceUrl、note。",
        "不要增加任何字段，不要输出 Markdown。",
      ].join("\n"),
    }];
    const result = await client.complete([...messages, ...retryMessage]);
    usage = addUsage(usage, result.usage);
    try {
      const report = validateReviewReport(result.report, { readme });
      if (report.candidateId !== candidate.candidateId || report.repository !== candidate.repository) {
        throw new Error("Invalid review report: candidate identity changed by model");
      }
      return { report, usage, validationAttempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === maxValidationAttempts) {
        const normalized = normalizeReviewReportShape(result.report);
        const report = validateReviewReport(normalized, { readme });
        if (report.candidateId !== candidate.candidateId || report.repository !== candidate.repository) {
          throw new Error("Invalid review report: candidate identity changed by model");
        }
        return { report, usage, validationAttempts: attempt, normalized: true };
      }
    }
  }
  throw lastError;
}

export async function runCandidateReview({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const startedAt = Date.now();
  const githubToken = required("GITHUB_TOKEN");
  const catalogRepository = required("GITHUB_REPOSITORY");
  const trustedAuthors = ["github-actions[bot]", process.env.CNMCP_BOT_LOGIN?.trim()].filter(Boolean);
  const number = await issueNumber({ fetchImpl, token: githubToken, repository: catalogRepository });
  if (number === null) {
    console.info(JSON.stringify({ event: "ai_review", result: "no_pending_candidate" }));
    return { action: "no_pending_candidate" };
  }
  const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
  const issue = await getIssue({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number });
  if (issue.state !== "open" || !hasLabel(issue, "auto-discovery") || !issue.body.includes("<!-- cnmcp-flow: auto-discovery -->")) {
    throw new Error("Issue is not an open auto-discovery candidate");
  }
  const candidate = parseCandidateIssue(issue.body);
  const sources = await readCandidateSources({ fetchImpl, token: githubToken, repoFullName: candidate.repoFullName });
  const generatedAt = now().toISOString();
  if (!sources.readme || !sources.readmeMetadata) {
    const body = `<!-- cnmcp-flow: ai-review no-readme -->\n## AI 候选审核报告\n\n**不收录：上游仓库没有可读取的 README。**`;
    await upsertReviewComment({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number, body, trustedAuthors });
    await closeCandidateIssue({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number });
    return { action: "closed", candidateId: candidate.candidateId, recommendation: "do_not_list" };
  }
  await upsertIssueReadmeSnapshot({
    fetchImpl,
    token: githubToken,
    repository: catalogRepository,
    issue,
    readme: sources.readme,
    readmeMetadata: sources.readmeMetadata,
    fetchedAt: generatedAt,
  });
  const runFingerprint = fingerprint([
    candidate.candidateId,
    sources.readmeMetadata.sha,
    model,
    REVIEW_PROTOCOL_VERSION,
  ]);
  const existing = await findReviewComment({
    fetchImpl,
    token: githubToken,
    repository: catalogRepository,
    issueNumber: number,
    trustedAuthors,
  });
  if (commentHasFingerprint(existing, runFingerprint) && process.env.AI_REVIEW_FORCE !== "true") {
    const hasPull = await hasOpenResourcePullRequest({
      fetchImpl,
      token: githubToken,
      repository: catalogRepository,
      issueNumber: number,
      resourceId: resourceIdFromRepository(candidate.repository),
      trustedAuthors,
    });
    if (hasPull) {
      console.info(JSON.stringify({ event: "ai_review", result: "unchanged", candidateId: candidate.candidateId, model }));
      return { action: "unchanged", candidateId: candidate.candidateId };
    }
  }

  const catalog = await loadCatalog();
  const allowedTags = await loadAllowedTags();
  const duplicate = findCatalogDuplicate(candidate.repository, catalog);
  let body;
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let recommendation = "do_not_list";
  if (duplicate) {
    body = renderDuplicateComment({ candidate, duplicate, fingerprint: runFingerprint, generatedAt });
    await upsertReviewComment({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number, body, trustedAuthors });
    await closeCandidateIssue({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number });
    console.info(JSON.stringify({ event: "ai_review", result: "closed_duplicate", candidateId: candidate.candidateId }));
    return { action: "closed", candidateId: candidate.candidateId, recommendation: "do_not_list" };
  } else {
    const client = createDeepSeekClient({
      apiKey: required("DEEPSEEK_API_KEY"),
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
      model,
      fetchImpl,
      timeoutMs: Number.parseInt(process.env.AI_REVIEW_TIMEOUT_MS || "180000", 10),
      maxTokens: Number.parseInt(process.env.AI_REVIEW_MAX_TOKENS || "6000", 10),
      maxAttempts: Number.parseInt(process.env.AI_REVIEW_MAX_ATTEMPTS || "2", 10),
    });
    const result = await completeValidatedReview({
      client,
      messages: buildReviewMessages({ candidate, ...sources, allowedTags }),
      readme: sources.readme,
      candidate,
    });
    const report = result.report;
    usage = result.usage;
    recommendation = report.recommendation;
    const proposal = buildResourceProposal({ report, repository: sources.repository });
    const qualification = evaluateResourceQualification({
      report,
      proposal,
      repository: sources.repository,
      readme: sources.readme,
      existingResources: catalog,
      allowedTags,
    });
    if (qualification.eligible) {
      const artifacts = buildResourceArtifacts({ report, proposal, repository: sources.repository, generatedAt });
      await prevalidateResourceArtifacts({ ...artifacts, projectRoot: ROOT });
      body = automationResult(
        renderReviewComment({ report, fingerprint: runFingerprint, model, usage, generatedAt }),
        qualification,
      );
      const prepared = JSON.stringify({
        schemaVersion: 1,
        repository: catalogRepository,
        issueNumber: number,
        candidateRepository: candidate.repository,
        generatedAt,
        report,
        proposal,
        reviewBody: body,
        ...artifacts,
      });
      await writeFile(required("AI_REVIEW_OUTPUT_PATH"), prepared, { encoding: "utf8", mode: 0o600 });
      if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `prepared=${Buffer.from(prepared, "utf8").toString("base64")}\n`, "utf8");
      }
      console.info(JSON.stringify({ event: "ai_review", result: "prepared", candidateId: candidate.candidateId, recommendation }));
      return { action: "prepared", candidateId: candidate.candidateId, recommendation, usage };
    }
    body = automationResult(
      renderReviewComment({ report, fingerprint: runFingerprint, model, usage, generatedAt }),
      qualification,
    );
    if (!qualification.eligible) {
      await upsertReviewComment({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number, body, trustedAuthors });
      await closeCandidateIssue({ fetchImpl, token: githubToken, repository: catalogRepository, issueNumber: number });
      console.info(JSON.stringify({ event: "ai_review", result: "closed_ineligible", candidateId: candidate.candidateId, reasons: qualification.reasons }));
      return { action: "closed", candidateId: candidate.candidateId, recommendation, reasons: qualification.reasons, usage };
    }
  }
  const writeResult = await upsertReviewComment({
    fetchImpl,
    token: githubToken,
    repository: catalogRepository,
    issueNumber: number,
    body,
    trustedAuthors,
  });
  console.info(
    JSON.stringify({
      event: "ai_review",
      result: writeResult.action,
      candidateId: candidate.candidateId,
      recommendation,
      model: duplicate ? "not_called_duplicate" : model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - startedAt,
    }),
  );
  return { action: writeResult.action, candidateId: candidate.candidateId, recommendation, usage };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCandidateReview().catch((error) => {
    console.error(JSON.stringify({ event: "ai_review", result: "failed", error: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
