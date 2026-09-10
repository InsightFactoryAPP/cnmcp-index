# mempalace

MemPalace 是一个本地优先的 AI 记忆系统,把对话历史原文存储并按语义检索,提供可插拔向量后端、知识图谱、自动保存钩子,并暴露 45 个 MCP 工具供编码智能体读写记忆。

## 适用人群

- 使用 Claude Code、Codex CLI、Cursor 等编码智能体的开发者
- 需要长期跨会话记忆与检索的 AI 工具用户
- 关注本地优先与隐私的软件工程团队

## 主要能力

- 通过 MCP 服务器为编码智能体提供本地记忆读写与知识图谱操作
- 挖掘并语义检索本地项目文件与 Claude Code 会话记录
- 使用自动保存钩子在上下文压缩前保留 Claude Code、Codex CLI、Cursor 的会话内容

## 使用说明

- README 未给出全部平台兼容性矩阵,Docker/GPU 与 Termux 支持情况需人工核验
- MCP 客户端兼容性与 45 个工具的完整清单仅链接外部站点,需人工核验

## 来源

- [上游仓库](https://github.com/mempalace/mempalace)
- 本条目由 AI 根据上游 README 生成，未执行候选仓库中的代码或安装命令。
