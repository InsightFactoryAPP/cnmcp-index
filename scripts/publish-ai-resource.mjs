import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResourceArtifacts, prevalidateResourceArtifacts } from "./lib/ai-resource-artifacts.mjs";
import { evaluateResourceQualification } from "./lib/ai-resource-qualification.mjs";
import { parseCandidateIssue } from "./lib/ai-review.mjs";
import { getAuthenticatedUser, getIssue, readCandidateSources, upsertReviewComment } from "./lib/github-ai-review.mjs";
import { createResourcePullRequest } from "./lib/github-resource-pr.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hasLabel(issue, expected) {
  return issue.labels.some((label) => (typeof label === "string" ? label : label?.name) === expected);
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

export async function publishPreparedResource({ fetchImpl = globalThis.fetch } = {}) {
  const token = required("CNMCP_BOT_TOKEN");
  const repository = required("GITHUB_REPOSITORY");
  const encoded = process.env.AI_REVIEW_PAYLOAD_BASE64?.trim();
  const payload = JSON.parse(encoded
    ? Buffer.from(encoded, "base64").toString("utf8")
    : await readFile(required("AI_REVIEW_OUTPUT_PATH"), "utf8"));
  if (payload?.schemaVersion !== 1 || payload.repository !== repository || !Number.isInteger(payload.issueNumber) || !payload.report || !payload.proposal || !payload.generatedAt) {
    throw new Error("Invalid prepared resource envelope");
  }
  const [botLogin, issue, catalog, allowedTags] = await Promise.all([
    getAuthenticatedUser({ fetchImpl, token }),
    getIssue({ fetchImpl, token, repository, issueNumber: payload.issueNumber }),
    loadCatalog(),
    loadAllowedTags(),
  ]);
  const candidate = parseCandidateIssue(issue.body);
  if (
    issue.state !== "open" ||
    !hasLabel(issue, "auto-discovery") ||
    !issue.body.includes("<!-- cnmcp-flow: auto-discovery -->") ||
    String(issue.author ?? "").toLowerCase() !== botLogin.toLowerCase() ||
    candidate.repository !== payload.candidateRepository ||
    payload.resource?.repository !== candidate.repository ||
    typeof payload.reviewBody !== "string" ||
    !payload.reviewBody.startsWith("<!-- cnmcp-flow: ai-review fingerprint:")
  ) throw new Error("Prepared resource does not match its trusted Discovery Issue");
  const sources = await readCandidateSources({ fetchImpl, token, repoFullName: candidate.repoFullName });
  const qualification = evaluateResourceQualification({
    report: payload.report,
    proposal: payload.proposal,
    repository: sources.repository,
    readme: sources.readme,
    existingResources: catalog,
    allowedTags,
  });
  if (!qualification.eligible) throw new Error(`Candidate changed before publish: ${qualification.reasons.join(",")}`);
  const artifacts = buildResourceArtifacts({
    report: payload.report,
    proposal: payload.proposal,
    repository: sources.repository,
    generatedAt: payload.generatedAt,
  });
  await prevalidateResourceArtifacts({ ...artifacts, projectRoot: ROOT });
  const pull = await createResourcePullRequest({
    fetchImpl,
    token,
    repository,
    issueNumber: payload.issueNumber,
    resource: artifacts.resource,
    readme: artifacts.readme,
  });
  const reviewBody = payload.reviewBody.replace(
    "已通过确定性资格检查，等待发布步骤创建资源 PR。",
    `已创建或复用资源 PR：[#${pull.pullNumber}](<${pull.pullUrl}>)。PR Validation 通过后将自动合并。`,
  );
  await upsertReviewComment({
    fetchImpl,
    token,
    repository,
    issueNumber: payload.issueNumber,
    body: reviewBody,
    trustedAuthors: [botLogin, "github-actions[bot]"],
  });
  return pull;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishPreparedResource().then((result) => {
    console.info(JSON.stringify({ event: "ai_resource_publish", result: result.action, pullNumber: result.pullNumber }));
  }).catch((error) => {
    console.error(JSON.stringify({ event: "ai_resource_publish", result: "failed", error: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
