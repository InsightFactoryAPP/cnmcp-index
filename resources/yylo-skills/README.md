# YYLO 技能包（yylo-skills）

YYLO 官方维护的 Agent 技能包，是 YYLO CLI 与 YYLO Ledger 所用技能的独立版本化源头仓库。包含 7 个以 `-yylo` 结尾的规范技能：Ledger 看板任务管理、PDR 计划与任务拆解、Ralph 单任务执行循环、项目结构理解、Wiki 知识维护、工作流记录与凭证产物管理。

## 适用人群

- 使用 Claude Code 或 Codex 并希望用看板方式管理编码任务的开发者
- 需要让代理执行"计划 → 单任务执行 → 验证提交"循环的团队
- 使用 YYLO Ledger 或 YYLO CLI 做任务编排的用户

## 主要能力

- ledger-tasks-yylo：操作 YYLO Ledger 任务看板与任务源边界（创建、依赖、就绪、排序、归档）
- plan-ledger-tasks-yylo：撰写产品开发需求（PDR）并拆解为可实现规模的看板任务
- ralph-loop-yylo：严格执行恰好一个被指派的 Ledger 任务直至验证完成
- understand-project-yylo：在规划或实现前先检查项目结构与依赖
- wiki-yylo / workflow-yylo / artifact-yylo：以版本化 Ledger 记录维护知识、工作流与凭证产物

## 使用说明

- 交互式安装：`npx skills add yylo-dev/yylo-skills`；无提示全量安装：`npx skills add yylo-dev/yylo-skills --skill '*' -a claude-code -a codex -a pi --copy -y`
- 四个 Ledger 记录技能可独立配合 YYLO Ledger 使用；计划与执行技能依赖 YYLO CLI 编排
- Ledger 记录命名空间需先存在于已安装的 `yylo-ledger --help`（或委托的 `yy ledger --help`）中
- 安装前应人工审阅技能说明与脚本；发布版本使用不可变的 vMAJOR.MINOR.PATCH 标签

## 来源

- [上游仓库](https://github.com/yylo-dev/yylo-skills)
- [YYLO 官网](https://yylo.dev)
- 本条目由 AI 根据上游 README 生成，未执行候选仓库中的代码或安装命令。
