# AI Company

一个由 CEO harness 统一管理的 AI 公司运行时。

- 你只在 CEO harness 里说话，不打开第二个聊天软件。
- CEO 负责拆任务、派工、验收和汇报。
- 一个 harness 实例就是一个职位（Position）。
- Company Runtime 是无界面后台，负责任务、会话、审批、审计和节点。

当前进度：**M0 已完成**。用 Fake Harness 跑通了“目标 → 计划 → 派工 → 报告 → CEO 汇总”的闭环。

## 快速开始

```bash
pnpm install
pnpm demo
pnpm test
```

`pnpm demo` 会在 `.aic/company.db` 中创建公司数据，并跑一次包含前端、后端、QA 的假任务。

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

## M0 已实现

- SQLite 持久化：公司、职位、线程、任务 DAG、运行、报告、决策、会话引用、职位记忆、产物。
- 任务状态机和依赖检查。
- `CompanyService`：计划、指派、执行、继续、返工、取消、决策、招聘、暂停、解雇。
- Fake Harness：按任务约束返回 done / blocked / needs_decision / failed。
- Context Pack + SessionRef：为 M1 的真实 session 恢复和跨机器重建打底。
- MCP stdio server：`company_*` 工具。
- HTTP API：本地调试和未来 IM 入口。
- CLI demo 和 10 个通过的测试（含 MCP stdio 集成测试）。

## M0 不包含

- 真实 Claude Code / opencode / pi 适配器。
- 远程 Node Agent。
- IM / 语音。
- Web 聊天界面。
