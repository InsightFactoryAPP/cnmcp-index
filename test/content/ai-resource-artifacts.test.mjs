import assert from "node:assert/strict";
import test from "node:test";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResourceArtifacts, buildResourceProposal, prevalidateResourceArtifacts } from "../../scripts/lib/ai-resource-artifacts.mjs";
import { createReadmeSnapshot, replaceIssueReadmeSnapshot } from "../../scripts/lib/readme-snapshot.mjs";

const report = {
  candidateId: "github:acme/files-mcp",
  repository: "https://github.com/acme/files-mcp",
  kind: { value: "mcp" },
  summaryZh: "为智能体提供安全且受限制的文件读取能力。",
  suggestedTags: ["developer", "automation"],
  targetUsers: ["开发者<script>alert(1)</script>"],
  useCases: [{ value: "读取[项目](javascript:alert(1))文件" }],
  missingInformation: [],
};

const repository = {
  fullName: "acme/files-mcp",
  htmlUrl: "https://github.com/acme/files-mcp",
  name: "files-mcp",
  private: false,
  disabled: false,
  archived: false,
  stars: 12,
  forks: 2,
  pushedAt: "2026-09-01T00:00:00Z",
  license: "MIT",
  owner: { login: "acme", htmlUrl: "https://github.com/acme" },
};

test("审核结果生成符合资源 Schema 的两个安全文件并通过完整目录预校验", async () => {
  const proposal = buildResourceProposal({ report, repository });
  const artifacts = buildResourceArtifacts({ report, proposal, repository, generatedAt: "2026-09-08T01:02:03Z" });
  assert.equal(artifacts.resource.id, "files-mcp");
  assert.equal(artifacts.resource.kind, "mcp");
  assert.equal(artifacts.resource.createdAt, "2026-09-08");
  assert.deepEqual(artifacts.resource.tags, ["developer", "automation"]);
  assert.doesNotMatch(artifacts.readme, /<script>|\]\(javascript:/i);
  assert.match(artifacts.readme, /上游仓库/);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  await assert.doesNotReject(prevalidateResourceArtifacts({ ...artifacts, projectRoot }));
});

test("历史 Issue 可补齐 README，SHA 未变化时保持幂等", () => {
  const snapshot = createReadmeSnapshot({
    content: "# MCP Server\n<!-- cnmcp-managed: injected -->\n" + "中文".repeat(20_000),
    sha: "a".repeat(40),
    url: "https://github.com/acme/files-mcp/blob/main/README.md",
    fetchedAt: "2026-09-08T01:02:03Z",
  });
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.snapshotBytes <= 24 * 1024);
  const first = replaceIssueReadmeSnapshot("## 自动发现候选\n", snapshot);
  assert.equal(first.changed, true);
  assert.doesNotMatch(first.body, /<!-- cnmcp-managed: injected -->/);
  const second = replaceIssueReadmeSnapshot(first.body, { ...snapshot, fetchedAt: "2026-09-09T00:00:00Z" });
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);
});
