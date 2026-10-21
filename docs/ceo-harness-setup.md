# CEO Harness 接入指南

> M0 使用 MCP stdio 暴露 `company_*` 工具。CEO harness 需要支持 MCP 或能调用 CLI。
> 人类入口仍然是 CEO harness，不新增聊天软件。

## 1. 启动方式

### 方式 A：MCP stdio（推荐）

CEO harness 通过 stdio 启动：

```bash
node D:/tmp/b/node_modules/tsx/dist/cli.mjs D:/tmp/b/src/cli.ts mcp
```

通用 MCP 配置：

```json
{
  "mcpServers": {
    "ai-company": {
      "command": "node",
      "args": [
        "D:/tmp/b/node_modules/tsx/dist/cli.mjs",
        "D:/tmp/b/src/cli.ts",
        "mcp"
      ],
      "env": {
        "AIC_DB_PATH": "D:/tmp/b/.aic/company.db"
      }
    }
  }
}
```

把路径替换成实际仓库路径。`AIC_DB_PATH` 可选；默认是 `./.aic/company.db`。

### 方式 B：CLI 工具桥（MCP 不可用时）

CEO harness 可以通过 shell 调：

```bash
pnpm cli brief
pnpm cli status
pnpm cli inbox
pnpm cli demo
pnpm cli probe
```

CLI 和 MCP 读写同一个 SQLite 数据库，可以混用。

## 2. 验证接入

让 CEO harness 调用：

1. `company_brief`：应返回公司手册、职位和最近线程。
2. `company_adapters`：应返回 fake、claude-code、pi、opencode 的版本/能力。
3. `company_demo`：应跑通一次 Fake 链路，并返回 3 份报告。
4. 真实 harness：`pnpm demo:harnesses` / `demo:sessions` / `demo:code`，会产生模型费用。

或者命令行验证：

```bash
pnpm test
pnpm demo
pnpm probe
pnpm demo:harnesses
pnpm demo:sessions
pnpm demo:code
pnpm demo:opencode
```

## 3. 当前 DSH 会话

M1 的运行时已经通过 MCP 客户端测试验证。若当前 DSH 版本支持 MCP server 配置，把上面的 JSON 加入其 MCP 配置即可。

如果当前 DSH 版本暂不支持 MCP，仍可用 CLI 桥让 CEO 调用同样的能力；后续再按 DSH 的插件/工具接口做原生适配。

## 4. 工具清单

| 工具 | 用途 |
|---|---|
| `company_brief` | 公司手册、组织架构、职位、线程 |
| `company_status` | 谁在做什么 |
| `company_inbox` | 最近报告、阻塞、待决策 |
| `company_threads` | 目标线程 |
| `company_plan_create` | 创建任务 DAG |
| `company_task_assign` | 指派单个任务 |
| `company_task_assign_all` | 指派所有有负责人的排队任务 |
| `company_run_ready` | 执行依赖已满足的任务 |
| `company_task_continue` | 同一任务追加要求 |
| `company_task_reopen` | 返工 |
| `company_task_cancel` | 取消任务 |
| `company_task_wait` | 短超时等待 |
| `company_decision_request` | 创建决策卡 |
| `company_decision_resolve` | 记录人类选择 |
| `company_position_hire` | 招聘职位 |
| `company_position_pause` | 暂停职位 |
| `company_position_fire` | 解雇职位 |
| `company_node_list` | 节点/办公室列表、在线状态、职位、活动任务 |
| `company_node_enroll` | 创建一次性节点注册令牌 |
| `company_node_drain` | 排空节点，停止接收新任务 |
| `company_node_revoke` | 撤销节点 token |
| `company_adapters` | 探测 fake / claude-code / claude-sdk / pi / opencode 适配器能力 |
| `company_budget_status` | 公司/职位预算与花费 |
| `company_set_company_budget` | 设置公司 USD 预算 |
| `company_set_position_budget` | 设置职位 USD 预算 |
| `company_metrics` | 任务、运行、成本、重试、节点、merge queue 指标 |
| `company_memory_search` | 搜索员工手册、Position Memory、thread |
| `company_task_retry` | 手动重试 failed/blocked 任务 |
| `company_review_request` | 创建独立 review task + merge queue |
| `company_merge_queue` | 查看合并队列 |
| `company_merge_approve` | 批准 ready 的合并条目 |
| `company_merge_reject` | 拒绝合并条目 |
| `company_demo` | M0 Fake 端到端演示 |

M1 真实执行说明：

- `company_position_hire` 可以创建 `harness_kind: "claude-code" | "claude-sdk" | "pi" | "opencode"` 的职位，`workspace` 指向一个 git 仓库。`claude-sdk` 支持工具执行中的实时人工审批。
- 本机会自动发现：nvm 中的 Claude Code、WorkBuddy 内置的 pi、scoop 的 opencode；也可用 `AIC_CLAUDE_COMMAND` / `AIC_PI_COMMAND` / `AIC_OPENCODE_COMMAND` 覆盖。
- 任务会使用独立 worktree；`constraints.test_command` 会在任务完成后执行并写入证据。
- `constraints.requires_approval: true` 会让任务先进入 `waiting_approval`，由 CEO 生成决策卡，人类批准后才执行。
- `constraints.allowed_tools` / `constraints.denied_tools` 会映射到 Claude 的 `--allowedTools` / `--disallowedTools` 和 pi 的 `--tools`。
- `constraints.base_ref` 可以让 QA 任务从 dev 分支创建 worktree。
- MCP server 已注册所有发现的真实 harness；真实任务会产生模型费用。

M2 多节点说明：

- `company_node_enroll` 生成一次性注册令牌；在另一台电脑运行 `pnpm cli node:join --server ... --token ... --workspace ...`。
- `company_position_hire` 传入 `node_id` 即可在远程节点招聘；`workspace` 建议用相对路径，由节点在自己的 workspace root 下解析。
- `company_run_ready` 会把远程任务放入租约队列；节点领取后执行，完成后回传报告和产物。
- `company_node_drain` / `company_node_revoke` 用于排空和撤销节点。
- 详见 [multi-node.md](multi-node.md)。

M4 质量与成本：

- 派工前检查 `company_budget_status`；USD 或分钟预算耗尽都会硬停。
- 任务可设置 `max_retries`；失败自动重试，也可 `company_task_retry`。
- 完成后 `company_review_request` 创建独立 reviewer 任务并自动派工；review 通过后 `company_merge_approve` 会对本地 repo 执行 ff-only merge。
- `company_metrics` 看成本/耗时/成功率；`company_memory_search` 检索历史决策。
- `claude-sdk` 职位在工具执行前通过 `canUseTool` 暂停，CEO/人类用 `decision:resolve` 或 HTTP 批准；详见 [operations.md](operations.md)。
- 单文件打包 `pnpm build:sea`；服务安装 `service:install`；备份/恢复、日志清理见 [operations.md](operations.md)。

## 5. 安全边界

- MCP stdio 只在本机进程间通信，不监听网络端口。
- HTTP API 默认只绑定 `127.0.0.1`，用于调试和未来 IM Ingress。
- CEO 是唯一人类入口；工具不能给员工开人类聊天通道。
- 不要在不信任的 MCP 客户端里加载这个 server；它会读写本地 SQLite 和 `.aic/` 工作区。
