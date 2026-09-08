import { createHash } from "node:crypto";

import {
  createResourcePrMarker,
  parseResourcePrMarker,
  replaceResourcePrMarker,
  verifyResourcePrMarker,
} from "./github-resource-pr.mjs";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const COMMIT_SHA = /^[a-f0-9]{40}$/;

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository slug");
}

function headers(token, write = false) {
  if (typeof token !== "string" || token.length < 1) throw new Error("CNMCP bot token is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cnmcp-resource-auto-merge/1.0",
    "X-GitHub-Api-Version": API_VERSION,
    ...(write ? { "Content-Type": "application/json" } : {}),
  };
}

async function githubRequest(fetchImpl, token, apiPath, init = {}) {
  const response = await fetchImpl(`${GITHUB_API}${apiPath}`, {
    ...init,
    redirect: "error",
    headers: { ...headers(token, Boolean(init.body)), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`GitHub auto-merge request failed: HTTP ${response.status}`);
  return response.json();
}

function assertValidatedWorkflow({ workflowConclusion, workflowEvent, validatedHeadSha, validatedBaseSha, trustedMainSha }) {
  if (typeof workflowConclusion !== "string" || !workflowConclusion || workflowEvent !== "pull_request") throw new Error("Auto-merge requires a completed PR Validation pull_request run");
  if (!COMMIT_SHA.test(validatedHeadSha ?? "")) throw new Error("Invalid validated head SHA");
  if (!COMMIT_SHA.test(validatedBaseSha ?? "")) throw new Error("Invalid validated base SHA");
  if (!COMMIT_SHA.test(trustedMainSha ?? "")) throw new Error("Invalid trusted main SHA");
}

function validatePull(pull, { repository, pullNumber, botLogin, validatedHeadSha, validatedBaseSha, token, allowMarkerTransition = false }) {
  if (pull?.number !== pullNumber || pull?.state !== "open" || pull?.draft !== false) {
    throw new Error("Resource PR must be an open Ready Pull Request");
  }
  if (pull?.base?.ref !== "main") throw new Error("Resource PR base branch must be main");
  if (String(pull?.head?.repo?.full_name ?? "").toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Resource PR must use a branch in the catalog repository");
  }
  if (String(pull?.user?.login ?? "").toLowerCase() !== botLogin.toLowerCase()) {
    throw new Error("Resource PR author must match the CNMCP token owner");
  }
  if (pull?.head?.sha !== validatedHeadSha) throw new Error("Resource PR does not match the validated head SHA");
  const marker = parseResourcePrMarker(pull?.body);
  if (!marker || !verifyResourcePrMarker(marker, token) || (!allowMarkerTransition && (marker.headSha !== validatedHeadSha || marker.baseSha !== validatedBaseSha))) {
    throw new Error("Resource PR automation marker is missing, forged or stale");
  }
  const expectedBranch = `bot/resource/${marker.resourceId}-${marker.issueNumber}`;
  if (pull?.head?.ref !== expectedBranch) throw new Error("Resource PR branch does not match its automation marker");
  return marker;
}

async function readPullFile({ fetchImpl, token, repository, filePath, ref }) {
  const query = new URLSearchParams({ ref });
  const payload = await githubRequest(fetchImpl, token, `/repos/${repository}/contents/${filePath}?${query}`);
  if (payload?.encoding !== "base64" || typeof payload?.content !== "string") throw new Error("GitHub returned invalid resource file content");
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64");
}

async function verifyArtifactHash({ fetchImpl, token, repository, marker, headSha }) {
  const [resource, readme] = await Promise.all([
    readPullFile({ fetchImpl, token, repository, filePath: `resources/${marker.resourceId}/resource.json`, ref: headSha }),
    readPullFile({ fetchImpl, token, repository, filePath: `resources/${marker.resourceId}/README.md`, ref: headSha }),
  ]);
  const actual = createHash("sha256").update(resource).update("\0").update(readme).digest("hex");
  if (actual !== marker.artifactSha) throw new Error("Resource PR artifact does not match its signed marker");
  return { resource, readme };
}

function validateFiles(files, resourceId) {
  const expected = [
    `resources/${resourceId}/README.md`,
    `resources/${resourceId}/resource.json`,
  ];
  if (!Array.isArray(files) || files.length !== 2) throw new Error("Resource PR must contain exactly two allowed files");
  const actual = files.map((file) => file?.filename).sort();
  if (!files.every((file) => file?.status === "added") || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Resource PR must contain exactly two allowed files");
  }
}

export async function autoMergeResourcePullRequest({
  fetchImpl = globalThis.fetch,
  token,
  repository,
  pullNumber,
  workflowConclusion,
  workflowEvent,
  validatedHeadSha,
  validatedBaseSha,
  trustedMainSha,
  validateArtifacts = async () => undefined,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  assertRepository(repository);
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("Invalid Pull Request number");
  assertValidatedWorkflow({ workflowConclusion, workflowEvent, validatedHeadSha, validatedBaseSha, trustedMainSha });
  const user = await githubRequest(fetchImpl, token, "/user");
  if (typeof user?.login !== "string" || user.login.length === 0) throw new Error("Unable to identify CNMCP token owner");
  const pull = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`);
  const marker = validatePull(pull, { repository, pullNumber, botLogin: user.login, validatedHeadSha, validatedBaseSha, token, allowMarkerTransition: true });
  if (workflowConclusion === "failure") {
    await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`, {
      method: "PATCH", body: JSON.stringify({ state: "closed" }),
    });
    await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${marker.issueNumber}/comments`, {
      method: "POST", body: JSON.stringify({ body: "自动生成的资源 PR 未通过 PR Validation，已关闭并隔离该候选，避免阻塞后续队列。" }),
    });
    await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${marker.issueNumber}`, {
      method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    });
    return { action: "quarantined", pullNumber, issueNumber: marker.issueNumber };
  }
  if (workflowConclusion !== "success") {
    return { action: "deferred", pullNumber, issueNumber: marker.issueNumber, conclusion: workflowConclusion };
  }
  const files = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}/files?per_page=100`);
  validateFiles(files, marker.resourceId);
  const commits = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}/commits?per_page=100`);
  if (!Array.isArray(commits) || commits.length < 1 || commits.at(-1)?.sha !== validatedHeadSha) {
    throw new Error("Resource PR commit history does not end at the validated automation commit");
  }
  const artifacts = await verifyArtifactHash({ fetchImpl, token, repository, marker, headSha: validatedHeadSha });

  const mainRef = await githubRequest(fetchImpl, token, `/repos/${repository}/git/ref/heads/main`);
  const currentMainSha = mainRef?.object?.sha;
  if (!COMMIT_SHA.test(currentMainSha ?? "")) throw new Error("GitHub returned an invalid main SHA");
  if (currentMainSha !== validatedBaseSha) {
    await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}/update-branch`, {
      method: "PUT",
      body: JSON.stringify({ expected_head_sha: validatedHeadSha }),
    });
    let updatedPull = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(500);
      const candidate = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`);
      if (COMMIT_SHA.test(candidate?.head?.sha ?? "") && candidate.head.sha !== validatedHeadSha) {
        updatedPull = candidate;
        break;
      }
    }
    if (!updatedPull) throw new Error("Timed out while updating stale resource PR branch");
    const nextMarker = createResourcePrMarker({
      issueNumber: marker.issueNumber,
      resourceId: marker.resourceId,
      baseSha: currentMainSha,
      headSha: updatedPull.head.sha,
      artifactSha: marker.artifactSha,
      token,
    });
    await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ body: replaceResourcePrMarker(updatedPull.body, nextMarker) }),
    });
    return { action: "updated", pullNumber, headSha: updatedPull.head.sha };
  }
  if (currentMainSha !== trustedMainSha) throw new Error("Trusted checkout does not match the current main branch");
  let resource;
  try {
    resource = JSON.parse(artifacts.resource.toString("utf8"));
  } catch {
    throw new Error("Resource PR contains invalid resource JSON");
  }
  if (resource?.id !== marker.resourceId) throw new Error("Resource JSON id does not match the signed marker");
  await validateArtifacts({ resource, readme: artifacts.readme.toString("utf8") });
  if (marker.headSha !== validatedHeadSha || marker.baseSha !== validatedBaseSha) {
    const nextMarker = createResourcePrMarker({ ...marker, baseSha: validatedBaseSha, headSha: validatedHeadSha, token });
    await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`, {
      method: "PATCH", body: JSON.stringify({ body: replaceResourcePrMarker(pull.body, nextMarker) }),
    });
  }

  const currentPull = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}`);
  validatePull(currentPull, { repository, pullNumber, botLogin: user.login, validatedHeadSha, validatedBaseSha, token });
  const currentMainRef = await githubRequest(fetchImpl, token, `/repos/${repository}/git/ref/heads/main`);
  if (currentMainRef?.object?.sha !== validatedBaseSha || currentMainRef.object.sha !== trustedMainSha) throw new Error("Main changed before merge; refusing stale-base merge");
  const result = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash", sha: validatedHeadSha }),
  });
  if (result?.merged !== true || !COMMIT_SHA.test(result?.sha ?? "")) throw new Error("GitHub did not merge the resource PR");
  return { action: "merged", pullNumber, mergeSha: result.sha };
}
