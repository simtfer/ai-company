# 项目进展

> 最后更新：2026-10-21
>
> 当前阶段：D0–M2 已完成；M3 暂缓；M4 核心完成
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
| M1 Claude Code 适配 | ✅ 已完成 | 2.1.304 真实 stream-json、session、测试通过 |
| M1 pi 适配 | ✅ 已完成 | 1.2.0 真实 JSON、session、测试通过 |
| M1 harness 自动发现 | ✅ 已完成 | nvm / WorkBuddy / scoop；支持环境变量覆盖 |
| M1 worktree | ✅ 已完成 | 每任务独立 worktree，自动提交和 diff |
| M1 Session Manager | ✅ 已完成 | 三个 harness 均已实测 resume |
| M1 审批与工具白名单 | ✅ 已完成 | `requires_approval`、`allowed_tools`、`denied_tools` |
| M2 Node Agent | ✅ 已完成 | 注册、心跳、claim、events、complete、续租 |
| M2 远程派工 | ✅ 已完成 | 控制平面租约 + 节点 HTTP 拉取执行 |
| M2 产物回传 | ✅ 已完成 | 测试文本 + diff 写入 `.aic/artifacts/remote-*` |
| M2 节点管理 | ✅ 已完成 | enroll / list / drain / revoke |
| M3 IM/语音 | ⏸ 暂缓 | 以后做，不阻塞 M4 |
| M4 预算硬停 | ✅ 已完成 | 公司/职位/任务 USD + 分钟预算 |
| M4 重试与升级 | ✅ 已完成 | 自动重试 + 手动 retry |
| M4 评审与合并队列 | ✅ 已完成 | 独立 review task 自动派工 + 真实 ff-only merge |
| M4 指标与记忆 | ✅ 已完成 | metrics + memory search |
| M4 备份与日志 | ✅ 已完成 | VACUUM INTO 备份、恢复、日志清理 |
| M4 打包 | ✅ 已完成 | `pnpm build:sea` → `dist/aic.exe` |
| M4 服务化 | ✅ 已完成 | Windows 计划任务 / Linux systemd 安装 |
| M4 实时权限桥 | ✅ 已完成 | Claude SDK `canUseTool` / opencode ACP / pi `tool_call` |

## 阶段状态

| 阶段 | 状态 | 完成日期 | 验收证据 |
|---|---|---|---|
| D0 方案设计 | ✅ 已完成 | 2026-10-21 | `architecture.md` / `roadmap.md` / `progress.md` |
| M0 Runtime + Fake Position | ✅ 已完成 | 2026-10-21 | `pnpm test` 10 passed；`pnpm demo`；MCP stdio 集成测试 |
| M1 单机真实 Harness | ✅ 已完成 | 2026-10-21 | 18 tests；三个 harness 连通/会话/代码修改均实测 |
| M2 多电脑节点 | ✅ 已完成 | 2026-10-21 | 21 tests；`pnpm demo:multi-node`；两个 HTTP node agent |
| M3 IM / 语音 | ⏸ 暂缓 | — | 按用户决定以后做 |
| M4 质量与打包 | ✅ 核心完成 | 2026-10-21 | 34 tests；预算/重试/评审/指标/备份/SEA/服务化/实时审批/sticky session |

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

- 探测本机 harness：Claude Code 2.1.304（nvm v24）、pi 1.2.0（WorkBuddy 内置 Node）、opencode 1.18.35（scoop）均可用。
- 实现 `src/adapters/opencode.ts`：真实 `opencode run --format json`，解析 session、text、tool、usage、cost。
- 实现 `src/adapters/claude-code.ts`：真实 `claude -p --output-format stream-json`，session resume、token/cost、tool 事件。
- 实现 `src/adapters/pi.ts`：真实 `pi -p --mode json`，session-id resume、usage、tool 事件。
- 实现 `src/adapters/discovery.ts`：自动发现非 PATH 安装，支持 `AIC_CLAUDE_COMMAND` / `AIC_PI_COMMAND` / `AIC_OPENCODE_COMMAND` 覆盖。
- 实现 `src/adapters/env.ts`：从 Windows 用户环境读取模型密钥，仅传给子进程，不写日志。
- 实现 `src/adapters/process.ts`：JSONL 子进程、超时、AbortSignal、进程树清理。
- 实现 `src/workspace/git-workspace.ts`：worktree、自动提交、diff/变更文件、diff 产物。
- 实现真实 session 管理：有效 session resume；过期 session 回退 Context Pack 重建。
- 实现任务级 `test_command`、超时、预算分钟数、`.aic/logs/<run_id>.jsonl`。
- 实现执行前审批闸门 + 工具白名单：`requires_approval`、`allowed_tools`、`denied_tools`。
- 新增 `pnpm demo:opencode`：`opencode-dev` 修改 `hello.mjs`，`opencode-qa` 从 dev 分支验收。
- 新增 `pnpm demo:harnesses`：三个真实 harness 连通性验证，均返回预期 token。
- 新增 `pnpm demo:sessions`：三个真实 harness 均完成 `FIRST → SECOND` session 连续，`resumed: true`。
- 新增 `pnpm demo:code`：Claude Code 添加 `goodbye`、pi 添加 `shout`，`node --test` 均 2 passed。
- 测试：7 个测试文件、18 个测试通过，覆盖 adapter、worktree、session 回退、审批、测试失败、pi 解析。
- M1 完成；下一步 M2 多电脑节点。

### 2026-10-21 — M2

- 扩展数据模型：nodes 增加 workspace root / token hash / drain / revoked；tasks 增加租约字段；runs 增加 node / lease。
- 实现节点注册：一次性 enrollment token，30 分钟有效，单次使用；注册后发放 node token。
- 实现 Node Agent：`src/node/agent.ts`，注册、心跳、claim、events、complete、租约续期。
- 实现远程执行器：`src/node/executor.ts`，在节点本地使用 worktree/adapter/test/artifact。
- 实现控制平面远程派工：`CompanyService.executeRemoteTask`，租约等待、超时、租约过期重排。
- 实现产物回传：远程测试文本和 diff 写入 `.aic/artifacts/remote-*`。
- 实现节点管理：`company_node_enroll`、`company_node_list`、`company_node_drain`、`company_node_revoke`。
- 实现 CLI：`pnpm cli node:token`、`pnpm cli node:join`、`pnpm serve --host`。
- 新增 `pnpm demo:multi-node`：本机启动两个 HTTP node agent，各执行一个远程任务。
- 真实验证：`pnpm cli node:join` 注册并心跳成功；远程 opencode 节点执行 `REMOTE_REAL_OK` 成功（手动 smoke test）。
- 测试：8 个测试文件、21 个测试通过，覆盖注册、双节点派工、产物、租约重排、drain/revoke、token 不可复用。
- M2 完成。
- 2026-10-21：按用户决定，M3 IM/语音暂缓，不作为 M4 前置；下一阶段为 M4 质量与打包加固。

### 2026-10-21 — M4

- 数据模型：任务增加 attempts/max_retries；运行增加 tokens/cost_usd；新增 merge_queue。
- 预算：公司/职位/任务三级 USD 预算；派工前硬停，任务超预算转 blocked。
- 重试：失败任务按 `max_retries` 自动重试，支持 `company_task_retry` 手动重试。
- 评审与合并队列：`company_review_request` 创建独立 review task 并自动派工；merge queue 支持 ready、ff-only git merge、reject。
- 指标：`company_metrics` 返回任务状态、运行、平均耗时、token/成本、重试、节点、merge queue 和预算。
- 记忆：`company_memory_search` 搜索员工手册、Position Memory 和 thread 摘要。
- 运维：`backup`（SQLite VACUUM INTO）、`restore`、`logs:prune`、`bin/aic.mjs` 入口、`docs/operations.md`。
- 打包：`pnpm build`（单文件 ESM）和 `pnpm build:sea`（当前平台 `dist/aic.exe`）。
- 服务化：`service:install` 生成/安装 Windows 计划任务或 Linux systemd unit；`service:uninstall`。
- 预算：分钟级公司/职位/任务预算也参与硬停；任务超时/超预算转 blocked。
- 实时权限桥：新增 `claude-sdk` 适配器，使用 Claude Agent SDK `canUseTool`；工具执行前写 decision，等待 `decision:resolve` / HTTP 审批；真实 Claude smoke test 创建文件成功。
- 真实 CEO 集成：Claude Code `2.1.304` 作为 CEO，通过 MCP 调度两个真实 pi 职位，连续两轮 4 个任务全部 done、测试通过；报告见 [ceo-pi-test.md](ceo-pi-test.md)。
- 多分支集成：新增 `company_integration_create`；把同一 thread 的多个任务分支按顺序合入 `integration/<thread>`，合并后重跑全量测试；集成任务存在时，普通 source task 不能直接 approve merge。
- 冲突自动处理：集成冲突时保留冲突 worktree，自动创建 integrator 任务；解决后自动把 integration 任务重新入队并重试。
- 远程分支共享：节点可通过 `push_remote` 把任务分支推到共享 remote，报告记录 `remote` / `pushed_ref`；控制平面集成时自动 `git fetch --all --prune`。
- opencode 实时权限：新增 `opencode-acp` 适配器，使用 ACP `session/request_permission`；真实 opencode 工具暂停并经 decision 批准后执行。
- pi 实时权限：新增 `pi-live` 适配器，生成临时 pi 扩展监听 `tool_call`，通过本地审批 HTTP 端点暂停工具；真实 pi 工具暂停并经 decision 批准后执行。
- 测试：`test:opencode-acp` 真实验证 `acp.txt` 创建成功；`test:pi-live` 真实验证 `pi.txt` 创建成功；`test:ceo-pi` 真实验证两轮 + 集成。
- 修复 `DEFAULT_DB_PATH` 不读取 `AIC_DB_PATH` 的问题，隔离测试库现在生效。
- Position 级 sticky session：一个 Position 固定 cwd，所有任务复用同一个 active session；新员工新 cwd 新 session；session 丢失 blocked；失败任务 checkpoint commit。
- 测试：11 个测试文件、34 个测试通过；另有可选真实集成脚本 `pnpm test:ceo-pi`。
- 真实 CEO + 集成实测：5/5 任务 done，4 个 source branch 全部合入，集成分支 `integration/th_c4891b95f4f4` 上 `node --test` 5/5 pass。
- M4 核心完成；剩余项：远程 git 分支自动推送、Windows 原生 NSSM/WinSW 服务模式。

## 下一步

1. 远程共享 remote 的凭据托管与自动 push 默认策略。
2. 线程标题在追加 Round 2 后更新。
3. Windows NSSM/WinSW 原生服务模式。
4. M3 IM/语音保持设计，等以后恢复。

## 阻塞与风险

- 当前无阻塞。
- 风险：M2 使用 HTTP 拉取，没有内建 TLS；跨公网必须用 Tailscale/WireGuard 或反向代理。
- 风险：集成任务已能合并多分支，但合并冲突时需要人工/专门 integrator 处理；当前会失败并记录冲突文件。
- 风险：远程 git 分支目前留在节点本地；跨机器合并需要共享 git remote 或 bundle 回传。
- 风险：三个 harness 的 CLI 参数会随版本变化；adapter 依赖 `probe()` 和契约测试，升级后需要重新验证。
- 风险：`pi-live` 依赖 pi 扩展 API；pi 升级后需要重新验证扩展加载和 `tool_call` 钩子。
- 风险：当前 DSH 版本的原生 MCP 配置尚未接入；MCP stdio 已用客户端验证，接入方式见 `docs/ceo-harness-setup.md`。
- 风险：CEO harness 的主动通知受回合制限制；M3 暂缓，因此目前仍只能在下一次对话用 `company_inbox` 汇报增量。
