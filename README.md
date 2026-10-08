# hkjc-agent-runner

接收 hkjc-data-worker 的 `hkjc-push/1.0` 推送，写入 D1，经 Queue 做多角色分析。不修改 hkjc-worker。

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

线上地址：`https://hkjc-agent.cf-connect.top`（Worker 名 `hkjc-agent-runner`）。

## 怎么接入

data worker 把事件 POST 到：

`https://hkjc-agent.cf-connect.top/webhook`

请求体是原始 JSON，信封版本 `hkjc-push/1.0`。成功时 runner 尽快返回 **202** `{"received":true}`。2xx 都算送达。

签名只在 data worker 设置了 `PUSH_SECRET` 时才有。头是 `X-Signature`，值是 `hex(HMAC-SHA256(原始 body, PUSH_SECRET))`，没有 `sha256=` 前缀。两边的 secret 必须相同。没设 secret 时，runner 当未签名接收。

data worker 上要设的是：

1. `PUSH_SECRET`：与 runner 同一个值。
2. `PUSH_TARGET_URL`：`https://hkjc-agent.cf-connect.top/webhook`。
3. `LIVE_PUSH_ENABLED=true` 时，换 URL 之后实盘事件会马上推过来。

联调用 data worker 的 `POST /v1/admin/test-push`。这个接口自己返回 200，真正的 webhook 结果在 `result.http_status`，202 才算 runner 收到。

不要把 secret 写进仓库或聊天。

### GPT 接入（MCP）

只读 MCP 地址：`https://hkjc-agent.cf-connect.top/mcp`，不认证。工具清单和 ChatGPT、Responses API 的接法见 [docs/GPT-MCP.md](docs/GPT-MCP.md)。

| 路径 | 谁能调 | 作用 |
|---|---|---|
| `POST /webhook` | data worker | 收推送 |
| `POST /mcp` | 公开，只读 | GPT 通过 MCP 查状态和分析 |
| `GET /health` | 公开 | 活着与否 |
| `GET /runs/:id` | `Authorization: Bearer <RUNNER_API_TOKEN>` | 查一次分析 |

## 本地

```bash
npm ci
npm test
npm run typecheck
```

导入角色包（拿到 ZIP 之后）：

```bash
npm run roles:import -- /path/to/roles.zip
```

没有角色包时，赛马分析事件会失败，错误是 `no roles loaded`。`test`、`schedule`、`backfill_progress`、`whitelist_alert`、`runs_update`、`changes` 只记账，不跑分析。

## 部署时要设的变量

| 变量 | 放在 | 说明 |
|---|---|---|
| `PUSH_TARGET_URL` | data worker secret | `https://hkjc-agent.cf-connect.top/webhook` |
| `PUSH_SECRET` | 两边 secret，同一个值 | raw body 的 HMAC-SHA256 hex |
| `OPENAI_API_KEY` | runner secret | 没设就不会调模型 |
| `OPENAI_MODEL` | runner var | 必填，名字只从这里来 |
| `RUNNER_API_TOKEN` | runner secret | `GET /runs/:id` 的 Bearer |

```bash
npx wrangler secret put PUSH_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put RUNNER_API_TOKEN
npx wrangler deploy
```
