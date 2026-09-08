import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDiscoveryIssueMarker, findPendingCandidateIssue, getAuthenticatedUser, getIssue } from "./lib/github-ai-review.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hasLabel(issue, expected) {
  return issue.labels.some((label) => (typeof label === "string" ? label : label?.name) === expected);
}

export async function preflightCandidate({ fetchImpl = globalThis.fetch } = {}) {
  const token = required("CNMCP_BOT_TOKEN");
  const repository = required("GITHUB_REPOSITORY");
  const botLogin = await getAuthenticatedUser({ fetchImpl, token });
  const raw = process.env.AI_REVIEW_ISSUE_NUMBER?.trim();
  const issueNumber = raw
    ? Number.parseInt(raw, 10)
    : await findPendingCandidateIssue({ fetchImpl, token, repository, expectedAuthor: botLogin });
  if (issueNumber === null) return { issueNumber: null, botLogin };
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid candidate Issue number");
  const issue = await getIssue({ fetchImpl, token, repository, issueNumber });
  if (
    issue.state !== "open" ||
    !hasLabel(issue, "auto-discovery") ||
    String(issue.author ?? "").toLowerCase() !== botLogin.toLowerCase()
  ) throw new Error("Candidate Issue was not created by the configured Discovery bot");
  await ensureDiscoveryIssueMarker({ fetchImpl, token, repository, issue });
  return { issueNumber, botLogin };
}

async function main() {
  const result = await preflightCandidate();
  const output = process.env.GITHUB_OUTPUT?.trim();
  if (output) await appendFile(output, `issue_number=${result.issueNumber ?? ""}\nbot_login=${result.botLogin}\n`, "utf8");
  console.info(JSON.stringify({ event: "ai_candidate_preflight", result: result.issueNumber ? "accepted" : "empty", issueNumber: result.issueNumber }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "ai_candidate_preflight", result: "failed", error: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
