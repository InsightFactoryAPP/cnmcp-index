import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordCandidateFailure } from "./lib/github-ai-review.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const token = required("GITHUB_TOKEN");
  const result = await recordCandidateFailure({
    token,
    repository: required("GITHUB_REPOSITORY"),
    issueNumber: Number.parseInt(required("AI_REVIEW_ISSUE_NUMBER"), 10),
    trustedAuthors: ["github-actions[bot]", process.env.CNMCP_BOT_LOGIN?.trim()].filter(Boolean),
  });
  console.info(JSON.stringify({ event: "ai_review_failure", result: result.quarantined ? "quarantined" : "retry", attempts: result.attempts }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "ai_review_failure", result: "failed", error: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
