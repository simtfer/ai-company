# 项目进展

> 最后更新：2026-10-21
>
> 当前阶段：D0 已完成，M0 已完成，M1 未开始
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
| M1 真实 harness | ⬜ 未开始 | 下一步 |
| M2 多电脑 | ⬜ 未开始 | 依赖 M1 |
| M3 IM/语音 | ⬜ 未开始 | 依赖 M2 |
| M4 加固 | ⬜ 未开始 | 依赖 M3 |

## 阶段状态

| 阶段 | 状态 | 完成日期 | 验收证据 |
|---|---|---|---|
| D0 方案设计 | ✅ 已完成 | 2026-10-21 | `architecture.md` / `roadmap.md` / `progress.md` |
| M0 Runtime + Fake Position | ✅ 已完成 | 2026-10-21 | `pnpm test` 10 passed；`pnpm demo`；MCP stdio 集成测试 |
| M1 单机真实 Harness | ⬜ 未开始 | — | — |
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

## 下一步

1. 进入 M1：先探测本机已安装 harness 的版本和 CLI 能力。
2. 实现 Claude Code 适配器和通用 CLI 适配器，保留 Fake Harness 作为测试替身。
3. 实现 git worktree、Session Manager、Context Pack 的真实恢复路径和审批桥。
4. 每完成一个阶段，更新本文件的阶段状态、变更日志和验收证据。

## 阻塞与风险

- 当前无阻塞。
- 风险：真实 harness 的实际安装版本尚未探测；M1 开始前需要 `probe()` 记录版本和能力。
- 风险：当前 DSH 版本的原生 MCP 配置尚未接入；M0 已用 MCP stdio 客户端验证，DSH 接入方式见 `docs/ceo-harness-setup.md`。
- 风险：CEO harness 的主动通知受回合制限制；M3 前只能在下一次对话汇报增量。
