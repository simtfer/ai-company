# Claude Code CEO × 两个 pi 职位：多轮任务实测

- 日期：2026-10-21
- 执行者：本机 Claude Code `2.1.304`（作为 CEO）
- 员工：两个真实 `pi` `1.2.0` 职位
- 模型：`qianwenai/deepseek-v4.1-flash-1017`
- 测试脚本：`pnpm test:ceo-pi`
- 测试目录：`.aic/ceo-pi-test/2026-10-21T10-11-06-965Z/`

## 测试方式

1. 创建独立 git 仓库，初始 `hello.mjs` + `hello.test.mjs`。
2. 用独立 `AIC_DB_PATH` 启动 `ai-company` MCP stdio server。
3. Claude Code 通过 MCP 工具招聘两个 `pi` 职位、创建两轮任务 DAG、派工并执行。
4. 任务完成后，用 SQLite 读取公司状态并核对报告。

CEO system prompt 明确要求：

- 不自己写代码，只使用 `company_*` MCP 工具；
- 第 1 轮：`pi-1` 加 `greet()`，`pi-2` 加 `shout()`；
- 第 2 轮：`pi-1` 加 `goodbye()`，`pi-2` 加 `whisper()`；
- 每轮都跑 `node --test`。

## 结果

### 职位

| 职位 | 实际 harness | 状态 | workspace |
|---|---|---|---|
| `pi-1` | `pi` | idle | 测试仓库 |
| `pi-2` | `pi` | idle | 测试仓库 |

### 两轮任务

| 轮次 | 任务 | 负责人 | 状态 | 报告 |
|---|---|---|---|---|
| Round 1 | `Add greet()` | `pi-1` | done | done，2 tests passed |
| Round 1 | `Add shout()` | `pi-2` | done | done，2 tests passed |
| Round 2 | `Add goodbye()` | `pi-1` | done | done，2 tests passed |
| Round 2 | `Add whisper()` | `pi-2` | done | done，2 tests passed |

- Thread：`Round 1` / `Round 2`
- 任务总数：4
- 完成率：4/4
- 两轮均由同一个 CEO Claude Code 会话连续下发。
- CEO 没有直接修改文件；只调用 MCP 工具和只读检查。
- CEO 尝试使用 Bash 检查仓库时被权限拦截，这是预期边界。

### 原始任务 ID

- `t_3ea14f8b6824` Add greet() — pi-1
- `t_acbc15242658` Add shout() — pi-2
- `t_fd62640104b1` Add goodbye() — pi-1
- `t_ade1c9d6e9d8` Add whisper() — pi-2

## 发现的问题

### 1. 四个任务分支没有自动集成

每个任务都在自己的 worktree / `task/<task_id>` 分支上基于 `main`：

- `task/t_3ea14f8b6824` 有 `greet()`
- `task/t_acbc15242658` 有 `shout()`
- `task/t_fd62640104b1` 有 `goodbye()`
- `task/t_ade1c9d6e9d8` 有 `whisper()`

`main` 仍是初始版本。四个功能分散在四个分支，没有一条分支同时包含全部功能。

CEO 在最终报告里也正确指出了这个风险：任务都 done，但合并/集成未完成。

这是当前编排的真实缺口，不是 pi 执行失败：

- 任务级 worktree 隔离是对的；
- 但 CEO 需要显式使用依赖、`base_ref` 或 merge queue 把结果串起来；
- 目前 `company_merge_approve` 只能把一个 ready 分支 ff-only 合入本地 repo，不能自动把四个分支组合成一条集成分支。

### 2. `AIC_DB_PATH` 没有被默认值读取

第一次测试时 MCP server 忽略了 `AIC_DB_PATH`，写入了默认 `.aic/company.db`，导致测试库为空、`pi-1` 复用旧 workspace。

已修复：`DEFAULT_DB_PATH` 现在优先读取 `AIC_DB_PATH`。

### 3. CEO 会尝试执行 shell/读文件

即使 system prompt 说“只使用公司工具”，CEO 仍尝试了 `Bash` 和 `Read`。

- 当前 `--allowedTools` 只放行 `mcp__ai-company__*`，所以 shell 被拦截；
- 这说明工具白名单是有效边界；
- 但也说明 CEO prompt 需要持续强调“不要直接改代码”。

## 可复现

```bash
pnpm test:ceo-pi
```

该命令会：

- 新建独立测试目录和 git 仓库；
- 启动 MCP server；
- 用真实 Claude Code 作为 CEO；
- 招聘两个真实 pi 职位；
- 跑两轮、四个任务；
- 输出职位、任务、报告和 transcript 路径。

会产生真实模型费用，因此不放进默认 `pnpm test`。

## 下一步建议

1. 给 M4 增加“多分支集成”流程：CEO 创建 integration 任务，或 merge queue 支持按依赖顺序合并。
2. 让 CEO 在第 2 轮任务上使用 `base_ref` 指向第 1 轮分支，避免每轮都从 `main` 开始。
3. 给 CEO 增加只读工具集和更硬的“禁止直接编辑”边界。
4. 把该测试纳入可选的 nightly，而不是每次 CI。
