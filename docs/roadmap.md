# MVP 路线与验收标准

> 对应架构：[architecture.md](architecture.md)  
> 进展记录：[progress.md](progress.md)

## 阶段总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| D0 | 方案设计与文档基线 | ✅ 已完成 |
| M0 | Runtime + CEO 工具 + Fake Position | ✅ 已完成 |
| M1 | 单机真实 harness 闭环 | ✅ 已完成 |
| M2 | 多电脑节点 | ✅ 已完成 |
| M3 | IM 与语音入口 | ⏸ 暂缓（以后做） |
| M4 | 质量、成本与打包加固 | ✅ 核心完成 |

> M3（IM/语音）按用户决定暂缓，不作为 M4 的前置；主动推送能力等 M3 恢复后再补。

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

✅ 已完成（2026-10-21）

Claude Code 2.1.304、pi 1.2.0、opencode 1.18.35 均已实机验证。

### 目标

让至少两个真实 Position 完成一次真实任务，并支持继续、返工和审批。

### 实际交付物

- `OpencodeAdapter`：JSONL 事件解析、session id、token/cost、tool 事件。
- `ClaudeCodeAdapter`：真实 stream-json、session resume、token/cost、tool 事件。
- `PiAdapter`：真实 JSON 事件、session-id resume、usage、tool 事件。
- `discovery.ts`：自动发现 nvm 中的 Claude Code、WorkBuddy 内置的 pi、scoop 的 opencode，支持环境变量覆盖。
- `env.ts`：从 Windows 用户环境读取模型密钥，仅传给子进程，不写日志。
- `GitWorkspaceManager`：按任务创建 worktree、自动提交、diff 产物。
- Session Manager：`session_ref` 保存、校验、resume、过期回退重建。
- Context Pack Builder：任务、记忆、相关报告、workspace、session 信息。
- `continue` / `reopen` / 相关新任务语义。
- 执行前审批闸门 + 工具白名单：`requires_approval`、`allowed_tools`、`denied_tools`。
- 事件流写入 SQLite + `.aic/logs/<run_id>.jsonl`。
- 任务级 `test_command`、超时、预算分钟数、diff/test 产物登记。
- `pnpm demo:opencode`：`opencode-dev` 修改代码，`opencode-qa` 从 dev 分支验收。
- `pnpm demo:code`：Claude Code 和 pi 分别修改代码并跑测试。

### 验收证据

- `pnpm probe`：fake、opencode、claude-code、pi 四个 adapter 全部可用。
- `pnpm demo:harnesses`：三个真实 harness 均返回预期 token（CLAUDE_OK / PI_OK / OPENCODE_OK）。
- `pnpm demo:sessions`：三个真实 harness 的 `FIRST → SECOND` session 连续全部 `resumed: true`。
- `pnpm demo:code`：Claude Code 添加 `goodbye`、pi 添加 `shout`，`node --test` 均 2 passed。
- `pnpm demo:opencode`：两个真实 opencode Position 完成；dev 产出代码变更，QA 从 dev 分支验收。
- 报告包含 commit、diff 产物、测试证据和 handoff。
- `pnpm test`：7 个测试文件、18 个测试通过。
- session 测试覆盖：有效 session resume、过期 session 回退重建。
- 审批测试覆盖：`waiting_approval` → 批准 → 执行完成。
- 测试失败测试：`test_command` 非零退出时任务标记 failed。

### 验收

- ✅ 三个真实 harness 完成真实任务，至少一个产出代码变更。
- ✅ 同一任务追加要求时 resume；resume 失败自动用 Context Pack 重建。
- ✅ Position 完成后派相关 QA 新任务，带上 dev 分支和报告。
- ✅ 标记为需要审批的任务会停下来等人类批准。
- ✅ 工具白名单可限制 Claude Code / pi 的工具集合。
- ✅ Runtime 重启后任务、报告、session 引用可恢复。
- ✅ 测试失败会阻断任务完成。
- ⚠️ M1 时只有任务级执行前闸门 + 工具白名单；M4 已为 Claude SDK 增加实时权限桥。

### 不做

- 多电脑。
- IM / 语音。
- 自动合并到主分支（先进入合并队列）。
- harness 内部工具执行的实时 human-in-the-loop 权限询问。

## M2：多电脑节点

### 状态

✅ 已完成（2026-10-21）

### 目标

CEO 能管理另一台电脑上的 Position，并统一调度。

### 实际交付物

- `src/node/agent.ts`：Node Agent，注册、心跳、claim、events、complete、租约续期。
- `src/node/executor.ts`：节点本地 worktree/adapter/test/artifact 执行器。
- 节点注册：一次性 enrollment token（30 分钟、单次使用）+ node token。
- 任务租约：默认 60 秒，执行期间续租；过期自动回到 `assigned`。
- 远程产物回传：测试文本和 diff 写入控制平面 `.aic/artifacts/remote-*`。
- 节点管理工具：`company_node_enroll`、`company_node_list`、`company_node_drain`、`company_node_revoke`。
- 远程职位：`company_position_hire` 支持 `node_id` 和相对 workspace。
- CLI：`pnpm cli node:token`、`pnpm cli node:join`、`pnpm serve --host`。
- 文档：`docs/multi-node.md`。

### 验收证据

- `pnpm demo:multi-node`：本机启动两个 HTTP Node Agent，各执行一个远程任务，均 done。
- 测试：两个节点注册；远程派工；测试产物回传；租约过期重排；drain/revoke；一次令牌不可复用。
- 真实远程 opencode smoke test：远程节点返回 `REMOTE_REAL_OK`。
- `pnpm test`：8 个测试文件、21 个测试通过。
- `pnpm probe`：四个 adapter 仍可用。

### 验收

- ✅ 本机和模拟的第二台电脑各注册一个节点。
- ✅ CEO 能把任务派到远程节点并拿到报告。
- ✅ 租约过期后任务重新排队。
- ✅ CEO 能排空/撤销节点，撤销后 token 不可用。
- ✅ Runtime 持久化节点、职位、任务和产物。
- ✅ 节点可以运行真实 harness（opencode 远程 smoke test）。
- ⚠️ M2 传输是 HTTP 拉取，不是 WSS；没有内建 TLS，跨公网需 Tailscale/WireGuard/反向代理。
- ⚠️ 远程 git 分支留在节点本地；跨机器合并需要共享 git remote 或 bundle 回传。

### 不做

- 公网暴露控制平面（先用 Tailscale/WireGuard）。
- 跨节点自动迁移正在运行的任务（先重排/重建）。
- WSS 传输和双向流式事件（HTTP 轮询已满足 M2，后续替换传输层）。

## M3：IM 与语音入口

### 状态

⏸ 暂缓（2026-10-21 用户决定）。保留设计，暂时不实现，也不阻塞 M4。

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

### 状态

✅ 核心完成（2026-10-21）

### 目标

让公司可以稳定连续运行，而不是只完成一次演示。

### 实际交付物

- 任务/职位/公司三级 USD + 分钟预算；派工前硬停，单任务超预算转 blocked。
- `max_retries` 自动重试 + `company_task_retry` 手动重试。
- 独立 review task 自动派给 reviewer + merge queue（pending_review / ready / merged / rejected）。
- `company_merge_approve` 对本地 repo 执行 `git merge --ff-only`；不可用 repo 保留审计状态。
- `company_integration_create`：同一 thread 的多个任务分支合入 `integration/<thread>`，合并后重跑全量测试；有集成任务时禁止直接合并 source task。
- 远程节点可用 `push_remote` 推送任务分支到共享 remote；控制平面集成前自动 fetch。
- `company_metrics`：任务、运行、平均耗时、token/成本、重试、节点、merge queue、预算。
- `company_memory_search`：员工手册、Position Memory、thread 摘要。
- `backup`（SQLite VACUUM INTO）、`restore`、`logs:prune`。
- `pnpm build`（单文件 ESM）、`pnpm build:sea`（当前平台单文件 `dist/aic.exe`）。
- `service:install` 生成/安装 Windows 计划任务或 Linux systemd unit。
- 实时权限桥：`claude-sdk` 使用 `canUseTool`；`opencode-acp` 使用 ACP `session/request_permission`，工具执行前创建 decision。
- `docs/operations.md`：预算、指标、评审、打包、备份、服务化说明。

### 验收证据

- `pnpm test`：11 个测试文件、31 个测试通过。
- 预算测试：公司 USD 预算为 0、分钟预算为 0 时派工被 `BudgetExceededError` 硬停。
- 重试测试：失败任务自动重试一次，最终 failed，产生 2 份报告。
- 评审测试：独立 review task 自动派工 + merge queue，review 完成后 ready。
- 真实 merge 测试：临时 git repo 上 `git merge --ff-only` 成功，文件内容更新。
- 指标/记忆测试：metrics 有任务和预算数据；`playbook` 可检索到 Position Memory。
- 备份测试：VACUUM INTO 后新 Store 能读回任务。
- `pnpm build:sea` 生成 `dist/aic.exe`，`dist/aic.exe --version`、`budget`、`demo` 已验证。
- `service:install --name ...` 生成 Windows 计划任务定义已验证。
- 实时审批测试：Claude SDK `canUseTool` 暂停，human decision 允许后继续并返回 done。
- 真实 Claude smoke test：被暂停的 Bash 工具在批准后创建 `live.txt`，内容为 `LIVE_OK`。
- 真实 CEO 集成：Claude Code 作为 CEO，两个真实 pi 职位连续两轮 4 个任务全部 done，`node --test` 均通过；见 [ceo-pi-test.md](ceo-pi-test.md)。
- 多分支集成测试：临时 git repo 上合并两个独立任务分支，集成分支同时包含两个文件，集成测试通过；source task 被禁止直接 approve。
- 真实 CEO 集成复测：同一 thread 两轮 4 个任务 + 1 个 integration 任务全部 done；`integration/th_c4891b95f4f4` 上 `node --test` 5/5 pass。
- 共享 remote 测试：任务分支 push 到 bare remote，remote ref 与本地 commit 一致。
- opencode ACP 实测：`session/request_permission` 暂停 Bash，人类批准后创建 `acp.txt`，内容 `ACP_OK`。

### 验收

- ✅ 预算超限（USD/分钟）会硬停，并可由 CEO 查询预算状态。
- ✅ 失败任务支持自动/手动重试。
- ✅ 合并队列能阻止未 ready 的变更被 approve。
- ✅ 本地 repo 的 merge 会实际执行 `git merge --ff-only`。
- ✅ reviewer 自动派工。
- ✅ 单文件 SEA 打包。
- ✅ Windows 计划任务 / Linux systemd 安装定义。
- ✅ 卸载/升级不丢公司数据（SQLite 备份/恢复）。
- ✅ 有可回放的审计事件和运行记录。
- ✅ 多分支集成：同一 thread 的已完成任务可合并到 integration 分支并重跑测试。
- ✅ 有集成任务时，普通 source task 不能绕过集成直接 approve merge。
- ✅ 远程节点可把分支 push 到共享 remote，集成前自动 fetch。
- ✅ Claude SDK 工具执行中的实时权限桥（`canUseTool`）。
- ✅ opencode ACP 实时权限桥（`session/request_permission`）。
- ⚠️ pi 仍只有执行前审批 + 工具白名单，没有原生实时 permission hook。
- ⚠️ 远程 git 分支自动推送到共享 remote 仍待补。
- ⚠️ Windows 当前是计划任务，不是 NSSM/WinSW 原生服务。

## 统一验收原则

每个阶段完成时必须满足：

1. 用户全程不离开 CEO harness（M3 恢复后可通过 IM/语音，但仍是 CEO）。
2. 没有员工直接接触人类的通道。
3. 任务、决策、产物有持久化记录。
4. 失败可恢复，不依赖某个 CLI 的 session 永久有效。
5. 阶段文档和 `progress.md` 同步更新。
