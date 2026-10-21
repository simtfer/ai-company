# AI Company

一个由 CEO harness 统一管理的 AI 公司运行时。

- 你只在 CEO harness 里说话，不打开第二个聊天软件。
- CEO 负责拆任务、派工、验收和汇报。
- 一个 harness 实例就是一个职位（Position）。
- Company Runtime 是无界面后台，负责任务、会话、审批、审计和节点。

当前进度：**M4 核心完成**，M3 IM/语音暂缓。Claude Code、pi、opencode 均已实机验证；支持 worktree、测试证据、session 恢复、多电脑节点、预算、重试、独立评审/合并队列、指标、记忆检索和备份恢复。

## 快速开始

```bash
pnpm install
pnpm demo          # Fake Harness 闭环
pnpm test          # 31 个测试
pnpm probe         # 探测 fake / claude-code / pi / opencode
```

真实 harness 演示（会消耗少量模型额度）：

```bash
pnpm demo:harnesses   # 三个 harness 各回一个 token
pnpm demo:sessions    # 三个 harness 各做一次 session 连续
pnpm demo:code        # Claude Code 和 pi 真实修改代码
pnpm demo:opencode    # opencode dev + QA 闭环
pnpm demo:multi-node  # 两个 Node Agent 远程执行
pnpm test:ceo-pi      # Claude Code CEO × 两个真实 pi 职位，多轮任务
pnpm test:opencode-acp # opencode ACP 实时权限桥
pnpm test:pi-live     # pi tool_call 实时权限桥
```

其他命令：

```bash
pnpm cli init       # 初始化并查看公司 brief
pnpm cli status     # 当前谁在做什么
pnpm cli inbox      # 最近报告和待决策
pnpm cli threads    # 目标线程
pnpm cli node:token # 创建一次性节点注册令牌
pnpm cli node:join  # 在另一台电脑加入节点
pnpm cli metrics    # 任务/运行/成本/重试/节点指标
pnpm cli budget     # 公司/职位预算
pnpm cli decision:list                 # 待审批工具/决策
pnpm cli decision:resolve <id> 允许     # 实时批准工具调用
pnpm cli backup --out D:\backups\ai-company.db
pnpm cli restore --from D:\backups\ai-company.db
pnpm build:sea      # 打包 dist/aic.exe（当前平台单文件）
pnpm cli service:install --apply   # Windows 计划任务 / Linux systemd
pnpm mcp            # 启动 MCP stdio server，供 CEO harness 调用
pnpm serve          # 启动 HTTP API（默认 127.0.0.1:4317）
pnpm serve --host 0.0.0.0 --port 4317   # 跨机器时绑定内网/Tailscale
```

## CEO harness 接入

MCP 配置示例：

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

详见 [docs/ceo-harness-setup.md](docs/ceo-harness-setup.md) 和 [ceo-skill/SKILL.md](ceo-skill/SKILL.md)。

## 文档

- [docs/README.md](docs/README.md)：文档索引
- [docs/architecture.md](docs/architecture.md)：总体架构
- [docs/roadmap.md](docs/roadmap.md)：D0–M4 路线
- [docs/progress.md](docs/progress.md)：阶段进展
- [docs/ceo-harness-setup.md](docs/ceo-harness-setup.md)：MCP 接入说明
- [docs/multi-node.md](docs/multi-node.md)：多电脑节点部署与节点管理
- [docs/operations.md](docs/operations.md)：预算、指标、评审/合并、备份恢复和运维
- [docs/ceo-pi-test.md](docs/ceo-pi-test.md)：Claude Code CEO × 两个 pi 职位多轮实测报告

## M4 已实现

- 公司/职位/任务三级 USD + 分钟预算；派工前硬停。
- `max_retries` 自动重试 + `company_task_retry` 手动重试。
- 独立 review task 自动派给 reviewer + merge queue（pending_review / ready / merged / rejected）。
- `company_merge_approve` 对本地 repo 执行 `git merge --ff-only`；不可用 repo 保留审计状态。
- `company_integration_create` 把同一 thread 的多个已完成任务分支合入 `integration/<thread>`，合并后重跑全量测试。
- 远程节点可通过 `push_remote` 推送分支到共享 remote；集成前自动 fetch。
- **实时权限桥**：`claude-sdk` 使用 `canUseTool`；`opencode-acp` 使用 ACP `session/request_permission`；`pi-live` 使用 pi 扩展 `tool_call` 钩子；工具执行前暂停，等待 `decision:resolve` 或 HTTP 审批。
- `decision:list` / `decision:resolve <id> 允许|拒绝`。
- `company_metrics`：任务、运行、耗时、token/成本、重试、节点、预算。
- `company_memory_search`：员工手册、Position Memory、thread 摘要。
- SQLite `VACUUM INTO` 备份、`restore`、`logs:prune`。
- `pnpm build:sea` 生成当前平台单文件 `dist/aic.exe`。
- `service:install` 生成/安装 Windows 计划任务或 Linux systemd unit。
- `bin/aic.mjs` 入口和 [docs/operations.md](docs/operations.md)。

## M2 已实现

- Node Agent：注册、心跳、claim、events、complete、租约续期。
- 一次性 enrollment token（30 分钟、单次使用）+ node token。
- 远程任务租约、过期重排、断线后重新领取。
- 远程测试文本和 diff 产物回写控制平面。
- 节点管理：`company_node_enroll`、`company_node_list`、`company_node_drain`、`company_node_revoke`。
- 远程职位支持 `node_id` 和相对 workspace。
- 本机双节点演示：`pnpm demo:multi-node`。
- 文档：[docs/multi-node.md](docs/multi-node.md)。

## M1 已实现

- `OpencodeAdapter`：真实 opencode JSONL 事件、session id、token/cost、tool 事件。
- `ClaudeCodeAdapter`：真实 Claude Code 2.1.304，stream-json、session、token/cost、tool 事件。
- `PiAdapter`：真实 pi 1.2.0，JSON 事件、session、usage、tool 事件。
- 自动发现非 PATH 安装：Claude Code（nvm）、pi（WorkBuddy 内置 Node）、opencode（scoop）。
- 自动加载 Windows 用户环境变量中的模型密钥，不落日志。
- 每个真实任务使用独立 git worktree；完成后自动提交、生成 diff 产物。
- Session Manager：有效 session 走 resume，过期/失败自动回退到 Context Pack 重建；三种 harness 均已实测。
- 任务级 `test_command`：测试通过/失败进入报告证据，并影响任务状态。
- 执行前审批闸门 + 工具白名单：`requires_approval`、`allowed_tools`、`denied_tools`。
- 运行事件写入 SQLite 和 `.aic/logs/<run_id>.jsonl`。
- 超时、预算分钟数、任务级产物登记。
- 真实 opencode 演示：`opencode-dev` 修改代码，`opencode-qa` 从 dev 分支验收并跑测试。
- 真实 Claude/pi 演示：分别修改 `hello.mjs` 和测试，`node --test` 通过。

## M0 已实现

- SQLite 持久化：公司、职位、线程、任务 DAG、运行、报告、决策、会话引用、职位记忆、产物。
- 任务状态机和依赖检查。
- `CompanyService`：计划、指派、执行、继续、返工、取消、决策、招聘、暂停、解雇。
- Fake Harness：按任务约束返回 done / blocked / needs_decision / failed。
- MCP stdio server：`company_*` 工具。
- HTTP API：本地调试和未来 IM 入口。

## 当前未包含

- IM / 语音：M3 暂缓，以后再做。
- Web 聊天界面。
