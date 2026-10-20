# 项目进展

> 最后更新：2026-10-21  
> 当前阶段：D0 已完成，M0 未开始  
> 入口：CEO harness（不做独立聊天软件）

## 当前状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 方案设计 | ✅ 已完成 | 架构、路线、进展文档已建立 |
| 工作区 | ✅ 可用 | `D:\tmp\b` 已可写入 |
| 代码仓库 | ✅ 已建立 | [simtfer/ai-company](https://github.com/simtfer/ai-company)（private） |
| M0 Runtime | ⬜ 未开始 | 下一步 |
| M1 真实 harness | ⬜ 未开始 | 依赖 M0 |
| M2 多电脑 | ⬜ 未开始 | 依赖 M1 |
| M3 IM/语音 | ⬜ 未开始 | 依赖 M2 |
| M4 加固 | ⬜ 未开始 | 依赖 M3 |

## 阶段状态

| 阶段 | 状态 | 完成日期 | 验收证据 |
|---|---|---|---|
| D0 方案设计 | ✅ 已完成 | 2026-10-21 | `architecture.md` / `roadmap.md` / `progress.md` |
| M0 Runtime + Fake Position | ⬜ 未开始 | — | — |
| M1 单机真实 Harness | ⬜ 未开始 | — | — |
| M2 多电脑节点 | ⬜ 未开始 | — | — |
| M3 IM / 语音 | ⬜ 未开始 | — | — |
| M4 质量与打包 | ⬜ 未开始 | — | — |

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

## 下一步

1. 进入 M0：搭建 Runtime、SQLite 状态、任务状态机和 CEO 工具接口。
2. 实现 Fake Position，先跑通“目标 → 计划 → 派工 → 报告 → CEO 汇总”。
3. 每完成一个阶段，更新本文件的阶段状态、变更日志和验收证据。

## 阻塞与风险

- 当前无阻塞。
- 风险：首批 harness 的实际安装版本尚未探测；M1 开始前需要 `probe()` 记录版本和能力。
- 风险：CEO harness 的主动通知受回合制限制；M3 前只能在下一次对话汇报增量。
