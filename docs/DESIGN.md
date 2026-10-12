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
3. `waitUntil` 投递 Queue。失败则 outbox 留在 pending，cron 每 5 分钟检查一次，按 30s、1m、5m、15m、30m 退避重试（实际最快 5 分钟）。已确认的事件不会因为 Queue 失败而丢掉。
4. Consumer 用租约认领。同一事件已完成就直接 ack，不重跑 Agent。
5. `odds_update` 延迟 45 秒，只分析该场 `odds_latest` 仍指向自己的快照，更旧的标 superseded。
6. 赛马事件最多三轮：全部已加载角色独立判断、路由相关角色交叉质疑、主持人汇总。概率不在 0 到 1 就原轮修复一次，仍非法则该步作废，不进入结论。
7. 赛前提示会去掉 `final_position`。赛后只读 `race_opinions.locked = 1`。`lock` 把意见锁定，之后的赔率分析不能覆盖。
8. 伤患或马匹资料没有记录日期时，一律标 unknown，模型不能把它说成新公告。

模型调用只使用 2026-10-08 官方 OpenAPI `createResponse` 里确认过的字段：`model`、`instructions`、`input`、`store: false`、`text.format`（json_schema, strict）。模型名来自 `OPENAI_MODEL`，不写死。

## hkjc-push/1.1 与数据质量（2026-10-12）

上游会在 1.0 之外新增 `hkjc-push/1.1`。正式 schema 将放在 hkjc-worker 的 `docs/push-schema-1.1.md`（写这段时还没有发布），所以 1.1 的字段名**只**在 `src/push11.ts` 的 `FIELD_MAP` / `CHANGE_FIELDS` 里出现，上游定稿后只改那一处。

### 接收

- `schema` 为 `hkjc-push/1.0` 与 `hkjc-push/1.1` 都接受。1.1 额外读取 `event_id`、`seq`、`captured_at`、`sent_at`、`source.last_updated_at`（可为 null）、`source.url`、`quality{missing_source_time, post_start, late_ms}`。
- 新事件：`odds_delta`（`changes[]` + 可为 null 的 `pools[]`）写入账本；`no_update` 心跳更新 `stream_state.last_heartbeat_at` 和 `last_change_seq`。两者都只记账，不跑分析。
- 去重：1.1 用 `event_id`（重试时不变）作 dedupe key，重复投递只加 `duplicate_count` 并在原行加 `duplicate` 标记。1.0 保持原规则。
- 每条事件记录 `received_at`（UTC）和 `received_at_hkt`（+08:00）。

### 延迟（毫秒）

| 列 | 定义 |
|---|---|
| `delay_received_sent_ms` | received − sent_at |
| `delay_received_captured_ms` | received − captured_at（1.0 用最大 `snapshot_time` 代替） |
| `delay_captured_source_ms` | captured_at − source.last_updated_at（1.0 没有源时间，为 null） |

### 质量标记（`inbox_events.quality_flags`，JSON 数组）

| 标记 | 规则 |
|---|---|
| `missing_source_time` | 1.0 一律；1.1 中 `source.last_updated_at` 为 null 或上游 `quality.missing_source_time = true` |
| `gap` | `seq` 比当天已见最大 seq 大 1 以上；缺口写入 `seq_gaps` |
| `out_of_order` | `seq` ≤ 当天已见最大 seq（且不是重复 seq） |
| `duplicate` | 同一 `event_id` 重投，或同一 seq 换了 `event_id` |
| `future_timestamp` | sent/captured/source 时间比接收时间晚 30 秒以上，或 captured 早于 source 30 秒以上 |
| `post_start` | 接收时间 ≥ 该场开跑时间（`race_schedule`，来自 schedule 事件和各事件的 `post_time`）；没有开跑时间时采用上游 `quality.post_start` |
| `late` | 上游 `quality.late_ms > 0`，或 received − captured > 60 秒 |

post_start 处理：事件涉及的场次**全部**已开跑时，`post_race = 1`；若事件是 odds_update / odds_delta / scratch / horse_update / injury_update，路由改为 `record_only`，不更新 `odds_latest`。部分场次已开跑时，账本中这些场次的行标 `post_race = 1`，分析前也会从信封里剔除已开跑的场次。`lock` 本来就在开跑时到，不按 post_start 降级。

### 账本

`odds_ledger` 是全系统共用的追加型账本：一行一个（事件, 场次, 马号, WIN/PLA）赔率变化，带 seq、event_id、captured_at、received_at_hkt、post_race 和当时的质量标记。触发器禁止 UPDATE/DELETE。1.1 的 `odds_delta` 直接写入 changes；1.0 的 `odds_update` 每匹马写 WIN/PLA 两行（`prev_odds` 为 null，`odds_basis = total_return`）。`get_ledger` 按 seq（再按到达顺序）回放，缺 `prev_odds` 时用轨迹上一个值补。

### 流状态

每个赛日一行 `stream_state`：最后事件时间（UTC 与 HKT）、最后 seq、最后心跳、`last_change_seq`。判断：

- **快窗口**（判断取舍）：任一场开跑前 30 分钟到开跑后 10 分钟。理由是 HKJC 赔率在最后半小时变动最快，lock/result 也在开跑后几分钟内到。期望间隔 60 秒，其余时间 5 分钟。
- 距最后一次事件或心跳 > 间隔 × 2 为 `stale`，> 间隔 × 5 为 `broken`，从没收到为 `no_data`。
- `data_quality_status`：broken 或仍有未补的 seq 缺口 → `bad`；stale 或出现 gap/out_of_order/future_timestamp/late → `degraded`；否则 `ok`。

已知限制：同一赛日两条事件真正并发到达时，seq 判断读的是写入前的状态，极端情况下 gap/out_of_order 可能漏标；`get_data_quality` 的未补缺口是按已存 seq 实时算的，不受影响。

### 概率与 EV 校验（`src/validation.ts`）

分析每次跑完第一轮，把各角色的 `p_win` / `p_place` 逐项校验，结果写 `analysis_validation`，`get_run` 一并返回：

1. P 必须是有限数且在 [0,1]（例如 P(place)=116.91% 会被隔离）。
2. 马号必须对应该场在信封里非退出（status 不含 scratch/withdrawn/退出）的马。picks 只带马号，所以信封只有一场时才能对应场次；多场且 pick 没写 `race_no` 时隔离。
3. 角色给了整场所有在跑马的概率时做总和检查：WIN 和 ≈ 1（±0.05）；PLA 和 ≈ 派彩名次数（7 匹以上 3 个，4–6 匹 2 个，少于 4 匹没有位置彩池）±15%。只给了部分马时不做总和检查。
4. Fair = 1/P；EV = P × 总回报赔率 − 1。`odds_basis = total_return` 直接用赔率，`net` 用赔率 + 1，其他基准隔离且不算 EV。

隔离项保留原因，`fair_odds` 和 `ev` 为 null。
