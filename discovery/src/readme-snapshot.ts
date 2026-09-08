import { GITHUB_API, githubHeaders } from "./github";
import type { FetchLike } from "./sources/mcp-registry";

export const README_SNAPSHOT_MAX_BYTES = 24 * 1024;
const MAX_BASE64_PAYLOAD_CHARS = 2 * 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;

export type GithubReadmeSnapshot = Readonly<{
  sha: string;
  url: string;
  fetchedAt: string;
  truncated: boolean;
  sourceBytes: number;
  snapshotBytes: number;
  content: string;
}>;

type GithubReadmePayload = Readonly<{
  sha?: unknown;
  html_url?: unknown;
  encoding?: unknown;
  content?: unknown;
}>;

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function readGithubReadmeUrl(value: unknown, repoFullName: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expectedPrefix = `/${repoFullName.toLowerCase()}/blob/`;
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    if (!url.pathname.toLowerCase().startsWith(expectedPrefix)) return null;
    if (url.username || url.password || url.search) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeReadmeSnapshot(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  let withoutControls = "";
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) continue;
    withoutControls += character;
  }
  return withoutControls
    .replace(/cnmcp-managed:/gi, "cnmcp-managed&#58;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/^([ \t]{0,3})(#{1,6})(?=\s|$)/gm, "$1\\$2");
}

function truncateUtf8(value: string, maxBytes: number): { content: string; bytes: number; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return { content: value, bytes: encoded.byteLength, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const content = new TextDecoder("utf-8").decode(encoded.subarray(0, end));
  return { content, bytes: encoder.encode(content).byteLength, truncated: true };
}

export async function fetchGithubReadmeSnapshot(
  fetchImpl: FetchLike,
  token: string,
  repoFullName: string,
  now: number,
): Promise<GithubReadmeSnapshot | null> {
  if (!REPOSITORY_PATTERN.test(repoFullName) || !token.trim() || !Number.isFinite(now)) return null;
  try {
    const response = await fetchImpl(`${GITHUB_API}/repos/${repoFullName}/readme`, {
      headers: githubHeaders(token),
      redirect: "error",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as GithubReadmePayload;
    if (
      typeof payload.sha !== "string" ||
      !SHA_PATTERN.test(payload.sha) ||
      payload.encoding !== "base64" ||
      typeof payload.content !== "string" ||
      payload.content.length > MAX_BASE64_PAYLOAD_CHARS
    ) return null;
    const url = readGithubReadmeUrl(payload.html_url, repoFullName);
    const source = decodeBase64(payload.content);
    if (!url || !source || source.byteLength === 0) return null;
    const sanitized = sanitizeReadmeSnapshot(new TextDecoder("utf-8").decode(source));
    const snapshot = truncateUtf8(sanitized, README_SNAPSHOT_MAX_BYTES);
    return {
      sha: payload.sha.toLowerCase(),
      url,
      fetchedAt: new Date(now).toISOString(),
      truncated: snapshot.truncated,
      sourceBytes: source.byteLength,
      snapshotBytes: snapshot.bytes,
      content: snapshot.content,
    };
  } catch {
    return null;
  }
}
