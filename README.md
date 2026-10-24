# hkjc-agent-runner

接收 hkjc-data-worker 的 `hkjc-push/1.0` 和 `hkjc-push/1.1` 推送，写入 D1，经 Queue 做多角色分析。不修改 hkjc-worker。

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

新增可选的 [Cron 拉取归档](docs/COLLECTION.md)：从自己的 Worker 读取事件、排位和赛果并保存到独立 D1 表；默认关闭，不开启 webhook、不触发分析或外发。原有五分钟 outbox cron 保持不变。

线上地址：`https://hkjc-agent.cf-connect.top`（Worker 名 `hkjc-agent-runner`）。

## 怎么接入

data worker 把事件 POST 到：

`https://hkjc-agent.cf-connect.top/webhook`

请求体是原始 JSON，信封版本 `hkjc-push/1.0` 或 `hkjc-push/1.1`。1.1 按 `event_id` 去重，带 seq、采集/发送/源时间和质量字段，新增 `odds_delta` 与 `no_update` 心跳。每条事件记录接收时间（HKT）、三项延迟和质量标记；开跑后到达的事件标为赛后，不进入赛前分析。1.1 字段映射集中在 `src/push11.ts`，细节见 [docs/DESIGN.md](docs/DESIGN.md)。新接收的 webhook 若有质量问题，响应头会带 `X-Quality-Flags`。成功时 runner 尽快返回 **202** `{"received":true}`。2xx 都算送达。

签名只在 data worker 设置了 `PUSH_SECRET` 时才有。头是 `X-Signature`，值是 `hex(HMAC-SHA256(原始 body, PUSH_SECRET))`，没有 `sha256=` 前缀。两边的 secret 必须相同。没设 secret 时，runner 当未签名接收。

data worker 上要设的是：

1. `PUSH_SECRET`：与 runner 同一个值。
2. `PUSH_TARGET_URL`：`https://hkjc-agent.cf-connect.top/webhook`。
3. `LIVE_PUSH_ENABLED=true` 时，换 URL 之后实盘事件会马上推过来。

联调用 data worker 的 `POST /v1/admin/test-push`。这个接口自己返回 200，真正的 webhook 结果在 `result.http_status`，202 才算 runner 收到。

不要把 secret 写进仓库或聊天。

### GPT 接入（MCP）

只读 MCP 地址：`https://hkjc-agent.cf-connect.top/mcp`，不认证。除分析结果外，还有 `get_ledger`（赔率账本回放）和 `get_data_quality`（某赛日的最后事件时间、seq 缺口、质量标记计数和流状态）。工具清单和 ChatGPT、Responses API 的接法见 [docs/GPT-MCP.md](docs/GPT-MCP.md)。

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

## 数据库迁移

`migrations/0002_push11_quality.sql` 给 `inbox_events` 加时间/质量列，并新建 `race_schedule`、`stream_state`、`seq_gaps`、`odds_ledger`（追加型，触发器禁止改删）和 `analysis_validation`。部署前先跑 `npm run db:migrate:remote`。

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
