import path from "node:path";
import { fileURLToPath } from "node:url";

import { prevalidateResourceArtifacts } from "./lib/ai-resource-artifacts.mjs";
import { autoMergeResourcePullRequest } from "./lib/github-auto-merge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name) {
  const value = Number.parseInt(required(name), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function runAutoMerge({ fetchImpl = globalThis.fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await autoMergeResourcePullRequest({
        fetchImpl,
        token: required("CNMCP_BOT_TOKEN"),
        repository: required("GITHUB_REPOSITORY"),
        pullNumber: positiveInteger("AUTO_MERGE_PR_NUMBER"),
        workflowConclusion: required("AUTO_MERGE_WORKFLOW_CONCLUSION"),
        workflowEvent: required("AUTO_MERGE_WORKFLOW_EVENT"),
        validatedHeadSha: required("AUTO_MERGE_HEAD_SHA"),
        validatedBaseSha: required("AUTO_MERGE_BASE_SHA"),
        trustedMainSha: required("AUTO_MERGE_TRUSTED_MAIN_SHA"),
        validateArtifacts: ({ resource, readme }) => prevalidateResourceArtifacts({ resource, readme, projectRoot: ROOT }),
      });
      console.info(JSON.stringify({ event: "ai_resource_auto_merge", ...result }));
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAutoMerge().catch((error) => {
    console.error(JSON.stringify({
      event: "ai_resource_auto_merge",
      result: "failed",
      error: error instanceof Error ? error.message : "unknown",
    }));
    process.exitCode = 1;
  });
}
