# 从自己的 Worker 定时拉取并保存

这是 **pull-only 归档**：只读取 `https://hkjc.cf-connect.top`，不直接请求 HKJC、不新建 webhook 订阅、不调用模型，也不向下游订阅者转发。原有 webhook 和分析功能不变。本功能默认关闭；提交此改动不代表部署或启用。

## 怎么运行

复用现有 `*/5 * * * *` Cloudflare cron。每五分钟，原有 outbox 补投与新采集任务独立执行；任一失败不会阻止另一项启动。没有新增机器 cron 或后台常驻进程。本地需要显式模拟 scheduled 事件，`npm run dev` 本身不保证自动触发 cron。

仅在审核通过、决定启用的环境中：

1. 应用该环境的 D1 迁移，含 `0007_worker_collection.sql`。本地可用 `npm run db:migrate:local`。生产迁移和部署不属于此次改动。
2. 将 `HKJC_API_BASE` 设为 `https://hkjc.cf-connect.top`。其他域名、HTTP、自定义路径和重定向均不接受。
3. 将只读 Worker token 配置为 `HKJC_API_TOKEN` secret。本地放入已被 git 忽略的 `.dev.vars`；远端通过该环境的 secret 管理配置。不要写入仓库、日志或 PR。
4. 将 `HKJC_COLLECT_ENABLED` 显式设为 `true`。

已有 `PUSH_SECRET`、模型配置和订阅者与此采集器无关，无需开启上游推送。

## 拉什么、存在哪里

每轮按香港日期查询最近两天至未来七天的 `/v1/meetings?from&to`，然后逐会议分页读取：

```text
GET /v1/events?meeting_date=YYYY-MM-DD&venue=ST|HV&since_seq=N&limit=20
GET /v1/races?date=YYYY-MM-DD&venue=ST|HV
GET /v1/results?date=YYYY-MM-DD&venue=ST|HV
```

`/v1/events` 固定 `limit=20`（`limit=500` 实测可达 15–20MB，超过本端 1,500,000-byte 上限）。分页以 `since_seq` 推进；若响应含即将上线的 `truncated_by_bytes: true` 与 `next_since_seq`，则下一页使用 `next_since_seq`（即使本页条数少于 limit）。二者皆缺时仍按「满页继续、短页结束」兼容现有 Worker。

所有请求均带非空 User-Agent 和 Bearer token；只允许 GET。每轮默认最多 20 次请求，单请求超时 10 秒，响应上限 1,500,000 bytes（为 D1 单值/行大小留余量；超限失败且不推进游标）。预算用尽则保留已提交进度（`collection_cursors`），下一轮从断点继续。大量历史积压时事件回放优先，赛事/赛果归档可能推迟；列表靠后的会议也可能推迟处理。

归档保存在 runner 自己绑定的 D1，而非数据源 D1：

| 表 | 内容 |
|---|---|
| `collection_events` | 每条事件的完整 JSON 序列化正文、event_id、日期、马场、seq、采集时间 |
| `collection_cursors` | 按日期和马场独立保存的最后已提交 seq |
| `collection_documents` | 赛事列表、排位、赛果的响应原文；相同查询范围/会议与相同正文 hash 只存一次 |
| `collection_lock` | 单一采集租约；防止重叠 cron，异常中断后最多 15 分钟自动过期 |

本地 `npm run dev` 使用项目下 `.wrangler/state` 持久化；云端使用绑定的 `hkjc_agent_runner` D1。这里的本地目录是开发环境数据，不是生产数据库的自动副本。

可选配置：`HKJC_COLLECT_MAX_REQUESTS` 默认 20（1–40）、`HKJC_COLLECT_LOOKBACK_DAYS` 默认 2（0–60）、`HKJC_COLLECT_LOOKAHEAD_DAYS` 默认 7（0–30）。扩大回看范围不会绕过源端已有历史或 API 限制，也不保证每轮全部会议处理完。

## 不丢断点，不重复建事件

整页先验证版本、会议归属、event_id、严格递增 seq 和信封格式，再用一次 D1 事务写入整页及游标。任一步失败，整页回滚；下轮重读旧游标。event_id 为主键，同会议 seq 唯一。完全相同的事件重放是幂等的；同身份但不同正文会失败，不会悄悄覆盖档案或推进游标。seq 不必连续：源端合并可能产生跳号；本功能不把跳号自动认定为丢失。

HTTP 错误、无效 JSON、错误信封、超大响应和超时均不推进当前页游标。不保存源端错误响应，也不把 token 或请求头写入诊断。成功完成一轮后，`runner_meta.last_collection_ok` 保存该轮计数；这是该轮成功记录，不是“历史已全量同步”的证明。查看最近值时应同时查看 `updated_at`。

## 历史覆盖边界

本功能归档的是源端 `/v1/events` 已保留的事件，不重建尚未产生的事件，也不把已有快照自动导入分析账本。没有事件时允许空页，但空页不证明整个赛日采集完整。

如果需要赔率全量快照历史，现有接口是 `/v1/odds/history?date=...&venue=...&race_no=...`。其可选 `from/to` 仅控制 coverage 判断，不过滤 snapshots；因此本功能**不把它当增量接口，也不反复整场全量扫描**。首次全历史迁移与额外 coverage 审计应单独评审。

关闭 `HKJC_COLLECT_ENABLED` 即停止新拉取，不删已存数据，也不改变现有 webhook 接收设置。此前已关闭的外部 webhook 不会因本功能恢复。此改动也没有自动清理或保留期限；长期运行需要监控 D1 用量并另行决定备份/保留策略。

## 验证

```bash
npm ci
npm run typecheck
npm test
```

测试使用本地模拟 D1 与伪造 HTTP 响应，不携带真实 token，也不访问数据源或 HKJC。实际连通性及启用后的定时执行仍需在获准的部署环境验证。
