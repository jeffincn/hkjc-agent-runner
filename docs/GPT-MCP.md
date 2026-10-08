# GPT 通过 MCP 接入 hkjc-agent-runner

## 地址

```
https://hkjc-agent.cf-connect.top/mcp
```

- 传输：MCP Streamable HTTP，无状态。每个请求是一次 `POST` JSON-RPC，返回 `application/json`。`GET /mcp` 返回 405，因为服务端不主动推流。
- 认证：**无**（Jeff 2026-10-08 决定先这样）。全部工具只读，不返回密钥，也不返回 webhook 原始 body。任何知道地址的人都能读到分析结果。
- 协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`。

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_status` | 无 | 服务状态：角色和模型是否配置、各状态事件数、队列与模型最近成功或错误 |
| `list_recent_events` | `limit`(1–50)、`event_type`、`meeting_date` | data worker 推来的事件元数据，最新在前 |
| `list_recent_runs` | `limit`、`status`、`meeting_date`、`workflow` | 多角色分析记录，最新在前 |
| `get_run` | `run_id` | 一次分析的主持人结论、分歧，以及每轮每个角色的输出 |
| `get_race_analysis` | `meeting_date`、`venue`、`race_no` | 单场赛前观点（是否已锁定）和涉及这场的分析 |
| `search` | `query` | 按日期、场地、流程、状态搜分析，返回可给 `fetch` 用的 id |
| `fetch` | `id` | 一次分析的完整文档 |

`search` 和 `fetch` 按 ChatGPT 连接器常用的格式返回。

## 在 ChatGPT 里添加

在 ChatGPT 的设置里新建一个自定义连接器（需要开启开发者模式，具体菜单名称以 ChatGPT 当前界面为准）：

- MCP 服务器地址：`https://hkjc-agent.cf-connect.top/mcp`
- 认证：不认证（No authentication）

## 用 OpenAI Responses API 调用

```json
{
  "model": "<你的模型>",
  "tools": [
    {
      "type": "mcp",
      "server_label": "hkjc",
      "server_url": "https://hkjc-agent.cf-connect.top/mcp",
      "require_approval": "never"
    }
  ],
  "input": "2026-10-08 沙田第 3 场的赛前观点是什么？"
}
```

## 自测

```bash
curl -s https://hkjc-agent.cf-connect.top/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -A 'curl' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

请求必须带非空 `User-Agent`。cf-connect.top 开了浏览器完整性检查，空 UA 会被 Cloudflare 以 1010 拦下。

## 现在能读到什么

分析还没真正跑起来。要先导入八角色 ZIP，再设好 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。在那之前，`list_recent_runs` 基本是空的，事件会显示 `failed`，错误是 `no roles loaded`。
