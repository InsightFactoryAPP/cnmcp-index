import { createReadmeSnapshot, replaceIssueReadmeSnapshot } from "./readme-snapshot.mjs";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const COMMENT_MARKER = "<!-- cnmcp-flow: ai-review";

function trustedComment(comment, trustedAuthors) {
  const author = String(comment?.user?.login ?? "").toLowerCase();
  return author.length > 0 && trustedAuthors.some((login) => String(login ?? "").toLowerCase() === author);
}

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository slug");
}

function headers(token, write = false) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cnmcp-ai-review/1.0",
    "X-GitHub-Api-Version": API_VERSION,
    ...(write ? { "Content-Type": "application/json" } : {}),
  };
}

async function githubRequest(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    redirect: "error",
    headers: { ...headers(token, Boolean(init.body)), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const error = new Error(`GitHub API request failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

function decodeContent(payload, maxBytes) {
  if (!payload || payload.encoding !== "base64" || typeof payload.content !== "string") return "";
  const content = Buffer.from(payload.content.replace(/\n/g, ""), "base64");
  if (content.byteLength > maxBytes) return content.subarray(0, maxBytes).toString("utf8");
  return content.toString("utf8");
}

export async function getIssue({ fetchImpl = globalThis.fetch, token, repository, issueNumber }) {
  assertRepository(repository);
  const payload = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}`);
  if (typeof payload.body !== "string") throw new Error("Candidate Issue has no body");
  return {
    number: payload.number,
    title: payload.title ?? "",
    body: payload.body,
    labels: payload.labels ?? [],
    state: payload.state ?? "open",
    author: payload.user?.login ?? null,
  };
}

export async function getAuthenticatedUser({ fetchImpl = globalThis.fetch, token }) {
  const user = await githubRequest(fetchImpl, token, "/user");
  if (typeof user?.login !== "string" || !user.login) throw new Error("Unable to identify GitHub token owner");
  return user.login;
}

export async function findPendingCandidateIssue({ fetchImpl = globalThis.fetch, token, repository, expectedAuthor = null }) {
  assertRepository(repository);
  for (let page = 1; page <= 10; page += 1) {
    const issues = await githubRequest(fetchImpl, token, `/repos/${repository}/issues?state=open&labels=auto-discovery&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid Issue list");
    for (const issue of issues) {
      if (issue?.pull_request || !Number.isInteger(issue?.number)) continue;
      if (expectedAuthor && String(issue?.user?.login ?? "").toLowerCase() !== expectedAuthor.toLowerCase()) continue;
      const marked = typeof issue?.body === "string" && issue.body.includes("<!-- cnmcp-flow: auto-discovery -->");
      const legacy = typeof issue?.body === "string" && String(issue?.title ?? "").startsWith("[自动发现]") &&
        issue.body.startsWith("## 自动发现候选") && issue.body.includes("### 候选 ID") && issue.body.includes("### 源码地址");
      if (marked || legacy) return issue.number;
    }
    if (issues.length < 100) break;
  }
  return null;
}

export async function ensureDiscoveryIssueMarker({ fetchImpl = globalThis.fetch, token, repository, issue }) {
  assertRepository(repository);
  if (issue.body.includes("<!-- cnmcp-flow: auto-discovery -->")) return issue;
  const legacy = issue.title.startsWith("[自动发现]") && issue.body.startsWith("## 自动发现候选") &&
    issue.body.includes("### 候选 ID") && issue.body.includes("### 源码地址");
  if (!legacy) throw new Error("Candidate Issue has no trusted Discovery marker");
  const body = issue.body.replace("## 自动发现候选", "## 自动发现候选\n\n<!-- cnmcp-flow: auto-discovery -->");
  const payload = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issue.number}`, {
    method: "PATCH", body: JSON.stringify({ body }),
  });
  return { ...issue, body: payload.body ?? body };
}

export async function readCandidateSources({ fetchImpl = globalThis.fetch, token, repoFullName }) {
  assertRepository(repoFullName);
  const repo = await githubRequest(fetchImpl, token, `/repos/${repoFullName}`);
  const optionalFile = async (path) => {
    try {
      return await githubRequest(fetchImpl, token, path);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  };
  const readme = await optionalFile(`/repos/${repoFullName}/readme`);
  const licenseFile = await optionalFile(`/repos/${repoFullName}/license`);
  return {
    repository: {
      fullName: String(repo.full_name ?? repoFullName).toLowerCase(),
      htmlUrl: repo.html_url,
      description: repo.description ?? "",
      name: repo.name ?? repoFullName.split("/").at(-1),
      private: repo.private,
      disabled: repo.disabled,
      archived: Boolean(repo.archived),
      stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : 0,
      forks: Number.isFinite(repo.forks_count) ? repo.forks_count : 0,
      pushedAt: repo.pushed_at ?? null,
      defaultBranch: repo.default_branch ?? null,
      license: repo.license?.spdx_id ?? null,
      owner: {
        login: repo.owner?.login ?? repoFullName.split("/")[0],
        htmlUrl: repo.owner?.html_url ?? `https://github.com/${repoFullName.split("/")[0]}`,
      },
      evidenceUrl: `${GITHUB_API}/repos/${repoFullName}`,
    },
    readme: decodeContent(readme, 100_000),
    readmeMetadata: readme && typeof readme.sha === "string" && typeof readme.html_url === "string"
      ? { sha: readme.sha, url: readme.html_url, size: readme.size ?? null }
      : null,
    licenseText: decodeContent(licenseFile, 50_000),
  };
}

export async function upsertIssueReadmeSnapshot({ fetchImpl = globalThis.fetch, token, repository, issue, readme, readmeMetadata, fetchedAt }) {
  assertRepository(repository);
  if (!readmeMetadata || typeof readme !== "string" || readme.trim().length === 0) throw new Error("Latest README is required");
  const snapshot = createReadmeSnapshot({ content: readme, sha: readmeMetadata.sha, url: readmeMetadata.url, fetchedAt });
  const updated = replaceIssueReadmeSnapshot(issue.body, snapshot);
  if (!updated.changed) return { action: "unchanged", body: issue.body, snapshot };
  const payload = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: updated.body }),
  });
  return { action: "updated", body: payload.body ?? updated.body, snapshot };
}

export async function closeCandidateIssue({ fetchImpl = globalThis.fetch, token, repository, issueNumber }) {
  assertRepository(repository);
  await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
  });
  return { action: "closed" };
}

export async function recordCandidateFailure({ fetchImpl = globalThis.fetch, token, repository, issueNumber, trustedAuthors = [], maxAttempts = 3 }) {
  assertRepository(repository);
  const comments = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
  const failure = Array.isArray(comments) ? comments.find(
    (comment) => trustedComment(comment, trustedAuthors) && typeof comment?.body === "string" && comment.body.startsWith("<!-- cnmcp-flow: ai-review-failure attempts:"),
  ) : null;
  const previous = Number.parseInt(failure?.body?.match(/attempts: (\d+)/)?.[1] ?? "0", 10);
  const attempts = Math.min(previous + 1, maxAttempts);
  const body = `<!-- cnmcp-flow: ai-review-failure attempts: ${attempts} -->\n## AI 审核运行失败\n\n自动流程将在后续队列中重试；连续 ${maxAttempts} 次失败后会关闭候选，避免阻塞其他资源。`;
  if (failure) {
    await githubRequest(fetchImpl, token, `/repos/${repository}/issues/comments/${failure.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
  } else {
    await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }
  if (attempts >= maxAttempts) await closeCandidateIssue({ fetchImpl, token, repository, issueNumber });
  return { attempts, quarantined: attempts >= maxAttempts };
}

export async function findReviewComment({ fetchImpl = globalThis.fetch, token, repository, issueNumber, trustedAuthors = [] }) {
  assertRepository(repository);
  const comments = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
  if (!Array.isArray(comments)) return null;
  return comments.find((comment) => trustedComment(comment, trustedAuthors) && typeof comment.body === "string" && comment.body.startsWith(COMMENT_MARKER)) ?? null;
}

export function commentHasFingerprint(comment, fingerprint) {
  return Boolean(comment?.body?.startsWith(`<!-- cnmcp-flow: ai-review fingerprint: ${fingerprint} -->`));
}

export async function hasOpenResourcePullRequest({
  fetchImpl = globalThis.fetch,
  token,
  repository,
  issueNumber,
  resourceId,
  trustedAuthors = [],
}) {
  assertRepository(repository);
  const owner = repository.split("/")[0];
  const branch = `bot/resource/${resourceId}-${issueNumber}`;
  const query = new URLSearchParams({ state: "open", head: `${owner}:${branch}`, base: "main", per_page: "10" });
  const pulls = await githubRequest(fetchImpl, token, `/repos/${repository}/pulls?${query}`);
  if (!Array.isArray(pulls)) throw new Error("GitHub returned an invalid Pull Request list");
  return pulls.some((pull) =>
    pull?.head?.ref === branch &&
    pull?.base?.ref === "main" &&
    trustedComment(pull, trustedAuthors) &&
    typeof pull?.body === "string" &&
    pull.body.includes(`issue: ${issueNumber} resource: ${resourceId} `));
}

export async function upsertReviewComment({ fetchImpl = globalThis.fetch, token, repository, issueNumber, body, trustedAuthors = [] }) {
  assertRepository(repository);
  const comments = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}/comments`);
  const existing = Array.isArray(comments)
    ? comments.find((comment) => trustedComment(comment, trustedAuthors) && typeof comment.body === "string" && comment.body.startsWith(COMMENT_MARKER))
    : null;
  if (existing && existing.body === body) return { action: "unchanged", commentId: existing.id };
  if (existing) {
    await githubRequest(fetchImpl, token, `/repos/${repository}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    return { action: "updated", commentId: existing.id };
  }
  const created = await githubRequest(fetchImpl, token, `/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return { action: "created", commentId: created.id };
}
