# headroom

Headroom 是一个上下文压缩层,用于在工具输出、日志、文件、RAG 分块和对话历史到达 LLM 之前对其进行压缩,从而显著减少 token 消耗,同时保持答案质量。它提供库、代理、MCP 服务器和跨代理内存等功能,支持通过 wrap 命令集成多种 AI 编码工具。

## 适用人群

- 开发者
- AI代理用户
- 使用编码工具的团队

## 主要能力

- 通过 headroom wrap 命令为 Claude Code、Codex、Cursor 等 AI 编码工具启用上下文压缩,减少 token 消耗。

## 使用说明

- 需要人工验证 Headroom 与具体代理的兼容性细节,特别是手动配置的代理如 Cursor。

## 来源

- [上游仓库](https://github.com/headroomlabs-ai/headroom)
- 本条目由 AI 根据上游 README 生成，未执行候选仓库中的代码或安装命令。
