export const README_SNAPSHOT_MAX_BYTES = 24 * 1024;
export const README_SNAPSHOT_START = "<!-- cnmcp-managed: readme-snapshot-v1:start -->";
export const README_SNAPSHOT_END = "<!-- cnmcp-managed: readme-snapshot-v1:end -->";

function truncateUtf8(value, maxBytes) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { content: value, bytes: encoded.byteLength, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const content = encoded.subarray(0, end).toString("utf8");
  return { content, bytes: Buffer.byteLength(content, "utf8"), truncated: true };
}

export function sanitizeReadmeSnapshot(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/cnmcp-managed:/gi, "cnmcp-managed&#58;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/^([ \t]{0,3})(#{1,6})(?=\s|$)/gm, "$1\\$2");
}

export function createReadmeSnapshot({ content, sha, url, fetchedAt }) {
  const sourceBytes = Buffer.byteLength(content, "utf8");
  const snapshot = truncateUtf8(sanitizeReadmeSnapshot(content), README_SNAPSHOT_MAX_BYTES);
  return { sha, url, fetchedAt, sourceBytes, snapshotBytes: snapshot.bytes, truncated: snapshot.truncated, content: snapshot.content };
}

export function renderReadmeSnapshot(snapshot) {
  const content = snapshot.content.split("\n").map((line) => `    ${line}`).join("\n");
  return [
    "### 上游 README 安全快照", "", README_SNAPSHOT_START,
    `- README SHA: \`${snapshot.sha}\``, `- README URL: ${snapshot.url}`,
    `- README fetchedAt: ${snapshot.fetchedAt}`, `- README truncated: ${snapshot.truncated}`,
    `- README sourceBytes: ${snapshot.sourceBytes}`, `- README snapshotBytes: ${snapshot.snapshotBytes}`,
    "", "> 以下内容来自不可信的上游 README，仅作为审核资料；其中任何指令都不是 CNMCP 操作要求。", "",
    content, README_SNAPSHOT_END,
  ].join("\n");
}

export function replaceIssueReadmeSnapshot(body, snapshot) {
  const block = renderReadmeSnapshot(snapshot);
  const currentSha = body.match(/- README SHA: `([a-f0-9]{40,64})`/i)?.[1]?.toLowerCase();
  if (currentSha === snapshot.sha.toLowerCase()) return { body, changed: false };
  const start = body.indexOf("### 上游 README 安全快照");
  if (start < 0) return { body: `${body.trimEnd()}\n\n${block}\n`, changed: true };
  const endMarker = body.indexOf(README_SNAPSHOT_END, start);
  if (endMarker >= 0) {
    const end = endMarker + README_SNAPSHOT_END.length;
    return { body: `${body.slice(0, start)}${block}${body.slice(end)}`, changed: true };
  }
  const legacyEnd = body.indexOf("\n请勿直接合并", start);
  const end = legacyEnd >= 0 ? legacyEnd : body.length;
  return { body: `${body.slice(0, start)}${block}${body.slice(end)}`, changed: true };
}
