# 运维与 M4 加固

## 1. 可执行入口

```bash
node bin/aic.mjs --version
node bin/aic.mjs metrics
node bin/aic.mjs backup --out D:\backups\ai-company.db
```

`package.json` 已声明 `bin.aic`；执行 `pnpm link` 或安装 tarball 后可以直接运行 `aic`。

单文件构建：

```bash
pnpm build       # dist/aic.mjs，单文件 ESM bundle
pnpm build:sea   # dist/aic.exe，当前平台 Node SEA 单文件
```

Windows 生成的可执行文件是 `dist/aic.exe`；Linux 对应 `dist/aic`。

## 2. 预算

```bash
node bin/aic.mjs budget
```

- 公司预算：`companies.budget_json`，默认 50 USD / 600 分钟。
- 职位预算：`positions.budget_json`，默认 5 USD / 60 分钟。
- 任务预算：`task.budget.usd` / `task.budget.minutes`。
- 派工前检查公司/职位/任务已花费；达到上限时抛出 `BudgetExceededError`，不启动新 Run。
- 任务完成后如果单任务超预算，任务转为 `blocked` 并写 `budget.exceeded` 事件。
- USD 和分钟都硬性执行；分钟按已完成 Run 的起止时间累计。

设置预算可以通过 MCP 工具：

```text
company_set_company_budget { "usd": 100 }
company_set_position_budget { "name": "frontend-1", "usd": 10 }
```

## 3. 指标

```bash
node bin/aic.mjs metrics
```

包含任务状态、运行数、平均耗时、token/成本、重试任务数、节点在线状态、merge queue 计数和预算。

## 4. 重试与升级

- 新任务可设置 `max_retries`；失败后自动重试，最多 `max_retries` 次。
- `company_task_retry` 可手动重试 failed/blocked 任务。
- 超过重试次数仍失败，任务保持 failed，由 CEO 决定转派或升级。

## 5. 独立评审与合并队列

任务完成后：

```text
company_review_request { "task_id": "t_...", "reviewer": "qa-1" }
```

会创建独立 review task 和 merge queue 条目：

```text
company_merge_queue { "status": "pending_review" }
company_merge_queue { "status": "ready" }
company_merge_approve { "entry_id": "mq_..." }
company_merge_reject { "entry_id": "mq_...", "reason": "..." }
```

review task 不能由原任务作者担任，创建后会自动指派给 reviewer。review 任务 done 后，merge queue 从 `pending_review` 进入 `ready`。
`company_merge_approve` 会在任务仓库存在且工作区干净时执行 `git merge --ff-only <commit>`，并记录 `merge_commit`；远程/符号仓库不可本地合并时只记录 `merged` 审计状态。

## 6. 公司记忆检索

```bash
node bin/aic.mjs memory pricing
```

搜索员工手册、Position Memory 和 thread 摘要。

## 7. 备份、恢复与日志

```bash
node bin/aic.mjs backup --out D:\backups\ai-company.db
node bin/aic.mjs restore --from D:\backups\ai-company.db
node bin/aic.mjs logs:prune --days 7
```

备份使用 SQLite `VACUUM INTO`，是打开数据库时的 consistent snapshot。
恢复会覆盖目标数据库；执行前先停止 Runtime。

## 8. 服务化

生成安装定义（不修改系统）：

```bash
node bin/aic.mjs service:install --name "AI Company Runtime" --port 4317
```

实际安装（Windows 需要管理员；Linux 需要 sudo）：

```bash
node bin/aic.mjs service:install --apply --db-path D:\aic\company.db
node bin/aic.mjs service:uninstall --apply
```

- Windows：注册开机计划任务（SYSTEM、最高权限），使用 `dist/aic.exe` 或 `node bin/aic.mjs`。
- Linux：写入 `/etc/systemd/system/*.service`，启用并启动。
- M2 的 HTTP 没有内建 TLS；跨公网请放在 Tailscale/WireGuard 或反向代理后面。

## 9. 仍待补的 M4 项

- harness 工具执行中的实时权限询问桥（当前是执行前审批 + 工具白名单）。
- 远程节点的 git 分支自动推送到共享 remote。
- Windows 服务的 NSSM/WinSW 原生服务模式（当前是计划任务）。
