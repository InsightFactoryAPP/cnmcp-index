# context7

Context7 为 LLM 与 AI 代码编辑器提供最新、与版本对应的代码文档和示例,可直接注入提示上下文,减少过时回答与不存在的 API 幻觉。它支持两种接入方式:通过 ctx7 CLI 安装引导 agent 获取文档的 skill,或注册 Context7 MCP 服务器让 agent 原生调用文档工具。

## 适用人群

- 使用 AI 代码编辑器与编码代理的开发者
- 需要为 LLM 提供最新库文档的工程团队

## 主要能力

- 让 AI 编码助手获取最新的、与版本对应的库文档与代码示例,避免依赖过时训练数据
- 通过 MCP 工具\(resolve-library-id、query-docs\)让 agent 原生解析库 ID 并检索文档
- 使用 ctx7 CLI 的 library/docs 命令或安装 skill,在无 MCP 的情况下引导 agent 获取文档

## 使用说明

- 各客户端平台的具体兼容性与配置要求需人工核验
- CLI + Skills 模式所安装 skill 的具体规范与版本支持情况

## 来源

- [上游仓库](https://github.com/upstash/context7)
- 本条目由 AI 根据上游 README 生成，未执行候选仓库中的代码或安装命令。
