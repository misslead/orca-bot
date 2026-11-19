# OrcaBot

在 [Orca](https://orca.dev) / CodeBuddy 里运行的「主管 Bot」：把一个目标拆成可验收任务，交给多个子代理执行，审核通过后自动 Git 存档。

```text
目标 → 找技能 → 出方案 → 拆任务 → 分派子代理 → 只读审核 → git commit → 汇报
```

主模型默认 `deepseek-v4.1-flash`；方案优先通过 ego 浏览器交给网页版 ChatGPT，失败自动回退本地规划器。

## 特性

- **主管 + 5 个子代理**：`bot-planner`（方案）、`bot-scout`（找技能）、`bot-builder`（实现）、`bot-reviewer`（只读审核）、`bot-archivist`（存档）。
- **确定性调度**：`plan / run / tick / dispatch / review / checkpoint / rollback` 都由脚本执行，模型只在任务内自由发挥。
- **双方案源**：ego → ChatGPT 优先；未登录、超时或输出不可解析时回退 CodeBuddy planner。
- **审核门禁**：审核不通过退回修复，最多 1 轮，仍失败标记阻塞。
- **Git 存档**：每个通过审核的任务自动提交，可随时回滚。
- **额度保护**：单次运行的子代理调用数、任务数、超时都是硬上限。
- **工作区白名单**：默认只允许配置的根目录，越界需显式 `--allow-any`。

## 环境要求

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js 18+ | 必需 | 调度器与 ego 桥接 |
| CodeBuddy CLI (`codebuddy`) | 必需 | 提供子代理与 `deepseek-v4.1-flash` |
| ego-browser (`ego-browser`) | 可选 | 用于网页版 ChatGPT 规划；缺失则自动回退 |
| Orca | 可选 | 用于终端、工作区与定时自动化 |
| PowerShell 7 (`pwsh`) | 可选 | 仅 `bin/orca-boot.ps1` 需要 |

## 安装

```bash
git clone <this-repo> orca-bot
cd orca-bot
node bin/orca-bot.mjs status
```

`status` 会打印模型、仓库状态、最新运行、Orca 与 ego 的可用性。

## 配置

编辑 `config/bot.json`：

```json
{
  "model": "deepseek-v4.1-flash",
  "allowedWorkspaceRoots": ["/path/to/your/projects"],
  "defaultWorkspace": "workspace"
}
```

- `allowedWorkspaceRoots`：允许 Bot 改动的工作区根目录；默认 `["."]` 表示仅允许本仓库内。
- `limits`：`maxSubagentCallsPerRun`、`maxTasksPerRun`、`maxFixAttempts`、`subagentTimeoutMs`。
- `planner.prefer`：`ego` 或 `codebuddy`。

## 使用

```bash
# 只出方案和任务清单，不改代码
node bin/orca-bot.mjs plan "做一个 xxx" --workspace /path/to/project

# 出方案 + 顺序执行 + 审核 + 通过即提交
node bin/orca-bot.mjs run  "做一个 xxx" --workspace /path/to/project

# 继续最新运行中未完成的任务（适合定时任务）
node bin/orca-bot.mjs tick

# 本地技能与子代理索引
node bin/orca-bot.mjs skills "关键词"

# 手动存档 / 回滚
node bin/orca-bot.mjs checkpoint "说明" --workspace /path/to/project
node bin/orca-bot.mjs rollback <commit> --workspace /path/to/project --yes
```

跳过 ego：`--no-ego`。

## 任务与验收

`plan` 产出的任务结构：

```json
{
  "id": "T1",
  "title": "短标题",
  "role": "builder",
  "instructions": "具体做什么",
  "acceptance": "可验证的完成标准",
  "files": ["相对路径"],
  "depends_on": []
}
```

执行时按依赖顺序推进；`bot-reviewer` 对照 `acceptance` 输出：

```json
{"verdict": "pass|fail", "summary": "...", "issues": []}
```

## 子代理

| agent | 职责 | 工具 |
| --- | --- | --- |
| `bot-planner` | 方案与任务拆解，优先 ego → ChatGPT | Bash, Read, Write, Glob, Grep |
| `bot-scout` | `find-skills` + 本地技能索引 | Bash, Read, Glob, Grep, WebSearch, WebFetch |
| `bot-builder` | 单任务实现与自测，不 commit | Bash, Read, Write, Edit, Glob, Grep |
| `bot-reviewer` | 只读审核，输出 JSON 判定 | Read, Glob, Grep, Bash |
| `bot-archivist` | 提交、打标签、变更摘要 | Bash, Read, Write, Glob, Grep |

定义在 `.codebuddy/agents/`，可在 CodeBuddy 中直接用 `--agent bot-builder` 调用。

## ego → ChatGPT

`plan` 会用 ego 浏览器打开 `https://chatgpt.com/`，提交规划问题并抓取回答。
需要先在 ego 浏览器中登录 ChatGPT；未登录或超时会记录原因并回退 CodeBuddy planner。

## 接入 Orca

```powershell
pwsh bin/orca-boot.ps1              # 注册仓库并开一个 OrcaBot 终端
pwsh bin/orca-boot.ps1 -Open        # Orca 未运行时先启动
pwsh bin/orca-boot.ps1 -Automation  # 额外创建每小时 tick 自动化（默认禁用）
```

自动化默认关闭，避免无意义消耗积分；需要自主推进时在 Orca 的 Automations 面板启用。

在 Orca 外也可以直接启动主管：

```bash
codebuddy --agent orca-bot
```

## Git 存档

通过审核的任务会在目标工作区执行一次提交：

```text
bot(<run-id>): T1 任务标题
```

- 目标工作区不是 Git 仓库时只记录“无存档”，不阻塞任务。
- `rollback` 是 `git reset --hard`，必须显式加 `--yes`。
- 提交身份来自 `config/bot.json` 的 `gitIdentity`，不会修改全局 Git 配置。

## 安全边界

- 工作区必须在 `allowedWorkspaceRoots` 内，越界需 `--allow-any`。
- 子代理被要求只改任务范围内、工作区内的文件。
- 每轮子代理调用数与任务数有硬上限，超出即停止。
- 破坏性操作（`reset --hard`、force push、删除）必须人工确认。
- 同一操作连续失败 3 次即停止，交由人工处理。

## 目录

```text
.codebuddy/agents/       主管与子代理定义
bin/orca-bot.mjs         调度器
bin/orca-boot.ps1        Orca 注册与启动
scripts/ego-chatgpt.mjs  ego → ChatGPT 桥接
config/bot.json          模型、角色、限额、白名单
runs/<run-id>/           运行计划、任务状态、日志（已忽略）
workspace/               默认沙箱工作区（已忽略）
```

## 已知限制

- ego 页面选择器依赖 ChatGPT 当前 DOM；改版后需更新 `scripts/ego-chatgpt.mjs`。
- 主要针对 Windows + CodeBuddy 验证；核心调度器是跨平台 Node 脚本。
- 审核与执行都会消耗模型额度，`limits` 是必要的成本闸门。
