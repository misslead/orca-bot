# OrcaBot 工作区

本仓库是 Orca 内的「主管 Bot」：目标拆解 → 方案设计 → 任务分派 → 审核 → Git 存档。
主管角色定义见 `.codebuddy/agents/orca-bot.md`，机器可执行流程见 `bin/orca-bot.mjs`。

## 硬性规则

1. 子代理默认模型 `deepseek-v4.1-flash`（CodeBuddy 积分），配置在 `config/bot.json`。
2. 方案优先 ego 浏览器 → 网页版 ChatGPT；不可用时回退 CodeBuddy planner，并注明降级。
3. 规划前主动用 `find-skills` 查远程技能，本地用 `node bin/orca-bot.mjs skills "<关键词>"` 查索引。
4. 细节工作交给子代理（bot-builder / bot-scout / bot-reviewer），主管只做分派、审核、调度、汇报。
5. 不修改任务工作区之外的文件；不覆盖与本任务无关的文件。
6. 每个通过审核的任务立即 Git 存档；回滚使用 `node bin/orca-bot.mjs rollback <ref> --yes`。
7. 同一操作连续失败 3 次，停止并请求人工处理。
8. 破坏性操作（reset --hard、force push、删除）必须先得到用户明确同意。
9. 本仓库内的子代理分派属于用户预授权：在 `limits` 范围内由主管自行决定，无需逐次申请。

## 常用入口

```text
node bin/orca-bot.mjs status
node bin/orca-bot.mjs skills "关键词"
node bin/orca-bot.mjs plan "目标" --workspace <路径>
node bin/orca-bot.mjs run  "目标" --workspace <路径>
node bin/orca-bot.mjs tick
node bin/orca-bot.mjs checkpoint "说明" --workspace <路径>
node bin/orca-bot.mjs rollback <commit> --workspace <路径> --yes
```

在 Orca 中启动主管：`codebuddy --agent orca-bot`
