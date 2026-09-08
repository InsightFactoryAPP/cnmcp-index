import assert from "node:assert/strict";
import test from "node:test";

import { preflightCandidate } from "../../scripts/preflight-ai-candidate.mjs";
import { findPendingCandidateIssue, findReviewComment, hasOpenResourcePullRequest, recordCandidateFailure, upsertReviewComment } from "../../scripts/lib/github-ai-review.mjs";

function withEnv(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve().then(action).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const trustedBody = "## 自动发现候选\n\n<!-- cnmcp-flow: auto-discovery -->\n\n### 源码地址\nhttps://github.com/acme/files-mcp";

test("特权预检只接受 Token 所属账号创建的 Discovery Issue", async () => {
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/user") return Response.json({ login: "cnmcp-bot" });
    if (pathname.endsWith("/issues/16")) return Response.json({
      number: 16, state: "open", body: trustedBody, user: { login: "attacker" }, labels: [{ name: "auto-discovery" }],
    });
    throw new Error(`Unexpected ${pathname}`);
  };
  await withEnv({ CNMCP_BOT_TOKEN: "secret", GITHUB_REPOSITORY: "burgleaf/cnmcp-index", AI_REVIEW_ISSUE_NUMBER: "16" }, async () => {
    await assert.rejects(preflightCandidate({ fetchImpl }), /configured Discovery bot/);
  });
});

test("历史扫描分页跳过非 bot Issue 并继续后续候选", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/issues") && parsed.searchParams.get("page") === "1") {
      return Response.json(Array.from({ length: 100 }, (_, index) => ({
        number: index + 1, title: `[自动发现] ${index}`, body: trustedBody, user: { login: "attacker" },
      })));
    }
    if (parsed.pathname.endsWith("/issues") && parsed.searchParams.get("page") === "2") return Response.json([
      { number: 117, title: "[自动发现] trusted", body: trustedBody, user: { login: "cnmcp-bot" } },
    ]);
    throw new Error(`Unexpected ${parsed.pathname}`);
  };
  const number = await findPendingCandidateIssue({
    fetchImpl, token: "secret", repository: "burgleaf/cnmcp-index", expectedAuthor: "cnmcp-bot",
  });
  assert.equal(number, 117);
});

test("旧版 Discovery Issue 由同一 bot 受限升级流程标记", async () => {
  const legacyBody = "## 自动发现候选\n\n### 候选 ID\ngithub:acme/files-mcp\n\n### 源码地址\nhttps://github.com/acme/files-mcp";
  let patchedBody = "";
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/user") return Response.json({ login: "cnmcp-bot" });
    if (pathname.endsWith("/issues/16") && !init.method) return Response.json({
      number: 16, title: "[自动发现] files-mcp", state: "open", body: legacyBody,
      user: { login: "cnmcp-bot" }, labels: [{ name: "auto-discovery" }],
    });
    if (pathname.endsWith("/issues/16") && init.method === "PATCH") {
      patchedBody = JSON.parse(init.body).body;
      return Response.json({ body: patchedBody });
    }
    throw new Error(`Unexpected ${init.method ?? "GET"} ${pathname}`);
  };
  await withEnv({ CNMCP_BOT_TOKEN: "secret", GITHUB_REPOSITORY: "burgleaf/cnmcp-index", AI_REVIEW_ISSUE_NUMBER: "16" }, async () => {
    assert.deepEqual(await preflightCandidate({ fetchImpl }), { issueNumber: 16, botLogin: "cnmcp-bot" });
  });
  assert.match(patchedBody, /cnmcp-flow: auto-discovery/);
});

test("连续三次审核失败后隔离候选以释放队列", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
    if (pathname.endsWith("/issues/16/comments")) return Response.json([
      { id: 8, user: { login: "attacker" }, body: "<!-- cnmcp-flow: ai-review-failure attempts: 99 -->" },
      { id: 9, user: { login: "github-actions[bot]" }, body: "<!-- cnmcp-flow: ai-review-failure attempts: 2 -->" },
    ]);
    return Response.json({});
  };
  const result = await recordCandidateFailure({
    fetchImpl, token: "secret", repository: "burgleaf/cnmcp-index", issueNumber: 16, trustedAuthors: ["github-actions[bot]"],
  });
  assert.deepEqual(result, { attempts: 3, quarantined: true });
  assert.ok(calls.some((call) => call.method === "PATCH" && call.pathname.endsWith("/issues/16")));
});

test("忽略外部用户伪造的审核标记并只更新可信 bot 评论", async () => {
  const calls = [];
  const comments = [
    { id: 7, user: { login: "attacker" }, body: "<!-- cnmcp-flow: ai-review fingerprint: forged -->" },
    { id: 8, user: { login: "cnmcp-bot" }, body: "<!-- cnmcp-flow: ai-review fingerprint: trusted -->" },
  ];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: init.method ?? "GET" });
    if (pathname.endsWith("/issues/16/comments") && !init.method) return Response.json(comments);
    if (pathname.endsWith("/issues/comments/8") && init.method === "PATCH") return Response.json({ id: 8 });
    throw new Error(`Unexpected ${init.method ?? "GET"} ${pathname}`);
  };
  const found = await findReviewComment({
    fetchImpl, token: "secret", repository: "burgleaf/cnmcp-index", issueNumber: 16, trustedAuthors: ["cnmcp-bot"],
  });
  assert.equal(found.id, 8);
  const result = await upsertReviewComment({
    fetchImpl,
    token: "secret",
    repository: "burgleaf/cnmcp-index",
    issueNumber: 16,
    body: "<!-- cnmcp-flow: ai-review fingerprint: updated -->",
    trustedAuthors: ["cnmcp-bot"],
  });
  assert.deepEqual(result, { action: "updated", commentId: 8 });
  assert.equal(calls.some((call) => call.pathname.endsWith("/issues/comments/7") && call.method === "PATCH"), false);
});

test("同指纹仅在可信 bot 的资源 PR 仍打开时视为已处理", async () => {
  const fetchImpl = async () => Response.json([
    {
      user: { login: "attacker" },
      body: "<!-- cnmcp-flow: ai-resource-pr issue: 16 resource: files-mcp base: x -->",
      head: { ref: "bot/resource/files-mcp-16" },
      base: { ref: "main" },
    },
  ]);
  assert.equal(await hasOpenResourcePullRequest({
    fetchImpl,
    token: "secret",
    repository: "burgleaf/cnmcp-index",
    issueNumber: 16,
    resourceId: "files-mcp",
    trustedAuthors: ["cnmcp-bot"],
  }), false);
});
