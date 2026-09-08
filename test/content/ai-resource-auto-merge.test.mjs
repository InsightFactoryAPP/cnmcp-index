import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { autoMergeResourcePullRequest } from "../../scripts/lib/github-auto-merge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HEAD_SHA = "c".repeat(40);
const BASE_SHA = "b".repeat(40);
const RESOURCE_CONTENT = '{"id":"files-mcp"}\n';
const README_CONTENT = "# Files MCP\n";
const ARTIFACT_SHA = createHash("sha256").update(RESOURCE_CONTENT).update("\0").update(README_CONTENT).digest("hex");
const SIGNATURE = createHmac("sha256", "bot-secret").update([16, "files-mcp", BASE_SHA, HEAD_SHA, ARTIFACT_SHA].join("\n")).digest("hex");
const MARKER = `<!-- cnmcp-flow: ai-resource-pr issue: 16 resource: files-mcp base: ${BASE_SHA} head: ${HEAD_SHA} artifact: ${ARTIFACT_SHA} signature: ${SIGNATURE} -->`;

function json(payload, status = 200) {
  return Response.json(payload, { status });
}

function validPull(overrides = {}) {
  return {
    number: 27,
    state: "open",
    draft: false,
    user: { login: "cnmcp-bot" },
    body: `${MARKER}\n\nCloses #16`,
    base: { ref: "main" },
    head: { ref: "bot/resource/files-mcp-16", sha: HEAD_SHA, repo: { full_name: "burgleaf/cnmcp-index" } },
    ...overrides,
  };
}

function mergeFetch({ pull = validPull(), files, commits, mainSha = BASE_SHA } = {}) {
  const calls = [];
  let pullReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: parsed.pathname, method, body });
    if (parsed.pathname === "/user") return json({ login: "cnmcp-bot" });
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: mainSha } });
    if (parsed.pathname.endsWith("/pulls/27") && method === "GET") {
      pullReads += 1;
      return json(pull);
    }
    if (parsed.pathname.endsWith("/pulls/27/files")) {
      return json(files ?? [
        { filename: "resources/files-mcp/README.md", status: "added" },
        { filename: "resources/files-mcp/resource.json", status: "added" },
      ]);
    }
    if (parsed.pathname.endsWith("/pulls/27/commits")) return json(commits ?? [{ sha: HEAD_SHA }]);
    if (parsed.pathname.includes("/contents/resources/files-mcp/resource.json")) return json({ encoding: "base64", content: Buffer.from(RESOURCE_CONTENT).toString("base64") });
    if (parsed.pathname.includes("/contents/resources/files-mcp/README.md")) return json({ encoding: "base64", content: Buffer.from(README_CONTENT).toString("base64") });
    if (parsed.pathname.endsWith("/pulls/27/merge") && method === "PUT") return json({ merged: true, sha: "d".repeat(40) });
    throw new Error(`Unexpected ${method} ${parsed.pathname}`);
  };
  return { calls, fetchImpl, get pullReads() { return pullReads; } };
}

test("仅在验证成功、当前 SHA 和两文件范围完全匹配时 squash merge", async () => {
  const mock = mergeFetch();
  let validated = false;
  const result = await autoMergeResourcePullRequest({
    fetchImpl: mock.fetchImpl,
    token: "bot-secret",
    repository: "burgleaf/cnmcp-index",
    pullNumber: 27,
    workflowConclusion: "success",
    workflowEvent: "pull_request",
    validatedHeadSha: HEAD_SHA,
    validatedBaseSha: BASE_SHA,
    trustedMainSha: BASE_SHA,
    validateArtifacts: async ({ resource, readme }) => {
      validated = true;
      assert.deepEqual(resource, { id: "files-mcp" });
      assert.equal(readme, README_CONTENT);
    },
  });
  assert.deepEqual(result, { action: "merged", pullNumber: 27, mergeSha: "d".repeat(40) });
  assert.equal(mock.pullReads, 2);
  const merge = mock.calls.find((call) => call.path.endsWith("/merge"));
  assert.deepEqual(merge.body, { merge_method: "squash", sha: HEAD_SHA });
  assert.equal(validated, true);
});

test("额外文件、非 bot 作者、非当前 SHA 或非成功验证均 fail closed", async (t) => {
  const cases = [
    {
      name: "额外文件",
      options: { files: [
        { filename: "resources/files-mcp/README.md", status: "added" },
        { filename: "resources/files-mcp/resource.json", status: "added" },
        { filename: ".github/workflows/backdoor.yml", status: "added" },
      ] },
      expected: /exactly two allowed files/i,
    },
    { name: "非 bot 作者", options: { pull: validPull({ user: { login: "attacker" } }) }, expected: /token owner/i },
    { name: "SHA 不一致", options: {}, input: { validatedHeadSha: "e".repeat(40) }, expected: /validated head SHA/i },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const mock = mergeFetch(item.options);
      await assert.rejects(
        autoMergeResourcePullRequest({
          fetchImpl: mock.fetchImpl,
          token: "bot-secret",
          repository: "burgleaf/cnmcp-index",
          pullNumber: 27,
          workflowConclusion: "success",
          workflowEvent: "pull_request",
          validatedHeadSha: HEAD_SHA,
          validatedBaseSha: BASE_SHA,
          trustedMainSha: BASE_SHA,
          ...item.input,
        }),
        item.expected,
      );
      assert.equal(mock.calls.some((call) => call.path.endsWith("/merge")), false);
    });
  }
});

test("PR Validation 失败时关闭 PR 和 Issue 并释放队列", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ path: parsed.pathname, method });
    if (parsed.pathname === "/user") return json({ login: "cnmcp-bot" });
    if (parsed.pathname.endsWith("/pulls/27") && method === "GET") return json(validPull());
    if (method === "PATCH" || method === "POST") return json({ state: "closed" });
    throw new Error(`Unexpected ${method} ${parsed.pathname}`);
  };
  const result = await autoMergeResourcePullRequest({
    fetchImpl, token: "bot-secret", repository: "burgleaf/cnmcp-index", pullNumber: 27,
    workflowConclusion: "failure", workflowEvent: "pull_request", validatedHeadSha: HEAD_SHA, validatedBaseSha: BASE_SHA,
    trustedMainSha: BASE_SHA,
  });
  assert.deepEqual(result, { action: "quarantined", pullNumber: 27, issueNumber: 16 });
  assert.ok(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/pulls/27")));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/issues/16")));
});

test("取消或超时的验证不会错误隔离候选", async () => {
  const mock = mergeFetch();
  const result = await autoMergeResourcePullRequest({
    fetchImpl: mock.fetchImpl,
    token: "bot-secret",
    repository: "burgleaf/cnmcp-index",
    pullNumber: 27,
    workflowConclusion: "timed_out",
    workflowEvent: "pull_request",
    validatedHeadSha: HEAD_SHA,
    validatedBaseSha: BASE_SHA,
    trustedMainSha: BASE_SHA,
  });
  assert.deepEqual(result, { action: "deferred", pullNumber: 27, issueNumber: 16, conclusion: "timed_out" });
  assert.equal(mock.calls.some((call) => call.method === "PATCH"), false);
});

test("main 在验证后变化时自动更新分支并等待下一轮 CI", async () => {
  const newBase = "f".repeat(40);
  const newHead = "e".repeat(40);
  let pullReads = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ path: parsed.pathname, method, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname === "/user") return json({ login: "cnmcp-bot" });
    if (parsed.pathname.endsWith("/pulls/27") && method === "GET") {
      pullReads += 1;
      return json(pullReads === 1 ? validPull() : validPull({ head: { ...validPull().head, sha: newHead } }));
    }
    if (parsed.pathname.endsWith("/pulls/27/files")) return json([
      { filename: "resources/files-mcp/README.md", status: "added" },
      { filename: "resources/files-mcp/resource.json", status: "added" },
    ]);
    if (parsed.pathname.endsWith("/pulls/27/commits")) return json([{ sha: HEAD_SHA }]);
    if (parsed.pathname.includes("/contents/resources/files-mcp/resource.json")) return json({ encoding: "base64", content: Buffer.from(RESOURCE_CONTENT).toString("base64") });
    if (parsed.pathname.includes("/contents/resources/files-mcp/README.md")) return json({ encoding: "base64", content: Buffer.from(README_CONTENT).toString("base64") });
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: newBase } });
    if (parsed.pathname.endsWith("/pulls/27/update-branch")) return json({ message: "Updating pull request branch." }, 202);
    if (parsed.pathname.endsWith("/pulls/27") && method === "PATCH") return json({ number: 27 });
    throw new Error(`Unexpected ${method} ${parsed.pathname}`);
  };
  const result = await autoMergeResourcePullRequest({
    fetchImpl, token: "bot-secret", repository: "burgleaf/cnmcp-index", pullNumber: 27,
    workflowConclusion: "success", workflowEvent: "pull_request", validatedHeadSha: HEAD_SHA,
    validatedBaseSha: BASE_SHA, trustedMainSha: newBase, sleep: async () => undefined,
  });
  assert.deepEqual(result, { action: "updated", pullNumber: 27, headSha: newHead });
  assert.ok(calls.some((call) => call.path.endsWith("/update-branch")));
  assert.equal(calls.some((call) => call.path.endsWith("/merge")), false);
});

test("自动合并 workflow 消费 PR Validation 结果且不执行 PR 代码", async () => {
  const source = await readFile(path.join(ROOT, ".github/workflows/ai-resource-auto-merge.yml"), "utf8");
  const workflow = yaml.load(source);
  assert.deepEqual(workflow.on.workflow_run.workflows, ["PR Validation"]);
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(workflow.jobs.merge.if, /conclusion == 'success'/);
  assert.match(workflow.jobs.merge.if, /event == 'pull_request'/);
  assert.match(source, /secrets\.CNMCP_BOT_TOKEN/);
  assert.match(source, /workflow_run\.pull_requests\[0\]\.head\.sha/);
  assert.match(source, /workflow_run\.pull_requests\[0\]\.base\.sha/);
  assert.match(source, /AUTO_MERGE_TRUSTED_MAIN_SHA/);
  assert.match(source, /git rev-parse HEAD/);
  assert.doesNotMatch(source, /AUTO_MERGE_HEAD_SHA:\s*\$\{\{ github\.event\.workflow_run\.head_sha/);
  assert.doesNotMatch(source, /DEEPSEEK_API_KEY|pull_request_target|ref:\s*\$\{\{ github\.event\.workflow_run\.head/);
  const checkout = workflow.jobs.merge.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "main");
  assert.equal(checkout.with["persist-credentials"], false);
  for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(match[1], /^[^@]+@[a-f0-9]{40}$/);
});
