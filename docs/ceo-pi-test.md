# Claude Code CEO × 两个 pi 职位：多轮任务 + 集成实测

- 日期：2026-10-21
- 执行者：本机 Claude Code `2.1.304`（作为 CEO）
- 员工：两个真实 `pi` `1.2.0` 职位
- 模型：`qianwenai/deepseek-v4.1-flash-1017`
- 测试脚本：`pnpm test:ceo-pi`
- 测试目录：`.aic/ceo-pi-test/2026-10-21T10-22-03-854Z/`

## 测试方式

1. 创建独立 git 仓库，初始 `hello.mjs` + `hello.test.mjs`。
2. 用独立 `AIC_DB_PATH` 启动 `ai-company` MCP stdio server。
3. Claude Code 作为 CEO，通过 MCP 工具：
   - 招聘两个真实 `pi` 职位；
   - 在同一个 thread 中连续创建 Round 1 / Round 2；
   - 创建 integration 任务，把四个任务分支合并到 `integration/<thread>`；
   - 在集成后的代码上运行 `node --test`。
4. 任务完成后，用 SQLite 读取公司状态并独立复核集成分支。

CEO system prompt 要求：

- 不自己写代码，只使用 `company_*` MCP 工具；
- Round 1：`pi-1` 加 `greet()`，`pi-2` 加 `shout()`；
- Round 2：`pi-1` 加 `goodbye()`，`pi-2` 加 `whisper()`；
- 每个任务都跑 `node --test`；
- 最后创建并运行 integration 任务。

## 结果

### 职位

| 职位 | 实际 harness | 状态 | workspace |
|---|---|---|---|
| `pi-1` | `pi` | idle | 测试仓库 |
| `pi-2` | `pi` | idle | 测试仓库 |

### 两轮 + 集成

| 轮次 | 任务 | 负责人 | 状态 |
|---|---|---|---|
| Round 1 | `Add greet helper` | `pi-1` | done |
| Round 1 | `Add shout helper` | `pi-2` | done |
| Round 2 | `Add goodbye helper` | `pi-1` | done |
| Round 2 | `Add whisper helper` | `pi-2` | done |
| Integration | `Integrate round 1 and 2` | `pi-1` | done |

- Thread：`th_c4891b95f4f4`（单一 thread，Round 2 复用 Round 1 thread）
- 任务总数：5
- 完成率：5/5
- 集成结果：4 个 source branch 全部合入，0 个跳过
- 集成分支：`integration/th_c4891b95f4f4`，head `b7c5623`
- 集成测试：`node --test`，**5/5 pass，exit 0**

### 集成分支内容

```text
goodbye.mjs
goodbye.test.mjs
greet.mjs
greet.test.mjs
hello.mjs
hello.test.mjs
package.json
shout.mjs
shout.test.mjs
whisper.mjs
whisper.test.mjs
```

独立复核：

```text
✔ greet returns a greeting for a name
✔ hello returns hello
✔ shout uppercases text
✔ whisper lowercases text
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

### 原始任务 ID

- `t_6aed62317c55` Add greet helper — pi-1
- `t_12fca91e6548` Add shout helper — pi-2
- `t_144e64226134` Add goodbye helper — pi-1
- `t_f5a451fbabbe` Add whisper helper — pi-2
- `t_b684908db372` Integrate round 1 and 2 — pi-1

## 这次验证了什么

- Claude Code 可以作为 CEO，通过 MCP 连续调度多个真实 pi 职位。
- 两个 pi 职位可以在同一 thread 中承接两轮任务。
- CEO 能识别“任务完成但未集成”的问题，并创建 integration 任务。
- integration 任务能按 source task 的 commit 把多个分支合入一条集成分支。
- 合并后重新跑全量测试，而不是只看各任务自己的测试。
- `company_merge_approve` 现在会阻止在存在 integration 任务时直接合并普通 source task。

## 历史问题与修复

第一次测试（`.aic/ceo-pi-test/2026-10-21T10-11-06-965Z/`）暴露了：

1. **四个任务分支没有自动集成**
   每个任务都在自己的 `task/<id>` 分支上基于 `main`，`main` 仍是初始版本。
   已通过新增 integration 任务解决。

2. **`AIC_DB_PATH` 没有被默认值读取**
   MCP server 写入了默认 `.aic/company.db`，导致测试库为空、复用旧 workspace。
   已修复：`DEFAULT_DB_PATH` 优先读取 `AIC_DB_PATH`。

## 当前仍需注意

- Thread 标题仍是 `Round 1`：Round 2 追加到同一 thread 后，thread 元数据没有更新。这是展示层问题。
- CEO 尝试用 Bash/Git 独立检查仓库时仍会被权限拦截；它改用测试 artifact 和 diff 验证。这是预期边界。
- 实时权限桥已覆盖 Claude SDK、opencode ACP、pi-live；本报告主要验证 pi 普通模式。
- 远程节点已支持 `push_remote` 推送到共享 remote；默认策略仍需显式开启。

## 可复现

```bash
pnpm test:ceo-pi
```

该命令会新建独立测试目录和 git 仓库，启动 MCP server，用真实 Claude Code 作为 CEO，招聘两个真实 pi 职位，执行两轮任务和 integration，并输出状态与 transcript 路径。

会产生真实模型费用，因此不放进默认 `pnpm test`。
