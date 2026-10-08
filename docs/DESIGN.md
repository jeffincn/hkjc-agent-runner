# hkjc-agent-runner 设计说明

独立于 hkjc-data-worker，不改它的源码。契约以 2026-10-08 的
[hkjc-worker README](https://github.com/jeffincn/hkjc-worker/blob/main/README.md)
和 `src/push/pusher.ts` 为准。

## 推送契约

- Body 是 `hkjc-push/1.0`。`POST {PUSH_TARGET_URL}`，`Content-Type: application/json`。
- 只有配置了 `PUSH_SECRET` 才带 `X-Signature`，值是 raw body 的 HMAC-SHA256 hex，没有 `sha256=` 前缀。生产目前没设 secret，所以暂时没有签名。
- 接收方回 202 或任何 2xx 都算成功。`/v1/admin/test-push` 自己回 200，webhook 的状态在 `result.http_status`。
- `odds_update`、`lock`、`scratch`、`result` 目前没有 `meta.content_hash`。有 hash 的是 dividends、changes、horse_update、runs_update。去重：有 `meta.content_hash` 就用它；否则用事件 + 赛事 + 马场 + `race_no@snapshot_time`。没有场次的事件（injury、schedule 等）对去掉 `sent_at` 的信封做哈希，同内容重试会合并。
- 另有 `runs_update`、`changes`。这两种以及 test、schedule、backfill_progress、whitelist_alert 只记录，不跑分析。
- 不要求 clawer 给每条信封加 `content_hash`，那要改码和部署。

## 八个角色

工作区里没有团队迁移 ZIP，线上仓库也没有。`roles/bundle.json` 因此是空的，分析在导入前会失败并重试，不会拿空角色去叫模型。`npm run roles:import -- <zip>` 读两种布局：`<id>/instructions.md` + `memory.md` + `meta.json`，或带 frontmatter 的 markdown。`source_grade` 只接受 official、reported、model、unverified，别的等级会降成 unverified 并打印出来。

本地测试用 8 个脱敏 fixture 角色（odds、quant、strategy、contrarian、nursing、review、form、pace），不代表真实角色包。

## 处理

1. `POST /webhook` 读原始字节。设了 `PUSH_SECRET` 就校验 HMAC，失败 401，不存原文。
2. 同一条 D1 batch 写入 inbox 和 pending outbox，再 202 `{"received":true}`。重复键只增加 `duplicate_count`，不新建 outbox。
3. `waitUntil` 投递 Queue。失败则 outbox 留在 pending，cron 每分钟按 30s、1m、5m、15m、30m 重试。已确认的事件不会因为 Queue 失败而丢掉。
4. Consumer 用租约认领。同一事件已完成就直接 ack，不重跑 Agent。
5. `odds_update` 延迟 45 秒，只分析该场 `odds_latest` 仍指向自己的快照，更旧的标 superseded。
6. 赛马事件最多三轮：全部已加载角色独立判断、路由相关角色交叉质疑、主持人汇总。概率不在 0 到 1 就原轮修复一次，仍非法则该步作废，不进入结论。
7. 赛前提示会去掉 `final_position`。赛后只读 `race_opinions.locked = 1`。`lock` 把意见锁定，之后的赔率分析不能覆盖。
8. 伤患或马匹资料没有记录日期时，一律标 unknown，模型不能把它说成新公告。

模型调用只使用 2026-10-08 官方 OpenAPI `createResponse` 里确认过的字段：`model`、`instructions`、`input`、`store: false`、`text.format`（json_schema, strict）。模型名来自 `OPENAI_MODEL`，不写死。
