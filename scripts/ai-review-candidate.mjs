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
    const result = await client.complete(buildReviewMessages({ candidate, ...sources, allowedTags }));
    const report = validateReviewReport(result.report, { readme: sources.readme });
    if (report.candidateId !== candidate.candidateId || report.repository !== candidate.repository) {
      throw new Error("Invalid review report: candidate identity changed by model");
    }
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
