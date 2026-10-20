# MVP 路线与验收标准

> 对应架构：[architecture.md](architecture.md)  
> 进展记录：[progress.md](progress.md)

## 阶段总览

| 阶段 | 目标 | 状态 |
|---|---|---|
| D0 | 方案设计与文档基线 | ✅ 已完成 |
| M0 | Runtime + CEO 工具 + Fake Position | ⬜ 未开始 |
| M1 | 单机真实 harness 闭环 | ⬜ 未开始 |
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

### 目标

在 CEO harness 内跑通一条不依赖真实模型员工的完整管理链路。

### 交付物

- `packages/core`：领域模型、Zod schema、任务状态机。
- `packages/store`：SQLite + Drizzle，核心表。
- `apps/runtime`：Runtime API + MCP server 骨架。
- `packages/adapters`：Fake Harness。
- `packages/ceo-skill`：CEO 守则和工具说明。
- 一个最小 `company.*` 工具集：`brief`、`plan.create`、`task.assign`、`inbox`、`status`。
- 启动脚本和本地开发说明。

### 验收

- 在 CEO harness 里对 CEO 说一个目标。
- CEO 创建任务 DAG，派给 Fake Position。
- Fake Position 返回结构化报告。
- CEO 汇总并在同一个聊天窗口汇报。
- 重启 Runtime 后，任务和报告还在。
- 不出现第二个聊天界面。

### 不做

- 真实 Claude Code / opencode / pi 适配。
- 远程节点。
- IM / 语音。
- Web 可视化。

## M1：单机真实 Harness 闭环

### 目标

让至少两个真实 harness 作为 Position 完成一次真实任务，并支持继续、返工和审批。

### 交付物

- Claude Code 适配器。
- opencode 或 pi agent 适配器。
- 通用 CLI 适配器（兜底）。
- git worktree 隔离和分支提交。
- Session Manager：`session_ref` 保存、校验、恢复、失效。
- Context Pack Builder。
- `continue` / `reopen` / `new task` 语义。
- 审批桥：harness 权限请求 → CEO → 人类。
- 事件流、JSONL 日志、产物登记。
- 最小预算和超时控制。

### 验收

- 一句真实需求，CEO 派给两个真实 Position，至少一个产出代码变更。
- 同一任务追加要求时，能 resume 或从 Context Pack 重建，不丢关键上下文。
- Position 完成后，CEO 能派一个相关新任务，并带上原报告和分支。
- 危险操作会停下来等人类批准。
- Runtime 重启后，任务、session 引用和交接单可恢复。
- resume 失败时自动重建，不中断任务。

### 不做

- 多电脑。
- IM / 语音。
- 自动合并到主分支（先进入合并队列）。

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
