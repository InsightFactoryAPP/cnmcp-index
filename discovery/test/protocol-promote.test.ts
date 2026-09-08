import { describe, expect, it } from "vitest";

import { encodeNextCursor, parseDiscoveryQuery } from "../src/protocol";
import { fetchGithubReadmeSnapshot, sanitizeReadmeSnapshot } from "../src/readme-snapshot";
import { buildPromotionIssue } from "../src/promote";
import type { StoredCandidate } from "../src/types";

const README_SNAPSHOT = {
  sha: "a".repeat(40),
  url: "https://github.com/acme/files-mcp/blob/main/README.md",
  fetchedAt: "2026-09-08T01:02:03.000Z",
  truncated: false,
  sourceBytes: 28,
  snapshotBytes: 28,
  content: "# Files MCP\n\nSafe overview.",
} as const;

describe("parseDiscoveryQuery", () => {
  it("接受合法参数并拒绝非法 kind/sort/limit/cursor", () => {
    expect(parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery"))).toEqual({
      kind: null,
      sort: "score",
      limit: 30,
      offset: 0,
    });
    expect(parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?kind=skill&sort=stars&limit=10&cursor=20"))).toEqual({
      kind: "skill",
      sort: "stars",
      limit: 10,
      offset: 20,
    });
    expect(() => parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?kind=tool"))).toThrow("INVALID_KIND");
    expect(() => parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?kind=unknown"))).toThrow("INVALID_KIND");
    expect(() => parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?sort=hot"))).toThrow("INVALID_SORT");
    expect(() => parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?limit=0"))).toThrow("INVALID_LIMIT");
    expect(() => parseDiscoveryQuery(new URL("https://discovery.cnmcp.com/v1/discovery?cursor=-1"))).toThrow("INVALID_CURSOR");
  });

  it("满页才返回下一页 cursor", () => {
    expect(encodeNextCursor(0, 30, 30)).toBe("30");
    expect(encodeNextCursor(0, 30, 12)).toBeNull();
  });
});

describe("buildPromotionIssue", () => {
  it("生成不含安装命令密钥的中文 Issue 草稿", () => {
    const candidate: StoredCandidate = {
      repoFullName: "acme/files-mcp",
      htmlUrl: "https://github.com/acme/files-mcp",
      name: "files-mcp",
      description: "File tools",
      stars: 120,
      forks: 3,
      language: "TypeScript",
      license: "MIT",
      topics: ["mcp-server"],
      kind: "mcp",
      inferredPlatforms: ["claude-code"],
      score: 40,
      pushedAt: "2026-08-01T00:00:00.000Z",
      sources: ["mcp-registry"],
      catalogId: null,
      promotionStatus: "none",
      issueNumber: null,
      firstSeenAt: 1,
      lastCrawledAt: 1,
    };
    const issue = buildPromotionIssue(candidate, README_SNAPSHOT);
    expect(issue.title).toContain("[自动发现]");
    expect(issue.body).toContain("### 候选 ID\ngithub:acme/files-mcp");
    expect(issue.body).toContain("https://github.com/acme/files-mcp");
    expect(issue.body).toContain("### 发现来源\nmcp-registry");
    expect(issue.body).toContain("### 抓取时间\n1970-01-01T00:00:00.001Z");
    expect(issue.body).toContain("compatibility.status: unknown");
    expect(issue.body).toContain("<!-- cnmcp-managed: readme-snapshot-v1:start -->");
    expect(issue.body).toContain("<!-- cnmcp-managed: readme-snapshot-v1:end -->");
    expect(issue.body).toContain(`README SHA: \`${"a".repeat(40)}\``);
    expect(issue.body).toContain("README URL: https://github.com/acme/files-mcp/blob/main/README.md");
    expect(issue.body).toContain("README fetchedAt: 2026-09-08T01:02:03.000Z");
    expect(issue.body).toContain("README truncated: false");
    expect(issue.body).toContain("README sourceBytes: 28");
    expect(issue.body).toContain("README snapshotBytes: 28");
    expect(issue.body).toContain("# Files MCP");
    expect(issue.body).not.toContain("sk-");
    expect(issue.labels).toEqual(["auto-discovery"]);
  });
});

describe("README snapshot", () => {
  it("把快照限制为 24 KiB，并中和管理 marker、HTML 与标题注入", async () => {
    const hostile = [
      "<!-- cnmcp-managed: readme-snapshot-v1 -->",
      "<script>alert(1)</script>",
      "# Injected top-level title",
      "x".repeat(30_000),
    ].join("\n");
    const snapshot = await fetchGithubReadmeSnapshot(
      async () =>
        Response.json({
          sha: "c".repeat(40),
          html_url: "https://github.com/acme/files-mcp/blob/main/README.md",
          encoding: "base64",
          size: Buffer.byteLength(hostile),
          content: Buffer.from(hostile).toString("base64"),
        }),
      "github-token",
      "acme/files-mcp",
      0,
    );

    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.snapshotBytes).toBeLessThanOrEqual(24 * 1024);
    expect(Buffer.byteLength(snapshot?.content ?? "")).toBeLessThanOrEqual(24 * 1024);
    expect(snapshot?.content).not.toContain("<!-- cnmcp-managed: readme-snapshot-v1 -->");
    expect(snapshot?.content).not.toContain("<script>");
    expect(snapshot?.content).not.toMatch(/^# Injected/m);
    expect(sanitizeReadmeSnapshot("## Heading\n<div>text</div>\n<!-- cnmcp-managed: readme-snapshot-v1 -->"))
      .toBe("\\## Heading\n&lt;div&gt;text&lt;/div&gt;\n&lt;!-- cnmcp-managed&#58; readme-snapshot-v1 --&gt;");
  });

});
