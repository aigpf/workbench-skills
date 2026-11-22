# 验收台中转协议

服务是独立进程，默认端口 7003，路径前缀 `/api/acceptance/`。正式环境通过工作台反向代理到 `https://qianqianquege.com/api/acceptance/`。

## 四个接口

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/acceptance/push?k=<channel>` | agent 推送计划，整份覆盖并续期 | `x-sync-token` |
| GET | `/api/acceptance/snapshot?k=<channel>` | 页面读计划，不续期 | 无 |
| POST | `/api/acceptance/review?k=<channel>` | 页面自动回传人工结果 | `x-review-token` |
| GET | `/api/acceptance/review?k=<channel>` | agent 拉人工结果，不删除不续期 | `x-sync-token` |
| GET | `/health` | 健康检查；带 `?k=` 可看该频道剩余计划/结果 | 无 |

频道 key 只能是 6–40 位小写字母或数字，服务端会转小写并校验。所有 JSON 请求体上限 4 MB。

## 推送计划

```http
POST /api/acceptance/push?k=mychannel001
Content-Type: application/json
x-sync-token: <SYNC_TOKEN>
```

请求体就是本机快照，形状：

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "lastWrite": "2026-11-18 17:00",
  "plans": [
    {
      "id": "a_xxx",
      "title": "验收单标题",
      "sourceTask": "任务名",
      "agent": "Doubao",
      "environment": "生产",
      "summary": "说明",
      "status": "active",
      "version": 7,
      "createdAt": "2026-11-18 16:00",
      "updatedAt": "2026-11-18 17:00",
      "sections": [
        {
          "id": "s_xxx",
          "no": "01",
          "title": "P0 核心流程",
          "desc": "说明",
          "items": [
            {
              "id": "i_xxx",
              "priority": "P0",
              "title": "验收项",
              "steps": ["第一步", "第二步"],
              "expected": "预期结果",
              "note": "agent 说明",
              "evidence": [
                { "kind": "text", "text": "证据文字" },
                { "kind": "link", "url": "https://example.com", "label": "链接名" },
                { "kind": "image", "objectKey": "...", "filename": "a.png", "mime": "image/png", "size": 123 }
              ],
              "fixLog": [
                { "time": "2026-11-18 17:00", "version": "v1.2.3", "text": "修复说明" }
              ],
              "updated": "2026-11-18 17:00"
            }
          ]
        }
      ]
    }
  ],
  "reviews": []
}
```

约束：

- 一个频道最多 100 张计划；计划、章节、条目 id 分别在同一层唯一，只能是字母、数字、下划线、短横线，最长 64。
- 章节必须有 `items` 数组；条目必须有 `title`。
- 条目 `priority` 只接受 `P0`、`P1`、`P2`。
- 证据最多 24 条；文字最多 5000 字符；链接必须是 http/https。
- 服务端会把字段裁剪到上限，不改 id 和层级。
- 重复推送是整份覆盖；没有 409、没有字段级合并。

成功响应：

```json
{
  "ok": true,
  "data": {
    "channel": "mychannel001",
    "etag": "\"abc123\"",
    "plans": 1,
    "lastWrite": "2026-11-18 17:00",
    "revision": 12,
    "ttlSeconds": 600,
    "expiresAt": "2026-11-18T09:10:00.000Z"
  }
}
```

## 页面读计划

```http
GET /api/acceptance/snapshot?k=mychannel001
If-None-Match: "abc123"
```

- 200：返回计划 JSON，并带 `ETag`、`X-Snapshot-Age`、`X-Snapshot-Expires`。
- 304：`If-None-Match` 命中，页面用本地缓存，不续期。
- 503：没有计划或计划已过期，`error.code` 为 `channel_empty`。页面应显示缓存或空态，不要当成服务挂掉。

页面每次读取都看文件 mtime；超过 `SNAPSHOT_TTL_SECONDS` 就删除并返回 503，读取本身不刷新 mtime。

## 自动回传人工结果

```http
POST /api/acceptance/review?k=mychannel001
Content-Type: application/json
x-review-token: <REVIEW_TOKEN>
```

请求体：

```json
{
  "planId": "a_xxx",
  "planVersion": 7,
  "reviewer": "张三",
  "items": {
    "i_xxx": { "status": "pass", "note": "主流程正常" },
    "i_yyy": { "status": "fail", "note": "空数据时白屏，复现步骤：..." }
  }
}
```

- `status` 只有四档：`pending`（待验）、`pass`（通过）、`fail`（不通过）、`hold`（暂缓）。
  旧值在入口归并：`untested`/`retest` → `pending`，`block`/`skip` → `hold`，其他值一律当 `pending`。
  「待复测」不是状态而是动作：计划版本变了，页面把已给过结论的条目退回 `pending`，备注保留。
- `planVersion` 与服务器当前计划版本不一致时，结果仍然保存，但标记 `stale: true`；不返回 409，也不丢弃。
- 结果只保存最新一份，页面每次改动自动回传，整份覆盖。
- 回传成功时结果文件从回传时刻重新计 `REVIEW_TTL_SECONDS`，默认 600 秒。
- 计划已过期时返回 503 `plan_empty`；计划里没有该 `planId` 时返回 404 `plan_not_found`。
- 服务器没有配置 `REVIEW_TOKEN` 时回传接口关闭，返回 503 `review_token_not_configured`。
- 回传 key 错误返回 401 `review_token_invalid`。

成功响应：

```json
{
  "ok": true,
  "data": {
    "channel": "mychannel001",
    "review": {
      "planId": "a_xxx",
      "planTitle": "验收单标题",
      "planVersion": 7,
      "reviewer": "张三",
      "submittedAt": "2026-11-18T09:07:05.084Z",
      "stale": false,
      "items": { "i_xxx": { "status": "pass", "note": "主流程正常", "reviewedAt": "" } }
    },
    "etag": "\"def456\"",
    "submittedAt": "2026-11-18T09:07:05.084Z",
    "planVersion": 7,
    "stale": false,
    "ttlSeconds": 600,
    "expiresAt": "2026-11-18T09:17:05.084Z"
  }
}
```

## agent 拉结果

```http
GET /api/acceptance/review?k=mychannel001
x-sync-token: <SYNC_TOKEN>
If-None-Match: "def456"
```

- 200：`{ ok: true, data: <review>, receivedAt, expiresAt }`，并带 `ETag`、`X-Review-Expires`。
- 304：`If-None-Match` 命中。
- 503：没有结果或结果已过期，`error.code` 为 `review_empty`。
- 读取不删除文件，也不刷新 mtime；到期后后台清扫或下一次读取时删除。
- 同一份结果可以重复拉取，agent 应自己避免重复处理同一个 `submittedAt`。

## 生命周期

- 计划 TTL：默认 600 秒，从最后一次 `push` / `connect` 写入算起。页面读、agent 读都不续期。
- 结果 TTL：默认 600 秒，从页面最后一次自动回传算起。agent 拉取不续期。
- 服务器每 30 秒清扫一次过期文件；每次读取也会检查 mtime 并删除过期文件。
- 服务器只放临时文件，不写数据库、不做业务归档；重启后未过期的临时文件仍在，过期即删。
- 频道数量超过上限时按 mtime 淘汰最旧文件，默认 200 个频道。

## 安全

- 生产必须同时配置 `SYNC_TOKEN` 和 `REVIEW_TOKEN`。`SYNC_TOKEN` 为空时推送和拉取接口不鉴权；`REVIEW_TOKEN` 为空时回传接口关闭。
- 回传 key 放在页面链接的 `r=` 参数里，等同于用户侧写权限；不要把只读链接和可编辑链接混发。
- 不要把服务器临时目录、令牌、内部路径返回给用户。
- 反向代理需保留 `X-Forwarded-For`，并且只走 HTTPS。
