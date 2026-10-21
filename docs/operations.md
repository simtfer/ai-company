# 运维与 M4 加固

## 1. 可执行入口

```bash
node bin/aic.mjs --version
node bin/aic.mjs metrics
node bin/aic.mjs backup --out D:\backups\ai-company.db
```

`package.json` 已声明 `bin.aic`；执行 `pnpm link` 或安装 tarball 后可以直接运行 `aic`。
当前 entry 通过本机 `tsx` 运行 TypeScript；真正的单文件打包仍待后续。

## 2. 预算

```bash
node bin/aic.mjs budget
```

- 公司预算：`companies.budget_json`，默认 50 USD。
- 职位预算：`positions.budget_json`，默认 5 USD。
- 任务预算：`task.budget.usd`。
- 派工前检查公司/职位/任务已花费；达到上限时抛出 `BudgetExceededError`，不启动新 Run。
- 任务完成后如果单任务超预算，任务转为 `blocked` 并写 `budget.exceeded` 事件。
- 当前只硬性执行 USD 预算；分钟预算仍作为 adapter 超时参数使用。

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

review task 不能由原任务作者担任。review 任务 done 后，merge queue 从 `pending_review` 进入 `ready`。
当前 `merged` 是审计状态，不会自动执行 git merge。

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

Windows 可以用 NSSM/WinSW 把 `node bin/aic.mjs serve --host 0.0.0.0 --port 4317` 注册为服务；Linux 可以写 systemd unit：

```ini
[Unit]
Description=AI Company Runtime
After=network.target

[Service]
WorkingDirectory=/opt/ai-company
ExecStart=/usr/bin/node /opt/ai-company/bin/aic.mjs serve --host 0.0.0.0 --port 4317
Restart=always
Environment=AIC_DB_PATH=/var/lib/ai-company/company.db

[Install]
WantedBy=multi-user.target
```

M2 的 HTTP 没有内建 TLS；跨公网请放在 Tailscale/WireGuard 或反向代理后面。

## 9. 仍待补的 M4 项

- 单文件二进制打包。
- Windows 服务/Linux systemd 的自动化安装脚本。
- 分钟级公司/职位预算的硬停。
- reviewer 自动派工和真正的 git merge 执行。
- harness 工具执行中的实时权限询问桥。
