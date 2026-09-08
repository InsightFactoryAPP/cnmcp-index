import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const RESOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const MARKER_PATTERN = /<!-- cnmcp-flow: ai-resource-pr issue: (\d+) resource: ([a-z0-9]+(?:-[a-z0-9]+)*) base: ([a-f0-9]{40}) head: ([a-f0-9]{40}) artifact: ([a-f0-9]{64}) signature: ([a-f0-9]{64}) -->/;

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository slug");
}

function assertResourceId(resourceId) {
  if (typeof resourceId !== "string" || resourceId.length < 3 || resourceId.length > 80 || !RESOURCE_ID.test(resourceId)) {
    throw new Error("Invalid resource id");
  }
}

function assertIssueNumber(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid Issue number");
}

function headers(token, write = false) {
  if (typeof token !== "string" || token.length < 1) throw new Error("CNMCP bot token is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cnmcp-resource-bot/1.0",
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
  if (!response.ok) {
    const error = new Error(`GitHub resource PR request failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function buildResourceBranchName(resourceId, issueNumber) {
  assertResourceId(resourceId);
  assertIssueNumber(issueNumber);
  return `bot/resource/${resourceId}-${issueNumber}`;
}

export function parseResourcePrMarker(body) {
  if (typeof body !== "string") return null;
  const match = body.match(MARKER_PATTERN);
  if (!match) return null;
  return { issueNumber: Number.parseInt(match[1], 10), resourceId: match[2], baseSha: match[3], headSha: match[4], artifactSha: match[5], signature: match[6] };
}

function markerIdentity({ issueNumber, resourceId, baseSha, headSha, artifactSha }) {
  return [issueNumber, resourceId, baseSha, headSha, artifactSha].join("\n");
}

export function verifyResourcePrMarker(marker, token) {
  if (!marker || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(marker.signature ?? "")) return false;
  const expected = createHmac("sha256", token).update(markerIdentity(marker)).digest();
  const actual = Buffer.from(marker.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createResourcePrMarker({ issueNumber, resourceId, baseSha, headSha, artifactSha, token }) {
  if (!COMMIT_SHA.test(baseSha) || !COMMIT_SHA.test(headSha) || !/^[a-f0-9]{64}$/.test(artifactSha)) throw new Error("Invalid resource PR identity");
  const identity = { issueNumber, resourceId, baseSha, headSha, artifactSha };
  const signature = createHmac("sha256", token).update(markerIdentity(identity)).digest("hex");
  return `<!-- cnmcp-flow: ai-resource-pr issue: ${issueNumber} resource: ${resourceId} base: ${baseSha} head: ${headSha} artifact: ${artifactSha} signature: ${signature} -->`;
}

export function replaceResourcePrMarker(body, marker) {
  if (typeof body !== "string" || !parseResourcePrMarker(body) || typeof marker !== "string") throw new Error("Cannot replace invalid resource PR marker");
  return body.replace(MARKER_PATTERN, marker);
}

function validateExistingPull(pull, { repository, branch, issueNumber, resourceId, token }) {
  const marker = parseResourcePrMarker(pull?.body);
  if (
    !marker || !verifyResourcePrMarker(marker, token) ||
    marker.issueNumber !== issueNumber ||
    marker.resourceId !== resourceId ||
    pull?.head?.ref !== branch ||
    String(pull?.head?.repo?.full_name ?? "").toLowerCase() !== repository.toLowerCase() ||
    pull?.base?.ref !== "main"
  ) {
    throw new Error("Existing resource PR does not match the expected automation identity");
  }
}

function serializeResource(resource, resourceId) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource) || resource.id !== resourceId) {
    throw new Error("Resource payload id must match resource id");
  }
  const content = `${JSON.stringify(resource, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > 200_000) throw new Error("Resource JSON is too large");
  return content;
}

function artifactHash(resourceContent, readme) {
  return createHash("sha256").update(resourceContent).update("\0").update(readme).digest("hex");
}

function pullBody({ marker, issueNumber, resource }) {
  return [
    marker,
    "<!-- cnmcp-flow: submission -->",
    "",
    "由 AI 目录编辑助理基于上游 README 生成。",
    `- 上游仓库：${resource.repository}`,
    `- 类型依据：DeepSeek README 语义分类为 \`${resource.kind}\`，并已核验证据摘录`,
    `- 作者/来源：${resource.author?.name ?? "unknown"} / GitHub API 与上游 README`,
    "- 确定性检查：公开状态、SPDX、查重、标签、Schema 与完整 Catalog 预校验通过",
    "- 未执行任何安装命令或候选仓库代码",
    "",
    `Closes #${issueNumber}`,
  ].join("\n");
}

export async function createResourcePullRequest({
  fetchImpl = globalThis.fetch,
  token,
  repository,
  issueNumber,
  resource,
  readme,
  baseBranch = "main",
}) {
  assertRepository(repository);
  assertIssueNumber(issueNumber);
  if (baseBranch !== "main") throw new Error("Resource PR base branch must be main");
  const resourceId = resource?.id;
  assertResourceId(resourceId);
  if (typeof readme !== "string" || readme.trim().length === 0) throw new Error("Resource README is required");
  if (Buffer.byteLength(readme, "utf8") > 200_000) throw new Error("Resource README is too large");
  const normalizedReadme = readme.endsWith("\n") ? readme : `${readme}\n`;
  const resourceContent = serializeResource(resource, resourceId);
  const artifactSha = artifactHash(resourceContent, normalizedReadme);
  const branch = buildResourceBranchName(resourceId, issueNumber);
  const owner = repository.split("/")[0];
  const query = new URLSearchParams({ state: "open", head: `${owner}:${branch}`, base: baseBranch, per_page: "10" });
  const existingPulls = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls?${query}`);
  if (!Array.isArray(existingPulls)) throw new Error("GitHub returned an invalid Pull Request list");
  if (existingPulls.length > 1) throw new Error("Multiple open resource PRs found for the same branch");
  const existingPull = existingPulls[0] ?? null;
  if (existingPull) validateExistingPull(existingPull, { repository, branch, issueNumber, resourceId, token });
  const baseRef = await githubRequest(fetchImpl, token, `/repos/${repository}/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef?.object?.sha;
  if (!COMMIT_SHA.test(baseSha ?? "")) throw new Error("GitHub returned an invalid base branch SHA");
  const baseCommit = await githubRequest(fetchImpl, token, `/repos/${repository}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (!COMMIT_SHA.test(baseTreeSha ?? "")) throw new Error("GitHub returned an invalid base tree SHA");
  const existingMarker = existingPull ? parseResourcePrMarker(existingPull.body) : null;
  if (existingPull && existingMarker?.headSha === existingPull.head.sha && existingMarker?.baseSha === baseSha && existingMarker?.artifactSha === artifactSha) {
    return { action: "existing", branch, headSha: existingPull.head.sha, pullNumber: existingPull.number, pullUrl: existingPull.html_url };
  }

  const tree = await githubRequest(fetchImpl, token, `/repos/${repository}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        { path: `resources/${resourceId}/resource.json`, mode: "100644", type: "blob", content: resourceContent },
        { path: `resources/${resourceId}/README.md`, mode: "100644", type: "blob", content: normalizedReadme },
      ],
    }),
  });
  if (!COMMIT_SHA.test(tree?.sha ?? "")) throw new Error("GitHub returned an invalid resource tree SHA");
  const commit = await githubRequest(fetchImpl, token, `/repos/${repository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `chore(resource): add ${resourceId}`,
      tree: tree.sha,
      parents: [baseSha],
    }),
  });
  const headSha = commit?.sha;
  if (!COMMIT_SHA.test(headSha ?? "")) throw new Error("GitHub returned an invalid resource commit SHA");
  let branchExists = Boolean(existingPull);
  if (!branchExists) {
    try {
      await githubRequest(fetchImpl, token, `/repos/${repository}/git/ref/heads/${branch}`);
      branchExists = true;
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  if (branchExists) {
    await githubRequest(fetchImpl, token, `/repos/${repository}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: headSha, force: true }),
    });
  } else {
    await githubRequest(fetchImpl, token, `/repos/${repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }),
    });
  }

  const marker = createResourcePrMarker({ issueNumber, resourceId, baseSha, headSha, artifactSha, token });
  if (existingPull) {
    const pull = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls/${existingPull.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: pullBody({ marker, issueNumber, resource }) }),
    });
    return { action: "updated", branch, headSha, pullNumber: pull.number, pullUrl: pull.html_url };
  }
  const pull = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `chore(resource): add ${resourceId}`,
      head: branch,
      base: baseBranch,
      draft: false,
      body: pullBody({ marker, issueNumber, resource }),
    }),
  });
  if (!Number.isInteger(pull?.number) || typeof pull?.html_url !== "string") {
    throw new Error("GitHub returned an invalid created Pull Request");
  }
  return {
    action: "created",
    branch,
    headSha,
    pullNumber: pull.number,
    pullUrl: pull.html_url,
  };
}
