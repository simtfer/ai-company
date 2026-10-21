# AI Company 架构方案

> 版本：0.1（设计基线）  
> 日期：2026-10-21  
> 状态：已确认方向，待进入 M0 实现

## 1. 目标

构建一个“AI 公司”：

- 用户只与 CEO 沟通，不直接管理每个员工。
- 一个 harness 实例就是一个职位（Position）。
- CEO 负责理解目标、拆解任务、分派、监督、验收和汇报。
- 公司可以运行在一台电脑上，也可以管理多台电脑上的职位。
- 用户入口就是 CEO harness 本身，不额外开发聊天软件。
- 后期可以接入 IM 和语音，但仍然只与 CEO 对话。

### 非目标

- 不做多个 CLI 之间自由聊天的群聊系统。
- 不做另一个以聊天为主界面的独立 App。
- M0/M1 不做多租户、计费、移动端、复杂 RBAC。
- 不让员工绕过 CEO 直接接触人类。

## 2. 核心决策

1. **CEO harness 是唯一人类入口。**  
   用户在 CEO harness 的聊天窗口里说话；计划、进度、决策、最终报告都以聊天消息呈现。

2. **不做独立聊天软件。**  
   不开发第二套 Web 聊天 UI。以后如需可视化，只做可选的只读面板，不作为入口。

3. **保留一个无界面的 Company Runtime。**  
   它不提供窗口，只负责状态、队列、会话、审批、审计和节点连接。用户不需要打开它。

4. **CEO harness 是大脑，Company Runtime 是事实来源。**  
   CEO 的对话上下文可以是易失的；任务、职位、决策、产物必须持久化。

5. **长员工，短会话。**  
   Position 是长期存在的；每次任务是一个有边界的 Run。原生 harness session 只是缓存，不是记忆。

6. **结构化任务协议。**  
   CEO 与 Position 之间只传任务单、报告和上下文包，不传无边界的自由聊天。

7. **工具接口优先 MCP。**  
   CEO harness 通过 MCP 或等价工具接口调用 `company.*`；不支持 MCP 的 harness 用 CLI shim 兜底。

8. **先单机，再多机。**  
   先把 CEO → Position → 报告这条链路跑通，再接远程 Node Agent。

## 3. 总体架构

```text
┌──────────────────────────────────────────────┐
│ CEO Harness（唯一人类入口）                   │
│ 对话 · 规划 · 决策 · 汇报 · 调用管理工具       │
└──────────────────┬───────────────────────────┘
                   │ MCP / tool calls
┌──────────────────▼───────────────────────────┐
│ Company Runtime（无界面，后台运行）           │
│ SQLite · 任务队列 · 会话 · 审批 · 审计 · 节点  │
└───────┬──────────────────────────┬───────────┘
        │                          │
   Node A（本机）              Node B（远程）
   Claude Code / opencode      pi / opencode
```

### 3.1 职责边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| CEO Harness | 与人类对话、规划、决策、验收、汇报 | 直接执行员工任务、直接 SSH 远程机器 |
| Company Runtime | 状态机、队列、会话引用、上下文包、审批、审计、节点连接 | 代替 CEO 做业务判断 |
| Position | 在独立工作区执行一个任务 | 直接与人类沟通、管理其他职位 |
| Node Agent | 本机进程管理、心跳、任务执行、产物回传 | 做公司级调度决策 |

### 3.2 部署形态

- **独立守护进程（推荐，默认）**：Runtime 作为后台服务运行。关闭 CEO harness 后，任务继续，远程节点仍在线。
- **嵌入模式（可选，M0 简化）**：Runtime 嵌在 CEO harness 插件进程里。零额外进程，但关闭 harness 后任务停止，也不适合多电脑。

两种模式共用同一套 Runtime API，后续可以从嵌入模式平滑升级到守护模式。

## 4. 对象模型

| 对象 | 含义 | 关键字段 |
|---|---|---|
| Company | 一家公司 | 名称、员工手册、预算、政策 |
| Node / Office | 一台电脑 | 操作系统、能力、在线状态、workspace root、drain/revoked |
| Position | 一个 harness 实例 + 一个职位 | 角色、harness 类型、模型、工作区、权限、预算 |
| Project | 项目/仓库 | git 地址、默认分支、约定 |
| Thread | 一个目标/ initiative | 标题、摘要、状态、关联任务 |
| Task | 一张任务单，组成 DAG | 目标、验收标准、依赖、指派人、状态、租约 |
| Run | 一次具体执行 | session 引用、耗时、成本、日志 |
| Event | 审计事件 | 追加写、序号、类型、负载 |
| Artifact | 产物 | 类型、URI、哈希、大小 |
| Decision | 人类或 CEO 的决策记录 | 问题、选项、选择、理由、时间 |
| Approval | 人工闸门 | 动作、风险、状态、决定 |
| SessionRef | harness 原生会话引用 | session id、cwd、模型、版本、过期时间 |
| PositionMemory | 职位长期记忆 | playbook、项目事实、决策、开放问题、交接 |
| ContextPack | 一次派工组装出的上下文 | 任务、记忆、相关报告、工作区状态 |

CEO 本身也是一个 Position，`role=ceo`，拥有管理工具。它仍然遵守“一个 harness 实例 = 一个职位”。

## 5. 人类入口：CEO Harness

### 5.1 沟通方式

用户直接在 CEO harness 的聊天窗口输入自然语言。CEO 用 Markdown 回复，必要时用表格、列表和选项。

典型消息类型：

| 类型 | 内容 | 用户动作 |
|---|---|---|
| 计划卡 | 目标拆成哪些任务、谁负责、依赖、预算 | 批准或调整 |
| 进度摘要 | 谁在做什么、完成了什么、哪里卡住 | 一般不用回 |
| 决策卡 | 问题、选项、推荐、影响、截止时间 | 回复选项或补充要求 |
| 最终报告 | 结果、证据、产物、遗留风险 | 验收 |
| 告警 | 超预算、节点掉线、连续失败 | 决定继续/停止 |

示例：

```text
你：给官网加一个定价页，周五前上线。

CEO：我拆成 4 个工作包：
     1. 定价页 UI（frontend-1 / Claude Code）
     2. 价格配置接口（backend-1 / opencode）
     3. 测试与验收（qa-1 / pi agent）
     4. 部署预览（ops-1 / opencode，远程）
     预算 90 分钟 / $8。
     需要你确认：年付折扣用 8 折还是 85 折？
```

### 5.2 CEO 工具接口

CEO 通过工具管理公司，不靠手工拼命令：

```text
company.brief()                 # 员工手册、组织架构、预算、政策
company.status()                # 当前谁在做什么
company.inbox()                 # 完成/阻塞/待决策的增量
company.threads.list()          # 目标线程
company.plan.create()           # 创建任务 DAG
company.task.assign()           # 派工
company.task.continue()         # 同一任务追加要求
company.task.reopen()           # 返工
company.task.cancel()
company.task.wait()             # 可选，带超时
company.decision.request()      # 生成决策卡
company.decision.resolve()      # 记录人类决定
company.position.hire()         # 招聘职位
company.position.pause() / fire()
company.node.list() / enroll() / revoke()
```

`assign` 立即返回任务 ID，不阻塞 CEO 的聊天回合。需要等待时用 `wait` 带超时；长任务结果进入 `inbox`，下次对话汇报。

在 MCP 中，工具名使用下划线形式，例如 `company_brief`、`company_plan_create`、`company_task_assign`；上面的点号只是逻辑分组。

### 5.3 CEO 守则

CEO harness 需要一段固定的 system prompt / skill：

- 你是 CEO，不是执行者；先计划，再派工。
- 每张任务必须有验收标准。
- 用工具查事实，不编造状态。
- 员工不能直接找人类；只有你能向人类汇报。
- 需要人类决定时，给选项、推荐、影响和截止时间。
- 不把员工日志全塞进上下文，只看报告、摘要和证据。
- 记录关键决策，保证重启后可恢复。
- 不泄露密钥，不绕过审批。

### 5.4 主动通知的限制

当前 CEO harness 的对话是回合制的。任务完成时，如果用户不在对话中，CEO 不能凭空弹消息。

- **现在**：下次用户说话时，CEO 调 `company.inbox()` 汇报增量。
- **后期**：IM/语音桥接入后，才有真正的主动推送。

## 6. Company Runtime

Runtime 是无界面的后台服务，核心职责：

- 持久化公司、职位、任务、决策、产物。
- 维护任务状态机和依赖 DAG。
- 管理 Position 的 session 引用和上下文包。
- 执行调度、租约、重试、超时、预算。
- 连接本机和远程 Node Agent。
- 执行审批策略并写审计日志。

推荐使用 SQLite WAL + 单进程调度器。单用户、单机场景不需要 Redis 或消息队列；先把状态机做正确。

Runtime 的 API 可以同时暴露为：

- MCP server（CEO harness 首选）。
- HTTP/JSON-RPC（远程管理、调试、未来 IM 桥）。
- CLI（运维和测试）。

## 7. Position 与 Harness

### 7.1 定义

```text
Position = Harness 实例
         + 角色提示词
         + 独立工作区
         + 独立配置/凭证
         + 权限策略
         + 预算
```

同一个 Claude Code 跑两个职位，就是两个独立实例、两个独立 session，不共享会话。

职位内部如果 harness 自己开了 subagent，不算公司职位；公司只调度 Position。

### 7.2 适配器接口

```ts
type HarnessEvent =
  | { type: "status"; state: "starting" | "running" | "done" | "failed" }
  | { type: "message"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "approval_request"; action: string; risk: "low" | "medium" | "high" }
  | { type: "question"; text: string }
  | { type: "artifact"; kind: string; uri: string; sha256?: string }
  | { type: "usage"; tokens?: number; costUsd?: number };

interface HarnessAdapter {
  readonly kind: string;
  probe(): Promise<HarnessCapabilities>;
  start(input: RunInput): Promise<RunHandle>;
  events(handle: RunHandle): AsyncIterable<HarnessEvent>;
  cancel(handle: RunHandle): Promise<void>;
  resume?(sessionRef: string, input: RunInput): Promise<RunHandle>;
}
```

适配规则：

- CLI 优先，使用参数数组启动，不拼 shell。
- 每个职位独立 `HOME`/配置目录，避免凭证和 session 串线。
- 解析 JSONL 输出，处理半行、断线、stderr 限流。
- 把 harness 的权限询问桥接成 `approval_request`。
- 进程树要能整体杀掉，Windows 下尤其注意子进程。
- 启动时 `probe()` 记录版本和能力；adapter 升级要跑契约测试。

候选适配器：

| 职位 | Harness | 方式 |
|---|---|---|
| CEO | DSH / DeepSeek | 原生 runtime + 管理工具 |
| 前端/后端 | Claude Code | 非交互 JSON 流 + session resume |
| 需要实时审批 | Claude SDK | `canUseTool` 暂停 + decision 批准 |
| 全栈/脚本 | opencode | CLI 适配器 |
| 调研/文档 | pi | `-p --mode json` + `--session-id` |
| 兜底 | 任意 CLI | 可配置命令、输入方式、JSONL 解析器（后续） |

具体参数以本机 `--help` 为准，不硬编码某个版本的 flag。

M1 实测：opencode `1.18.35` 使用 `run --format json`、`--session` 恢复；Claude Code `2.1.304` 使用 `-p --output-format stream-json`、`--resume`；pi `1.2.0` 使用 `-p --mode json`、`--session-id`。三者均完成真实 session 连续和代码修改验证。

M4 新增 `claude-sdk` adapter：通过 Claude Agent SDK 的 `canUseTool` 在工具执行前暂停，创建 decision 并等待人类批准/拒绝；pi/opencode 仍使用执行前审批 + 工具白名单。

### 7.3 职位生命周期

```text
hired → idle → busy → waiting_input / waiting_approval
                 ↘ paused → idle
                 ↘ offline → idle
                 ↘ fired
```

默认一个职位同时只跑一个任务。需要并行就增加职位，而不是让一个职位同时开多个会话。

## 8. 会话与上下文连续性

### 8.1 三层会话

| 层 | 形态 | 存储 | 生命周期 |
|---|---|---|---|
| 人类 ↔ CEO | 自然语言 thread | CEO harness 原生会话 + Runtime 的 thread 摘要 | 长期 |
| CEO ↔ Position | 任务单 / 报告 / 上下文包 | `tasks` / `runs` / `events` / `context_packs` | 任务期 |
| Position ↔ Harness | 原生 session | `session_refs` | 可过期 |

不要把三层合成一个无限长的聊天。

### 8.2 核心原则：session 是缓存，不是记忆

原生 session 可能因为以下原因失效：

- 过期；
- 模型或 harness 版本变化；
- 工作目录变化；
- 上下文窗口溢出；
- 进程崩溃；
- 职位迁移到另一台电脑；
- 换 harness。

真正的记忆必须是：

```text
任务线程 + Position Memory + git 分支/产物
```

能 resume 就 resume，不能 resume 就按记忆重建，结果必须一致。

### 8.3 Position Memory

每个职位有一份结构化记忆，存在 Runtime，并以文件形式注入工作区：

```text
.aic/
  POSITION.md    # 角色、职责、工作习惯、禁止事项
  THREAD.md      # 当前目标、任务线程、关键决策
  DECISIONS.md   # 追加写：决定了什么、为什么
  HANDOFF.md     # 最近一次交接：做到哪、下一步、未解决问题
```

这些文件是 harness 无关的。Claude Code、opencode、pi agent 都能读；换 harness、换电脑，记忆都在。

只放长期有用的内容，不放完整聊天记录和所有工具日志。

### 8.4 Context Pack

每次派工由 Runtime 组装：

1. 职位角色和 playbook；
2. 公司/项目政策；
3. 当前任务、验收标准、约束；
4. 任务线程摘要；
5. 相关历史任务报告；
6. 已确认的决策；
7. 工作区状态：分支、已有 diff、测试结果；
8. 本次新增指令，以及“上次之后发生了什么”；
9. 明确的“不要重做”清单。

Context Pack 有 token 预算，靠检索选取，不靠堆全量。涉及密钥的内容先脱敏。

### 8.5 continue / reopen / new task

| 场景 | 操作 | 会话策略 | 上下文 |
|---|---|---|---|
| 任务未验收，追加要求 | `continue` | 优先 resume，失败重建 | 原任务 + 新增指令 |
| 已完成，但发现缺陷 | `reopen` | 同分支，新 Run | 原报告 + 缺陷证据 |
| 新任务，但相关 | `assign` 新任务 | 新 session | 职位记忆 + 相关报告 |
| 新任务，不相关 | `assign` 新任务 | 新 session | 只带角色/项目记忆 |

同一任务继续的流程：

```text
CEO → Runtime: continue(T-104, "年付改成 8 折")
Runtime: 加载 thread + memory + branch
  ├─ session_ref 有效 → adapter.resume(session_ref, delta)
  └─ session_ref 失效 → adapter.start(context_pack)
Position: 执行 → 更新分支 → 写 HANDOFF
Runtime: 保存报告 → 更新记忆 → 放进 inbox
CEO: 下次对话时汇报
```

resume 的有效条件至少包括：同一 harness、同一模型、同一工作目录、版本兼容、未过期、`context_hash` 没有严重漂移。任何一条不满足就重建。

### 8.6 等待与抢占

- **waiting_input**：Position 在等 CEO 回答。能保持进程/session 就保持；超时则 checkpoint。
- **waiting_approval**：先 checkpoint，释放并发槽位，批准后恢复。
- **被抢占**：CEO 发 `pause_and_handoff`，Position 提交 WIP、写 HANDOFF，再切换去做更急的任务；之后用 `resume_task` 回来。

### 8.7 跨机器、跨 harness

原生 session 不可移植。跨机器时：

1. Position 把分支推到共享 git；
2. 产物上传到 artifact store；
3. Position Memory 同步到 Runtime；
4. 新节点 checkout 分支，注入 Context Pack；
5. 新 harness 从文件记忆和报告重建上下文。

职位身份不变，相当于“员工换了一张办公桌”。

### 8.8 失败兜底

| 故障 | 处理 |
|---|---|
| resume 失败/过期 | 用 Context Pack 重建 |
| 上下文快满了 | 先写 HANDOFF，再开新 session，不依赖自动压缩 |
| 进程崩溃 | 从最后一个 commit / checkpoint 恢复 |
| 节点掉线 | 租约过期，任务重新排队，换节点重建 |
| 记忆和 session 不一致 | `context_hash` 不匹配，拒绝 resume，重建 |
| harness 升级 | 旧 session 标记失效，跑契约测试后重建 |

## 9. 任务协议

### 9.1 任务单 `task/v1`

```json
{
  "schema": "task/v1",
  "task_id": "T-104",
  "company_id": "c_1",
  "project_id": "p_web",
  "thread_id": "th_pricing",
  "assignee": "frontend-1",
  "title": "实现定价页",
  "objective": "在官网新增 /pricing，三档价格，支持月付/年付切换",
  "context": "品牌规范见 artifact:art_123；现有组件见 repo web",
  "depends_on": ["T-103"],
  "inputs": [
    { "kind": "artifact", "id": "art_123", "sha256": "..." },
    { "kind": "git_ref", "repo": "web", "ref": "main@abc123" }
  ],
  "acceptance": [
    "桌面端和移动端均可用",
    "pnpm test 通过",
    "不引入新的运行时依赖"
  ],
  "constraints": {
    "write_scope": ["apps/web/src/pricing/**"],
    "network": "model_api_only",
    "approval": "destructive_ops"
  },
  "budget": { "minutes": 45, "usd": 3 },
  "deadline": "2026-10-21T18:00:00+08:00",
  "report_schema": "report/v1"
}
```

### 9.2 报告 `report/v1`

```json
{
  "schema": "report/v1",
  "task_id": "T-104",
  "status": "done",
  "summary": "新增定价页与月付/年付切换，已补测试",
  "changes": [
    { "repo": "web", "branch": "task/T-104", "commit": "def456" }
  ],
  "evidence": [
    { "kind": "test", "command": "pnpm test", "result": "pass" },
    { "kind": "screenshot", "artifact": "art_456" }
  ],
  "handoff": {
    "state": "页面已完成，文案已确认",
    "open_issues": [],
    "next_steps": ["QA 回归", "合并到 integration"]
  },
  "risks": ["年付折扣文案待市场确认"],
  "next": ["合并到 integration 分支", "QA 回归"]
}
```

`status` 只允许：`done | blocked | needs_decision | failed`。

### 9.3 交接单

每个 Run 结束必须写 `HANDOFF.md` 或等价结构化交接：

- 做到哪一步；
- 分支和 commit；
- 未解决问题；
- 下一步；
- 需要谁决策；
- 相关产物引用。

没有交接单的 Run 不算完成。

## 10. 调度、质量与安全

### 10.1 派工

硬过滤：节点在线、harness 能力匹配、项目权限、预算足够、依赖已完成。

软评分：技能匹配、历史成功率、当前负载、延迟、成本。

### 10.2 代码隔离

```text
repo cache
  ├─ worktree/T-104  → frontend-1
  ├─ worktree/T-105  → backend-1
  └─ integration     → 合并队列
```

任务声明写入范围，完成后提交分支，进入合并队列。QA 或独立 reviewer 验收，CEO 做最终验收。作者和 reviewer 尽量用不同 harness。

### 10.3 安全闸门

- 删除、强制推送、生产部署、对外发消息、花钱，默认需要人类批准。
- 密钥只存在节点本地，不进入 CEO 上下文，也不进入任务单。
- 每个职位有权限档案：只读、可写工作区、可联网、可部署。
- 所有工具调用、审批、产物写审计日志。
- 远程节点是按设计可执行代码的高危组件，必须按最小权限对待。

### 10.4 成本与死循环控制

- 每任务预算：时间、金额、最大轮次。
- 每职位日预算、公司月预算。
- 重试最多两次，且必须带新信息；否则转派或升级。
- 任务租约和幂等键，防止节点断线后重复执行。

## 11. 多电脑

每台电脑安装一个 Node Agent，作为系统服务运行：

```text
pnpm cli node:join --server http://ceo.example.com:4317 --token <一次性令牌> \
  --name laptop-b --workspace D:\aic-node
```

M2 实际传输是“节点主动外连 + HTTP 拉取/心跳”，不要求控制平面开放入站端口到节点：

1. 控制平面创建一次性注册令牌（30 分钟、单次使用）。
2. 节点用令牌注册，拿到自己的 node token；之后所有请求带 `Authorization: Bearer`。
3. 节点每 2 秒心跳，上报 harness 列表和并发信息。
4. 节点每 1 秒拉取任务；控制平面用任务租约（默认 60 秒）防止重复执行。
5. 节点执行期间续租；完成后回传报告、session id、测试文本和 diff 产物。
6. 心跳停止或租约过期，任务自动回到 `assigned`，等待重新领取。
7. 产物写入控制平面 `.aic/artifacts/remote-*`；git 分支需要共享远端仓库时再推送。

CEO 通过 `company_node_*` 工具管理远程节点：招聘职位、派活、排空（drain）、撤销令牌（revoke）。

网络建议：M2 用 Tailscale/WireGuard 组网，`pnpm serve --host 0.0.0.0` 只监听内网/Tailscale；M2 没有内建 TLS，不要直接暴露公网。后续可把 HTTP 拉取替换为 WSS，协议语义不变。

## 12. IM 与语音（后期）

```text
IM / 语音
   │  Ingress（鉴权、身份映射、转文字）
   ▼
CEO Harness（同一个 CEO，同一个 thread）
   │  Egress（回复、通知、TTS）
   ▼
IM / 语音
```

规则：

- 桥只和 CEO 对话，不能直接调用 `company.*` 工具，否则绕过了 CEO。
- IM 消息映射到某个 thread；群聊要标明谁在说话。
- 语音先 STT 转文字，再走同一个 Ingress；回复可 TTS。
- 需要 CEO harness 支持无头会话，否则桥只能在窗口开着时工作。

## 13. 技术栈与目录

建议 TypeScript 全栈，先单体：

| 层 | 选型 |
|---|---|
| Runtime | Node.js 22+ + TypeScript |
| 服务 | 内置 `node:http` + MCP SDK（M0）；需要时再引入 Fastify/ws |
| 数据库 | SQLite WAL + 内置 `node:sqlite`（M0）；Drizzle/Postgres 后置 |
| 队列 | SQLite 租约表，先不引入 Redis |
| CEO 工具 | MCP server；CLI shim 兜底 |
| CLI | commander |
| 进程 | execa，参数数组，进程树清理（M1） |
| 日志 | 结构化事件表 + pino/JSONL（M1） |
| 测试 | Vitest + Fake Harness + MCP stdio 集成测试 |

M0 先用单包结构，避免过早拆包；M1 引入真实 adapter 和 node-agent 时再拆：

```text
src/
  domain/            # 领域模型、Zod schema、状态机
  store/             # SQLite + 仓储
  service/           # CompanyService、上下文包、任务执行
  adapters/          # fake / opencode / claude-code / pi / 进程与提示词
  workspace/         # git worktree、提交、diff 产物
  node/              # Node Agent、远程协议、远程执行器
  cli.ts             # aic 命令
  demo.ts            # Fake 端到端演示
  demo-opencode.ts   # opencode 真实闭环演示
  demo-multi-node.ts # 双节点 HTTP 演示
  mcp-server.ts      # MCP stdio server
  http-server.ts     # HTTP API + 节点端点
tests/               # 状态机、服务、adapter、worktree、session、MCP、多节点
ceo-skill/           # CEO 守则、工具说明
docs/                # 架构、路线、进展
```

M1 已落地：Claude Code / pi / opencode 三个真实 adapter、自动发现与密钥环境注入、`GitWorkspaceManager`、session resume/回退、测试证据、任务级审批闸门和工具白名单。

MVP 打包成一个 `aic` 可执行文件：启动后同时提供 Runtime API、MCP server 和本机 Node Agent。默认数据库是 `./.aic/company.db`，可用 `AIC_DB_PATH` 覆盖；产物放 `./.aic/artifacts/`。

## 14. 主要风险

| 风险 | 应对 |
|---|---|
| CEO 上下文爆炸 | 结构化报告 + 摘要 + 按引用拉取日志 |
| LLM 规划不稳定 | 控制平面确定性执行，限制重规划和重试 |
| 原生 session 不可靠 | session 只做缓存，Context Pack 可重建 |
| CLI 参数随版本变化 | Adapter 契约测试 + `probe()` + 通用兜底适配器 |
| 权限询问卡死 | 非交互模式 + 审批桥 + 超时拒绝 |
| 多职位同时改代码 | worktree + 写范围声明 + 合并队列 |
| 远程节点被攻破 | 出站连接、签名任务、最小权限、审计、可撤销令牌 |
| 成本失控 | 任务/职位/公司三级预算，硬停 |
| CEO 单点故障 | 状态持久化、重启恢复；高可用后置 |
| 订阅/API 条款 | 每职位独立账号或 API key，不绕过供应商限制 |

## 15. 默认决策与待确认项

已确定：

- CEO harness 是唯一人类入口。
- 不做独立聊天软件。
- Company Runtime 无界面，优先独立后台服务。
- 先单机闭环，再多电脑。
- Position 使用“长员工、短会话”，session 只做缓存。

默认值（可调整）：

- CEO harness：当前 DSH / DeepSeek。
- Runtime：SQLite + 单进程调度。
- 首批员工：Claude Code、opencode、pi agent。
- 远程组网：Tailscale/WireGuard。
- 可视化：先用 CEO 聊天里的文本组织图，不做 Web 主界面。

待实现阶段确认：

- 首批 harness 的实际安装情况和版本。
- 本机是否使用嵌入模式，还是一开始就用守护进程。
- 远程节点是否需要跨公网，还是先局域网/Tailscale。
