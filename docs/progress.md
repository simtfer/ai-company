# 项目进展

> 最后更新：2026-10-21
>
> 当前阶段：D0 已完成，M0 已完成，M1 核心完成，M2 未开始
> 入口：CEO harness（不做独立聊天软件）

## 当前状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 方案设计 | ✅ 已完成 | 架构、路线、进展文档已建立 |
| 工作区 | ✅ 可用 | `D:\tmp\b` 已可写入 |
| 代码仓库 | ✅ 已建立 | [simtfer/ai-company](https://github.com/simtfer/ai-company)（private） |
| M0 Runtime | ✅ 已完成 | SQLite、任务状态机、CompanyService、Context Pack |
| M0 CEO 工具 | ✅ 已完成 | MCP stdio + HTTP API + CLI |
| M0 Fake Position | ✅ 已完成 | 3 个 Fake 职位，依赖顺序执行 |
| M1 opencode 适配 | ✅ 已完成 | 真实 JSONL、session、usage、tool 事件 |
| M1 worktree | ✅ 已完成 | 每任务独立 worktree，自动提交和 diff |
| M1 Session Manager | ✅ 已完成 | resume 有效，过期自动回退重建 |
| M1 审批闸门 | ✅ 已完成 | 执行前 `waiting_approval` |
| M1 Claude Code 适配 | 🟡 实验性 | 代码完成，本机无 `claude` 二进制 |
| M2 多电脑 | ⬜ 未开始 | 下一步 |
| M3 IM/语音 | ⬜ 未开始 | 依赖 M2 |
| M4 加固 | ⬜ 未开始 | 依赖 M3 |

## 阶段状态

| 阶段 | 状态 | 完成日期 | 验收证据 |
|---|---|---|---|
| D0 方案设计 | ✅ 已完成 | 2026-10-21 | `architecture.md` / `roadmap.md` / `progress.md` |
| M0 Runtime + Fake Position | ✅ 已完成 | 2026-10-21 | `pnpm test` 10 passed；`pnpm demo`；MCP stdio 集成测试 |
| M1 单机真实 Harness | 🟡 核心完成 | 2026-10-21 | 17 tests；`pnpm demo:opencode`；真实 session continuation |
| M2 多电脑节点 | ⬜ 未开始 | — | — |
| M3 IM / 语音 | ⬜ 未开始 | — | — |
| M4 质量与打包 | ⬜ 未开始 | — | — |

## 变更日志

### 2026-10-21

- 建立 `docs/` 目录。
- 保存当前方案到 `docs/architecture.md`。
- 新增 `docs/roadmap.md`，定义 D0–M4 阶段和验收标准。
- 新增 `docs/progress.md`，作为后续每个阶段的进展记录。
- 新增 `docs/README.md`，作为文档索引。
- 确认关键方向：CEO harness 是唯一人类入口；不做独立聊天软件；保留无界面 Company Runtime；Position 使用“长员工、短会话”。
- 新增 `.gitignore`，初始化 git 仓库，默认分支 `main`。
- 创建私有远程仓库 [simtfer/ai-company](https://github.com/simtfer/ai-company)，关联 `origin`，提交 `37c928e` 并推送。

### 2026-10-21 — M0

- 搭建 TypeScript + Node 24 工程，引入 Zod、MCP SDK、commander、Vitest。
- 实现 `src/domain`：任务/职位/报告/决策/上下文包 schema 和状态机。
- 实现 `src/store`：SQLite WAL 持久化，覆盖公司、节点、职位、线程、任务 DAG、运行、报告、事件、决策、session、记忆、产物。
- 实现 `src/service/company-service.ts`：计划、指派、执行、继续、返工、取消、决策、招聘/暂停/解雇。
- 实现 `src/adapters/fake.ts`：Fake Harness，支持 done / blocked / needs_decision / failed。
- 实现 MCP stdio server，暴露 `company_*` 工具；实现本地 HTTP API 和 CLI demo。
- 新增 `ceo-skill/SKILL.md` 与 `docs/ceo-harness-setup.md`。
- 测试：3 个测试文件、10 个测试通过，含 MCP stdio 集成测试。
- 验收：`pnpm demo` 完成 3 个任务的依赖顺序执行；重启持久化、continue、决策恢复均有测试覆盖。
- M0 完成；M1（真实 Claude Code / opencode / pi 适配）未开始。

### 2026-10-21 — M1

- 探测本机 harness：`opencode 1.18.35` 可用；`claude`、`pi` 未安装。
- 实现 `src/adapters/opencode.ts`：真实 `opencode run --format json`，解析 session、text、tool、usage、cost。
- 实现 `src/adapters/claude-code.ts`：实验性 stream-json 适配器，未被真实环境验证。
- 实现 `src/adapters/process.ts`：JSONL 子进程、超时、AbortSignal、进程树清理。
- 实现 `src/workspace/git-workspace.ts`：worktree、自动提交、diff/变更文件、diff 产物。
- 实现真实 session 管理：有效 session resume；过期 session 回退 Context Pack 重建。
- 实现任务级 `test_command`、超时、预算分钟数、`.aic/logs/<run_id>.jsonl`。
- 实现执行前审批闸门：`requires_approval` → `waiting_approval` → 批准 → 执行。
- 新增 `pnpm demo:opencode`：`opencode-dev` 修改 `hello.mjs`，`opencode-qa` 从 dev 分支验收。
- 真实验证：dev/QA 都返回 done；`node --test` 2 passed；真实 session `FIRST → SECOND` 恢复成功。
- 测试：6 个测试文件、17 个测试通过，覆盖 adapter、worktree、session 回退、审批、测试失败。
- M1 核心完成；Claude Code 和 pi 的真实环境验证仍待补。

## 下一步

1. 补测 Claude Code / pi 真实环境；如果暂时没有二进制，保留实验性标记。
2. 实现 harness 工具执行中的实时审批桥（当前只有执行前闸门）。
3. 进入 M2：Node Agent、注册/心跳/租约、远程派工和产物回传。
4. 每完成一个阶段，更新本文件的阶段状态、变更日志和验收证据。

## 阻塞与风险

- 当前无阻塞。
- 风险：本机只有 opencode 真实可用；Claude Code 适配器未在真实 CLI 上验证，pi 未接入。
- 风险：当前审批是任务级执行前闸门；harness 内部工具执行中的实时权限桥接尚未实现。
- 风险：当前 DSH 版本的原生 MCP 配置尚未接入；MCP stdio 已用客户端验证，接入方式见 `docs/ceo-harness-setup.md`。
- 风险：CEO harness 的主动通知受回合制限制；M3 前只能在下一次对话汇报增量。
