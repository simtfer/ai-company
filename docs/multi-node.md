# 多电脑节点（M2）

> M2 使用“节点主动外连 + HTTP 拉取/心跳”的传输方式；后续可以替换为 WSS，节点协议不变。

## 1. 启动控制平面

本机或一台常开的电脑：

```bash
pnpm serve --host 127.0.0.1 --port 4317
```

跨电脑时最省事的是 Tailscale/WireGuard。确认组网后，让控制平面只监听 Tailscale 地址或内网地址：

```bash
pnpm serve --host 0.0.0.0 --port 4317
```

不要把 4317 直接暴露到公网；M2 还没有内建 TLS。

## 2. 创建一次性注册令牌

控制平面：

```bash
pnpm cli node:token --name laptop-b
```

或者让 CEO 调用 MCP 工具：

```text
company_node_enroll { "name": "laptop-b" }
```

令牌默认 30 分钟有效，只能使用一次。

## 3. 在另一台电脑上加入节点

把仓库同步/安装到另一台电脑，然后：

```bash
pnpm cli node:join \
  --server http://<控制平面地址>:4317 \
  --token <一次性令牌> \
  --name laptop-b \
  --workspace D:\aic-node
```

节点会：

1. 用一次性令牌注册；
2. 拿到自己的 node token；
3. 每 2 秒心跳；
4. 每 1 秒拉取任务；
5. 执行任务并回传事件、报告、session id 和测试/diff 产物。

节点需要本机安装至少一个 harness（Claude Code / pi / opencode）。它会自动发现，也可以用环境变量覆盖：

```bash
AIC_CLAUDE_COMMAND=...
AIC_PI_COMMAND=...
AIC_OPENCODE_COMMAND=...
```

## 4. 在远程节点上招聘职位

CEO 通过 `company_position_hire` 指定 `node_id`：

```json
{
  "name": "laptop-b-worker",
  "role": "worker",
  "harness_kind": "opencode",
  "model": "deepseek/deepseek-flash",
  "node_id": "<注册返回的 node_id>",
  "workspace": "workspace/laptop-b-worker"
}
```

`workspace` 建议使用相对路径，由节点在自己的 `--workspace` 根目录下解析。

## 5. 派工与产物

CEO 正常创建计划、指派任务、调用 `company_run_ready`。控制平面会把任务租约发给节点：

- 节点领取后任务变为 `running`；
- 节点执行期间会续租；
- 完成后控制平面写入报告、session、职位记忆和产物；
- 测试输出和 git diff 会写入控制平面的 `.aic/artifacts/remote-*`；
- 如果节点失联，租约过期后任务自动回到 `assigned`，等待重新领取。

## 6. 节点管理

MCP 工具：

| 工具 | 用途 |
|---|---|
| `company_node_list` | 节点、在线状态、职位、活动任务 |
| `company_node_enroll` | 创建一次性注册令牌 |
| `company_node_drain` | 停止接收新任务（排空） |
| `company_node_revoke` | 撤销节点 token，禁止继续领取任务 |

HTTP：

```text
GET  /api/nodes
POST /api/nodes/:id/drain
POST /api/nodes/:id/revoke
```

## 7. 演示与测试

本机模拟两台电脑：

```bash
pnpm demo:multi-node
```

测试覆盖：

- 两个节点注册；
- 远程任务派发和完成；
- 测试产物回传；
- 租约过期后重排；
- drain / revoke；
- 一次性令牌不可复用。
