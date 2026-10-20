# MVP 路线与验收标准

> 对应架构：[architecture.md](architecture.md)  
> 进展记录：[progress.md](progress.md)

## 阶段总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| D0 | 方案设计与文档基线 | ✅ 已完成 |
| M0 | Runtime + CEO 工具 + Fake Position | ✅ 已完成 |
| M1 | 单机真实 harness 闭环 | 🟡 核心完成 |
| M2 | 多电脑节点 | ⬜ 未开始 |
| M3 | IM 与语音入口 | ⬜ 未开始 |
| M4 | 质量、成本与打包加固 | ⬜ 未开始 |

## D0：方案设计

### 交付物

- `docs/architecture.md`：总体架构、对象模型、会话连续性、多电脑、安全。
- `docs/roadmap.md`：阶段与验收标准。
- `docs/progress.md`：进展记录。
- `docs/README.md`：文档索引。

### 验收

- 明确“CEO harness 是唯一入口，不做独立聊天软件”。
- 明确 Position、Session、Context Pack、Handoff 的关系。
- 明确多电脑节点模型和后续 IM/语音接入方式。

## M0：Runtime + CEO 工具 + Fake Position

### 状态

✅ 已完成（2026-10-21）

### 实际交付物

- `src/domain/schema.ts`：领域模型、Zod schema、报告与上下文包。
- `src/domain/state.ts`：任务状态机。
- `src/store/store.ts`：SQLite（`node:sqlite`）持久化，核心表与仓储方法。
- `src/service/company-service.ts`：计划、指派、执行、继续、返工、取消、决策、招聘。
- `src/adapters/fake.ts`：Fake Harness，支持 done / blocked / needs_decision / failed。
- `src/mcp-server.ts`：MCP stdio server，暴露 `company_*` 工具。
- `src/http-server.ts`：本地 HTTP API（仅绑定 `127.0.0.1`）。
- `src/cli.ts` + `src/demo.ts`：CLI 和端到端演示。
- `ceo-skill/SKILL.md`：CEO 守则和工具工作流。
- `docs/ceo-harness-setup.md`：CEO harness 接入说明。
- `tests/`：状态机、CompanyService、MCP stdio 集成测试。

### 验收证据

- `pnpm test`：3 个测试文件、10 个测试通过，包含 MCP stdio 集成测试。
- `pnpm demo`：3 个 Fake Position 按依赖顺序完成，返回 3 份结构化报告。
- `pnpm serve` + `POST /api/demo`：HTTP API 返回同样的执行结果。
- 持久化测试：关闭并重新打开 SQLite 后，任务和报告仍在。
- 继续任务测试：同一任务追加“年付改成 8 折”，生成第二份报告并更新 session/context。
- 决策测试：任务进入 `waiting_approval`，记录决策后恢复为 `assigned`。
- 未新增聊天 UI；人类入口仍是 CEO harness。

### 验收

- ✅ CEO 创建任务 DAG，派给 Fake Position。
- ✅ Fake Position 返回结构化报告。
- ✅ CEO 汇总并在同一个聊天窗口汇报（通过 MCP 工具和 CLI 验证）。
- ✅ 重启 Runtime 后，任务和报告还在。
- ✅ 不出现第二个聊天界面。
- ⚠️ 当前 DSH 版本的原生 MCP 配置尚未接入；MCP stdio 已用客户端验证，DSH 接入方式见 `ceo-harness-setup.md`。

### 不做

- 真实 Claude Code / opencode / pi 适配。
- 远程节点。
- IM / 语音。
- Web 可视化。

## M1：单机真实 Harness 闭环

### 状态

🟡 核心完成（2026-10-21）

opencode 已实机验证；Claude Code 适配器已实现但本机未安装；pi 未接入。

### 目标

让至少两个真实 Position 完成一次真实任务，并支持继续、返工和审批。

### 实际交付物

- `OpencodeAdapter`：JSONL 事件解析、session id、token/cost、tool 事件。
- `ClaudeCodeAdapter`：实验性非交互 stream-json 适配器，未做真实验证。
- `GitWorkspaceManager`：按任务创建 worktree、自动提交、diff 产物。
- Session Manager：`session_ref` 保存、校验、resume、过期回退重建。
- Context Pack Builder：任务、记忆、相关报告、workspace、session 信息。
- `continue` / `reopen` / 相关新任务语义。
- 执行前审批闸门：`requires_approval` 任务先等待人类决策。
- 事件流写入 SQLite + `.aic/logs/<run_id>.jsonl`。
- 任务级 `test_command`、超时、预算分钟数、diff/test 产物登记。
- `pnpm demo:opencode` 真实演示：`opencode-dev` 修改代码，`opencode-qa` 从 dev 分支验收。

### 验收证据

- `pnpm demo:opencode`：两个真实 opencode Position 完成；dev 产出代码变更，QA 从 dev 分支验收。
- dev 报告包含 `hello.mjs` / `hello.test.mjs` 变更、commit、diff 产物。
- `node --test` 由任务执行并写入证据；2 个测试通过。
- 真实 session continuation 手动验证：`FIRST` → `SECOND`，同一个 session 恢复。
- `pnpm test`：6 个测试文件、17 个测试通过。
- session 测试覆盖：有效 session resume、过期 session 回退重建。
- 审批测试覆盖：`waiting_approval` → 批准 → 执行完成。
- 测试失败测试：`test_command` 非零退出时任务标记 failed。

### 验收

- ✅ 真实需求派给两个真实 Position，至少一个产出代码变更。
- ✅ 同一任务追加要求时 resume；resume 失败自动用 Context Pack 重建。
- ✅ Position 完成后派相关 QA 新任务，带上 dev 分支和报告。
- ✅ 标记为需要审批的任务会停下来等人类批准。
- ✅ Runtime 重启后任务、报告、session 引用可恢复。
- ✅ 测试失败会阻断任务完成。
- ⚠️ 只验证了 opencode；Claude Code 适配器未在真实环境验证，pi 未接入。
- ⚠️ 当前审批是任务级执行前闸门；harness 工具执行中的实时权限桥接尚未实现。

### 不做

- 多电脑。
- IM / 语音。
- 自动合并到主分支（先进入合并队列）。
- 真实 Claude Code / pi 的强制验证（等二进制和凭证可用）。

## M2：多电脑节点

### 目标

CEO 能管理另一台电脑上的 Position，并统一调度。

### 交付物

- `apps/node-agent`：注册、心跳、能力上报、任务执行、事件回传。
- 节点注册令牌和撤销机制。
- 任务租约、断线重连、租约过期重排。
- 远程产物回传：git 分支优先，对象存储兜底。
- `company.node.*` 工具：list、enroll、drain、revoke。
- CEO 聊天里的文本组织图/节点状态。

### 验收

- 本机和另一台电脑各注册一个节点。
- CEO 能把任务派到远程节点并拿到报告。
- 远程节点断线后任务重新排队；恢复后能继续或重建。
- CEO 能暂停/排空/撤销一个节点。
- 关闭 CEO harness 再打开，Runtime 和节点状态仍在。

### 不做

- 公网暴露控制平面（先用 Tailscale/WireGuard）。
- 跨节点自动迁移正在运行的任务（先重排/重建）。

## M3：IM 与语音入口

### 目标

用户不在 CEO harness 窗口时，也能通过 IM 或语音与同一个 CEO 沟通。

### 交付物

- CEO Ingress/Egress 抽象。
- 至少一个 IM 桥（Slack / 飞书 / 微信 / 邮件中选一个）。
- 身份映射和鉴权。
- 决策卡在 IM 中的文本/按钮呈现。
- 语音 STT 入口；TTS 可选。
- CEO harness 无头调用模式。

### 验收

- IM 消息能触发 CEO 处理，并回到同一个 thread。
- IM 里的决定能恢复等待中的任务。
- 语音说一句话能创建目标或回答问题。
- 桥不会绕过 CEO 直接调用 `company.*`。
- 所有入口共享同一个公司状态。

### 不做

- 多人群聊的复杂权限。
- 声纹识别。
- 全双工实时语音。

## M4：质量、成本与打包加固

### 目标

让公司可以稳定连续运行，而不是只完成一次演示。

### 交付物

- 独立 reviewer / QA 职位和合并队列。
- 任务/职位/公司三级预算。
- 失败重试策略和升级策略。
- 公司记忆检索（员工手册、架构决策、历史任务）。
- 指标：成功率、平均耗时、成本、阻塞时间。
- 单文件打包、Windows 服务/Linux systemd 安装。
- 备份、恢复、日志轮转。

### 验收

- 连续完成多个任务，成本和失败率可控。
- 预算超限会硬停并通知 CEO。
- 合并队列能阻止未通过验收的变更。
- 卸载/升级不丢公司数据。
- 有可回放的审计记录。

## 统一验收原则

每个阶段完成时必须满足：

1. 用户全程不离开 CEO harness（M3 后可通过 IM/语音，但仍是 CEO）。
2. 没有员工直接接触人类的通道。
3. 任务、决策、产物有持久化记录。
4. 失败可恢复，不依赖某个 CLI 的 session 永久有效。
5. 阶段文档和 `progress.md` 同步更新。
