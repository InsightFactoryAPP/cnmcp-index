import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  buildResourceBranchName,
  createResourcePullRequest,
  parseResourcePrMarker,
} from "../../scripts/lib/github-resource-pr.mjs";

const SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const ARTIFACT_SHA = "e".repeat(64);
function signature(issueNumber, resourceId, baseSha, headSha, artifactSha) {
  return createHmac("sha256", "bot-secret").update([issueNumber, resourceId, baseSha, headSha, artifactSha].join("\n")).digest("hex");
}

function json(payload, status = 200) {
  return Response.json(payload, { status });
}

test("Git Data API 以单个 commit 原子发布两个资源文件并创建 Ready PR", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body, headers: init.headers });
    if (parsed.pathname.endsWith("/pulls") && method === "GET") return json([]);
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: SHA } });
    if (parsed.pathname.endsWith(`/git/commits/${SHA}`)) return json({ sha: SHA, tree: { sha: TREE_SHA } });
    if (parsed.pathname.endsWith("/git/ref/heads/bot/resource/files-mcp-16")) return json({}, 404);
    if (parsed.pathname.endsWith("/git/trees") && method === "POST") return json({ sha: "d".repeat(40) }, 201);
    if (parsed.pathname.endsWith("/git/commits") && method === "POST") return json({ sha: COMMIT_SHA }, 201);
    if (parsed.pathname.endsWith("/git/refs") && method === "POST") return json({ ref: "refs/heads/bot/resource/files-mcp-16" }, 201);
    if (parsed.pathname.endsWith("/pulls") && method === "POST") {
      return json({ number: 27, html_url: "https://github.com/burgleaf/cnmcp-index/pull/27", body: body.body }, 201);
    }
    throw new Error(`Unexpected ${method} ${parsed.pathname}${parsed.search}`);
  };

  const result = await createResourcePullRequest({
    fetchImpl,
    token: "bot-secret",
    repository: "burgleaf/cnmcp-index",
    issueNumber: 16,
    resource: {
      schemaVersion: 1,
      id: "files-mcp",
      kind: "mcp",
      name: "Files MCP",
      summary: "为智能体提供受限文件访问能力。",
      repository: "https://github.com/acme/files-mcp",
      license: "MIT",
      author: { name: "acme" },
      tags: ["filesystem"],
    },
    readme: "# Files MCP\n\n资源说明。\n",
  });

  assert.deepEqual(result, {
    action: "created",
    branch: "bot/resource/files-mcp-16",
    headSha: COMMIT_SHA,
    pullNumber: 27,
    pullUrl: "https://github.com/burgleaf/cnmcp-index/pull/27",
  });
  const treeCall = calls.find((call) => call.path.endsWith("/git/trees"));
  assert.equal(treeCall.body.base_tree, TREE_SHA);
  assert.deepEqual(treeCall.body.tree.map(({ path, mode, type }) => ({ path, mode, type })), [
    { path: "resources/files-mcp/resource.json", mode: "100644", type: "blob" },
    { path: "resources/files-mcp/README.md", mode: "100644", type: "blob" },
  ]);
  assert.equal(JSON.parse(treeCall.body.tree[0].content).id, "files-mcp");
  const commitCall = calls.find((call) => call.path.endsWith("/git/commits") && call.method === "POST");
  assert.deepEqual(commitCall.body.parents, [SHA]);
  const refCall = calls.find((call) => call.path.endsWith("/git/refs"));
  assert.deepEqual(refCall.body, { ref: "refs/heads/bot/resource/files-mcp-16", sha: COMMIT_SHA });
  const pullCall = calls.find((call) => call.path.endsWith("/pulls") && call.method === "POST");
  assert.equal(pullCall.body.base, "main");
  assert.equal(pullCall.body.head, "bot/resource/files-mcp-16");
  assert.equal(pullCall.body.draft, false);
  assert.match(pullCall.body.body, new RegExp(`head: ${COMMIT_SHA}`));
  assert.equal(calls.every((call) => call.headers.Authorization === "Bearer bot-secret"), true);
});

test("已有同一自动 PR 时幂等复用且不写 Git 对象", async () => {
  const calls = [];
  const resource = { id: "files-mcp" };
  const resourceContent = `${JSON.stringify(resource, null, 2)}\n`;
  const normalizedReadme = "# Files MCP\n";
  const actualArtifactSha = createHash("sha256").update(resourceContent).update("\0").update(normalizedReadme).digest("hex");
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url, method: init.method ?? "GET" });
    if (parsed.pathname.endsWith("/pulls")) return json([
      {
        number: 27,
        html_url: "https://github.com/burgleaf/cnmcp-index/pull/27",
        head: { ref: "bot/resource/files-mcp-16", sha: COMMIT_SHA, repo: { full_name: "burgleaf/cnmcp-index" } },
        base: { ref: "main" },
        body: `<!-- cnmcp-flow: ai-resource-pr issue: 16 resource: files-mcp base: ${SHA} head: ${COMMIT_SHA} artifact: ${actualArtifactSha} signature: ${signature(16, "files-mcp", SHA, COMMIT_SHA, actualArtifactSha)} -->`,
      },
    ]);
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: SHA } });
    if (parsed.pathname.endsWith(`/git/commits/${SHA}`)) return json({ tree: { sha: TREE_SHA } });
    throw new Error(`Unexpected ${parsed.pathname}`);
  };
  const result = await createResourcePullRequest({
    fetchImpl,
    token: "bot-secret",
    repository: "burgleaf/cnmcp-index",
    issueNumber: 16,
    resource,
    readme: "# Files MCP",
  });
  assert.equal(result.action, "existing");
  assert.equal(result.pullNumber, 27);
  assert.equal(calls.length, 3);
});

test("README 变化时以最新 main 单提交更新既有自动 PR", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ path: parsed.pathname, method, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname.endsWith("/pulls") && method === "GET") return json([{
      number: 27,
      html_url: "https://github.com/burgleaf/cnmcp-index/pull/27",
      head: { ref: "bot/resource/files-mcp-16", sha: COMMIT_SHA, repo: { full_name: "burgleaf/cnmcp-index" } },
      base: { ref: "main" },
      body: `<!-- cnmcp-flow: ai-resource-pr issue: 16 resource: files-mcp base: ${SHA} head: ${COMMIT_SHA} artifact: ${ARTIFACT_SHA} signature: ${signature(16, "files-mcp", SHA, COMMIT_SHA, ARTIFACT_SHA)} -->`,
    }]);
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: SHA } });
    if (parsed.pathname.endsWith(`/git/commits/${SHA}`)) return json({ tree: { sha: TREE_SHA } });
    if (parsed.pathname.endsWith("/git/trees")) return json({ sha: "d".repeat(40) });
    if (parsed.pathname.endsWith("/git/commits") && method === "POST") return json({ sha: "f".repeat(40) });
    if (parsed.pathname.endsWith("/git/refs/heads/bot/resource/files-mcp-16")) return json({ object: { sha: "f".repeat(40) } });
    if (parsed.pathname.endsWith("/pulls/27") && method === "PATCH") return json({ number: 27, html_url: "https://github.com/burgleaf/cnmcp-index/pull/27" });
    throw new Error(`Unexpected ${method} ${parsed.pathname}`);
  };
  const result = await createResourcePullRequest({
    fetchImpl, token: "bot-secret", repository: "burgleaf/cnmcp-index", issueNumber: 16,
    resource: { id: "files-mcp", repository: "https://github.com/acme/files-mcp", kind: "mcp", author: { name: "acme" } },
    readme: "# changed",
  });
  assert.equal(result.action, "updated");
  assert.ok(calls.some((call) => call.method === "PATCH" && call.path.includes("/git/refs/heads/")));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/pulls/27")));
});

test("资源 PR 输入只能指向 main 与规范化资源目录", async () => {
  assert.equal(buildResourceBranchName("files-mcp", 16), "bot/resource/files-mcp-16");
  assert.deepEqual(
    parseResourcePrMarker(`before\n<!-- cnmcp-flow: ai-resource-pr issue: 16 resource: files-mcp base: ${SHA} head: ${COMMIT_SHA} artifact: ${ARTIFACT_SHA} signature: ${signature(16, "files-mcp", SHA, COMMIT_SHA, ARTIFACT_SHA)} -->\nafter`),
    { issueNumber: 16, resourceId: "files-mcp", baseSha: SHA, headSha: COMMIT_SHA, artifactSha: ARTIFACT_SHA, signature: signature(16, "files-mcp", SHA, COMMIT_SHA, ARTIFACT_SHA) },
  );
  const common = {
    fetchImpl: async () => {
      throw new Error("must not call network");
    },
    token: "bot-secret",
    repository: "burgleaf/cnmcp-index",
    issueNumber: 16,
    readme: "# README",
  };
  await assert.rejects(
    createResourcePullRequest({ ...common, resource: { id: "../workflow" } }),
    /resource id/i,
  );
  await assert.rejects(
    createResourcePullRequest({ ...common, resource: { id: "files-mcp" }, baseBranch: "release" }),
    /base branch/i,
  );
  await assert.rejects(
    createResourcePullRequest({ ...common, resource: { id: "files-mcp" }, readme: "" }),
    /README/i,
  );
});
