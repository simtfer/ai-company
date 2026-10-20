# AI Company

一个由 CEO harness 统一管理的 AI 公司运行时。

- 你只在 CEO harness 里说话，不打开第二个聊天软件。
- CEO 负责拆任务、派工、验收和汇报。
- 一个 harness 实例就是一个职位（Position）。
- Company Runtime 是无界面后台，负责任务、会话、审批、审计和节点。

当前进度：**M1 核心完成**。opencode 已作为两个真实 Position（开发 + QA）跑通任务、worktree、测试证据和 session 连续；Claude Code 适配器已实现，但本机未安装，属于实验性。

## 快速开始

```bash
pnpm install
pnpm demo          # Fake Harness 闭环
pnpm test          # 17 个测试
pnpm probe         # 探测 fake / opencode 适配器
```

真实 opencode 演示（需要本机 opencode 已登录，会消耗少量模型额度）：

```bash
pnpm demo:opencode
```

其他命令：

```bash
pnpm cli init       # 初始化并查看公司 brief
pnpm cli status     # 当前谁在做什么
pnpm cli inbox      # 最近报告和待决策
pnpm cli threads    # 目标线程
pnpm mcp            # 启动 MCP stdio server，供 CEO harness 调用
pnpm serve          # 启动本地 HTTP API（默认 127.0.0.1:4317）
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

## M1 已实现

- `OpencodeAdapter`：真实 opencode JSONL 事件、session id、token/cost、tool 事件。
- `ClaudeCodeAdapter`：实验性适配器；本机没有 `claude` 二进制，尚未做真实验证。
- 每个真实任务使用独立 git worktree；完成后自动提交、生成 diff 产物。
- Session Manager：有效 session 走 resume，过期/失败自动回退到 Context Pack 重建。
- 任务级 `test_command`：测试通过/失败进入报告证据，并影响任务状态。
- 执行前审批闸门：`requires_approval` 的任务先进入 `waiting_approval`，批准后才派工。
- 运行事件写入 SQLite 和 `.aic/logs/<run_id>.jsonl`。
- 超时、预算分钟数、任务级产物登记。
- 真实 opencode 演示：`opencode-dev` 修改代码，`opencode-qa` 从 dev 分支验收并跑测试。

## M0 已实现

- SQLite 持久化：公司、职位、线程、任务 DAG、运行、报告、决策、会话引用、职位记忆、产物。
- 任务状态机和依赖检查。
- `CompanyService`：计划、指派、执行、继续、返工、取消、决策、招聘、暂停、解雇。
- Fake Harness：按任务约束返回 done / blocked / needs_decision / failed。
- MCP stdio server：`company_*` 工具。
- HTTP API：本地调试和未来 IM 入口。

## 当前未包含

- 远程 Node Agent（M2）。
- IM / 语音（M3）。
- Web 聊天界面。
- 已验证的 Claude Code / pi 真实环境（M1 后续补测）。
