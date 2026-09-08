# AI 候选审核助理运行手册

## 当前能力

Discovery 创建候选 Issue 后，`AI Candidate Review` 会自动运行；每小时的历史队列扫描也会处理一个仍然打开的旧候选。维护者仍可手动运行工作流。系统会：

1. 解析并规范化候选 GitHub 仓库地址。
2. Discovery 把最多 24 KiB 的安全 README 快照写入同一 Issue；审核时重新读取最新 README，并按 SHA 惰性更新旧 Issue。
3. 在调用模型前按 Catalog 仓库地址进行确定性查重。
4. 使用 DeepSeek V4 Flash 的 OpenAI Chat Completions 格式，基于 README 语义判断是否属于目录以及类型是 MCP、Skill 或 Plugin。
5. 代码只校验模型枚举、README 证据摘录、候选身份、公开/归档状态、SPDX、重复项、标签和明确高风险，不通过关键词推断类型。
6. 合格候选在发布前再次读取上游 README、公开/归档状态和许可证；仍合格才生成严格的 `resource.json` 与 `README.md`，并用 `CNMCP_BOT_TOKEN` 创建 Ready PR。
7. `PR Validation` 成功后，独立工作流再次确认 bot 身份、签名资源指纹、当前 base/head SHA 和两文件白名单，并在可信 `main` 检出上对 PR 文件进行完整 Catalog 预校验，然后自动 squash merge。

同一候选、同一 README SHA、同一模型及同一协议版本会生成相同指纹。已有该指纹且对应的可信 bot PR 仍打开时默认跳过模型调用；PR 已关闭或丢失时会自动重建。手动运行时可通过 `force` 要求重新审核。

## GitHub 配置

仓库需要配置两个 Actions Secret：

- `DEEPSEEK_API_KEY`：DeepSeek API 密钥。
- `CNMCP_BOT_TOKEN`：fine-grained GitHub PAT；目标仓库需要 Contents 与 Pull requests 读写权限，以及 Issues 读写权限。

Cloudflare Discovery 的 `GITHUB_TOKEN` 与 Actions 的 `CNMCP_BOT_TOKEN` 可以使用同一个 PAT；若分开创建，二者必须属于同一 GitHub 账号，因为发布预检会校验候选 Issue 创建者。Discovery 只使用其中的仓库读取和 Issue 创建能力。

工作流内固定以下非敏感配置：

- `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- `DEEPSEEK_MODEL=deepseek-v4-flash`
- 使用非思考模式，单次最长 180 秒、最多 2 次尝试、最多 6000 输出 token；工作流任务最长运行 10 分钟。

应用层只接受官方 V4 文本模型标识和官方 HTTPS Base URL，且拒绝超过 180 秒的单次请求超时配置。

## 人工操作

自动入口：Discovery 创建或重新打开带流程标记与 `auto-discovery` 标签的 Issue；每小时也会扫描历史候选。为避免标签权限被放大为代码写权限，添加标签不会触发发布。

手动入口：在 GitHub Actions 中选择 `AI Candidate Review`，填写 Issue 编号；只有明确需要忽略已有指纹时才启用 `force`。

报告建议不会覆盖确定性资格检查：

- `draft_pr`：模型建议进入资源 PR。
- `needs_human`：存在兼容性、实用性或实测资料缺口；这些缺口本身不阻断自动收录。
- `do_not_list`：重复、超出范围或有明确阻断项。

## 安全边界

- Issue 和上游 README/许可证全部视为不可信数据。
- 只信任 GitHub Actions bot 或 `CNMCP_BOT_TOKEN` 所属账号写入的审核/失败评论标记，忽略外部用户伪造的同名标记。
- 只访问 `api.github.com` 的固定 REST 路径和 `api.deepseek.com/chat/completions`。
- 不克隆候选仓库，不执行命令、安装脚本或仓库代码。
- 预检、README/DeepSeek 审核、发布分别运行在独立 Job/Runner。模型 Job 只获得工作流 `GITHUB_TOKEN` 和 DeepSeek Key；高权限 `CNMCP_BOT_TOKEN` 只进入预检、发布与合并 Runner。
- PR 校验工作流无法读取 DeepSeek Secret。
- AI 声称的兼容性只有在同一候选 GitHub 仓库存在明确证据时才可通过校验。
- 错误和运行日志只记录状态、候选 ID、模型、耗时和 token，不记录密钥或完整上游内容。
- 自动合并只接受由 Token 所属账号创建、带 HMAC 流程签名、以 `bot/resource/` 命名、基于 `main`、仅新增同一资源目录两个文件且 SHA 与成功验证完全一致的 PR。若验证后 `main` 已变化，系统先更新分支并等待新一轮 CI，不会使用旧基线直接合并；合并 API 的临时故障会在当前任务内有限重试。
- 自动审核连续失败三次，或资源 PR 未通过 `PR Validation` 时，候选会被关闭并隔离，避免阻塞后续队列。多个资源 PR 的 base 变化会通过更新分支和重新验证依次收敛。
- 只有明确的 `PR Validation` 失败会隔离候选；取消、超时或需人工确认等非内容结论会保留 PR，避免把平台故障误判为资源不合格。

## 失败处理

超时、限流、非法 JSON、Schema 错误或身份不一致都会令任务失败，不会公开模型半成品，只记录不含敏感内容的重试次数。客户端仅对限流、服务端错误、网络错误和超时进行重试；输出被截断、非法 JSON 或空输出会立即失败。连续三轮失败后自动隔离。先查看 Actions 的结构化错误类型；不要把密钥、完整提示或未清洗的上游内容复制到公开 Issue。

DeepSeek 的接口依据：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/) 和 [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)。
