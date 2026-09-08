import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { validateResourceProposal } from "./ai-resource-qualification.mjs";
import { validateCatalog } from "../validate-resources.mjs";

const require = createRequire(import.meta.url);
const resourceSchema = require("../../schemas/resource.schema.json");
const validateResourceSchema = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(resourceSchema);

function safeLine(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#!|>])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function repositoryName(repository) {
  return new URL(repository).pathname.split("/").filter(Boolean).at(-1) ?? "resource";
}

export function resourceIdFromRepository(repository) {
  const id = repositoryName(repository)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length < 3) throw new Error("Repository name cannot produce a valid resource id");
  return id;
}

export function buildResourceProposal({ report, repository }) {
  return validateResourceProposal({
    schemaVersion: 1,
    candidateId: report.candidateId,
    repository: report.repository,
    id: resourceIdFromRepository(report.repository),
    name: String(repository.name || repository.fullName?.split("/").at(-1) || "").slice(0, 120),
    summary: report.summaryZh,
    tags: report.suggestedTags,
    targetUsers: report.targetUsers,
    capabilities: report.useCases.map((item) => item.value),
    usageNotes: report.missingInformation,
  });
}

export function buildResourceArtifacts({ report, proposal, repository, generatedAt }) {
  validateResourceProposal(proposal);
  const date = new Date(generatedAt).toISOString().slice(0, 10);
  const authorName = String(repository.owner?.login || repository.fullName?.split("/")[0] || "").slice(0, 120);
  const authorUrl = repository.owner?.htmlUrl || `https://github.com/${encodeURIComponent(authorName)}`;
  const resource = {
    schemaVersion: 1,
    id: proposal.id,
    kind: report.kind.value,
    name: proposal.name,
    summary: proposal.summary,
    repository: proposal.repository,
    license: repository.license,
    author: { name: authorName, url: authorUrl },
    tags: proposal.tags,
    createdAt: date,
    visibility: "public",
  };
  if (!validateResourceSchema(resource)) {
    const detail = (validateResourceSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`Generated resource does not match resource schema: ${detail}`);
  }
  const section = (title, items, fallback) => [
    `## ${title}`,
    "",
    ...(items.length ? items.map((item) => `- ${safeLine(item)}`) : [`- ${fallback}`]),
    "",
  ];
  const readme = [
    `# ${safeLine(proposal.name)}`,
    "",
    safeLine(proposal.summary),
    "",
    ...section("适用人群", proposal.targetUsers, "请参考上游说明。"),
    ...section("主要能力", proposal.capabilities, "请参考上游说明。"),
    ...section("使用说明", proposal.usageNotes, "安装和配置方式请以上游 README 为准。"),
    "## 来源",
    "",
    `- [上游仓库](${proposal.repository})`,
    "- 本条目由 AI 根据上游 README 生成，未执行候选仓库中的代码或安装命令。",
    "",
  ].join("\n");
  return { resource, readme };
}

export async function prevalidateResourceArtifacts({ resource, readme, projectRoot }) {
  const root = path.resolve(projectRoot);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cnmcp-resource-validation-"));
  const resourcesDirectory = path.join(temporaryRoot, "resources");
  try {
    await cp(path.join(root, "resources"), resourcesDirectory, { recursive: true });
    const resourceDirectory = path.join(resourcesDirectory, resource.id);
    await mkdir(resourceDirectory);
    await Promise.all([
      writeFile(path.join(resourceDirectory, "resource.json"), `${JSON.stringify(resource, null, 2)}\n`, "utf8"),
      writeFile(path.join(resourceDirectory, "README.md"), readme, "utf8"),
    ]);
    await validateCatalog({
      projectRoot: root,
      resourcesDirectory,
      platformRegistryPath: path.join(root, "catalog", "platforms.json"),
      tagRegistryPath: path.join(root, "catalog", "tags.json"),
    });
    return { valid: true };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
