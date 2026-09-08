import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";

import { normalizeGithubRepository, validateReviewReport } from "./ai-review.mjs";

const require = createRequire(import.meta.url);
const proposalSchema = require("../../schemas/ai-resource-proposal.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateProposalSchema = ajv.compile(proposalSchema);

const ACCEPTED_KINDS = new Set(["mcp", "skill", "plugin"]);
const REJECTED_LICENSES = new Set(["", "NOASSERTION", "OTHER"]);
const SPDX_EXPRESSION = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function add(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function proposalSchemaErrors() {
  return (validateProposalSchema.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

export function validateResourceProposal(value) {
  if (!validateProposalSchema(value)) {
    const details = proposalSchemaErrors();
    throw new Error(`Invalid resource proposal${details ? `: ${details}` : ""}`);
  }
  return value;
}

export function evaluateResourceQualification({
  report,
  proposal,
  repository,
  readme,
  existingResources = [],
  allowedTags = [],
} = {}) {
  const reasons = [];
  try {
    validateReviewReport(report, { readme });
  } catch {
    reasons.push("invalid_review_report");
  }
  try {
    validateResourceProposal(proposal);
  } catch {
    reasons.push("invalid_resource_proposal");
  }

  if (!report || !proposal || !repository) {
    return { eligible: false, reasons: [...new Set(reasons.length ? reasons : ["missing_input"])] };
  }

  const reportRepository = normalizeGithubRepository(report.repository);
  const proposalRepository = normalizeGithubRepository(proposal.repository);
  const sourceRepository = normalizeGithubRepository(repository.htmlUrl);
  add(reasons, !reportRepository || reportRepository !== proposalRepository || reportRepository !== sourceRepository, "candidate_identity_mismatch");
  add(reasons, report.candidateId !== proposal.candidateId, "candidate_identity_mismatch");
  add(reasons, repository.private !== false, "repository_not_public");
  add(reasons, repository.disabled !== false, "repository_disabled");
  add(reasons, repository.archived !== false, "repository_archived");
  add(reasons, typeof readme !== "string" || readme.trim().length === 0, "readme_missing");

  const license = String(repository.license ?? "").trim();
  add(reasons, REJECTED_LICENSES.has(license.toUpperCase()) || !SPDX_EXPRESSION.test(license), "license_not_spdx");
  add(reasons, report.inScope !== true, "outside_catalog_scope");
  add(reasons, !ACCEPTED_KINDS.has(report.kind?.value), "resource_kind_unknown");

  const allowed = new Set(Array.isArray(allowedTags) ? allowedTags : []);
  add(reasons, !Array.isArray(proposal.tags) || proposal.tags.some((tag) => !allowed.has(tag)), "tag_not_allowed");

  if (Array.isArray(existingResources)) {
    for (const resource of existingResources) {
      if (reportRepository && normalizeGithubRepository(resource?.repository) === reportRepository) reasons.push("duplicate_repository");
      if (normalizedText(resource?.id) && normalizedText(resource.id) === normalizedText(proposal.id)) reasons.push("duplicate_id");
      if (normalizedText(resource?.name) && normalizedText(resource.name) === normalizedText(proposal.name)) reasons.push("duplicate_name");
    }
  }

  const evidencedHighRisk = Array.isArray(report.risks) && report.risks.some(
    (risk) => risk?.level === "high" && ["upstream", "github_api"].includes(risk.basis) && typeof risk.evidenceUrl === "string",
  );
  add(reasons, evidencedHighRisk, "evidenced_high_risk");

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
