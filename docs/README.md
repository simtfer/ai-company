# AI Company 文档

> 用户只与 CEO 沟通；一个 harness 实例就是一个职位；CEO 通过 Company Runtime 统筹分派任务。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 总体架构、对象模型、CEO 入口、会话连续性、多电脑、安全 |
| [roadmap.md](roadmap.md) | D0–M4 阶段、交付物、验收标准 |
| [progress.md](progress.md) | 当前进展、阶段状态、变更日志、下一步 |
| [ceo-harness-setup.md](ceo-harness-setup.md) | MCP / CLI 接入 CEO harness 的配置与工具清单 |
| [multi-node.md](multi-node.md) | M2 多电脑节点：注册、心跳、租约、远程派工和产物回传 |

相关入口：[项目 README](../README.md) · [CEO skill](../ceo-skill/SKILL.md)

## 一句话架构

```text
CEO Harness（唯一人类入口）
   │ MCP / tools
Company Runtime（无界面后台）
   │
Node A / Node B（各台电脑上的 Position）
```

## 关键约定

- **CEO harness 是唯一入口。** 用户不安装第二个聊天软件。
- **Company Runtime 无界面。** 它负责状态、调度、会话、审批、审计和远程节点。
- **一个 harness 实例 = 一个职位。** Position 有独立工作区、配置、凭证和权限。
- **长员工，短会话。** 原生 session 只是缓存；任务线程、Position Memory、git 分支和产物才是记忆。
- **先单机，再多机。** M0/M1 先跑通单机闭环，M2 再接远程节点。
- **IM/语音后期接入。** 它们只是 CEO 的 Ingress/Egress，不绕过 CEO。

## 当前状态

- D0 方案设计：已完成。
- M0 Runtime + Fake Position：已完成。
- M1 单机真实 Harness：✅ 已完成。
  - Claude Code 2.1.304、pi 1.2.0、opencode 1.18.35 全部实机验证。
  - 三个 harness 的连通性、session 连续、代码修改与测试均通过。
  - worktree、session resume/回退、测试证据、审批闸门、工具白名单已实现。
- M2 多电脑节点：✅ 已完成。
  - Node Agent 注册、心跳、claim、events、complete、租约续期。
  - 双节点远程派工、产物回传、租约过期重排、drain/revoke。
  - `pnpm demo:multi-node` 可本机模拟两台电脑。
- 验收证据：`pnpm test` 21 passed、`pnpm demo:harnesses`、`pnpm demo:sessions`、`pnpm demo:code`、`pnpm demo:opencode`、`pnpm demo:multi-node`。
- 下一步：M3 IM/语音入口。

## 更新规则

每完成一个阶段：

1. 更新 `progress.md` 的阶段状态和变更日志。
2. 如有架构变化，同步更新 `architecture.md`。
3. 如有验收结果，记录验收证据和已知问题。
4. 不把“计划中”标成“已完成”；以可运行的验收结果为准。
