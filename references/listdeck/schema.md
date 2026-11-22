# 数据结构与字段语义

`~/.workbench/listdeck/projects.json` 是唯一数据源。整份文件随快照推送，网页按此渲染。

> 你可以读它、可以 `backup` 它，**不要手改**。`done/total`、`progress`、`changes`、`lastWrite`、`revision` 都由 CLI 维护，手改会让卡片和明细对不上。

## 顶层

```json
{
  "schemaVersion": "1.0",
  "revision": 12,
  "lastWrite": "2026-11-18 14:32",
  "guide": null,
  "projects": [],
  "groups": {},
  "changes": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 固定 `1.0`，页面按此解析 |
| `revision` | 本机每次成功写入都 +1 的序号；pull 优先用它判断谁更新，避免同一分钟漏拉 |
| `lastWrite` | 最后一次写入时间，格式 `YYYY-MM-DD HH:mm`（Asia/Shanghai），主要用于展示；旧数据没有 `revision` 时才用于比较 |
| `guide` | 网页「使用说明」页的整段内容，可为 `null` |
| `projects` | 项目数组，顺序即页面卡片顺序 |
| `groups` | 以项目 id 为键的批次表：`{ "p_xxx": [group…] }`，项目没有批次时可以缺键 |
| `changes` | 以条目 id 为键的变更记录：`{ "i_xxx": [{time,tool,change}…] }`，最多 20 条，最新在前 |

## project

```json
{
  "id": "p_3f9a1c",
  "priority": "P1",
  "name": "编辑器重构",
  "summary": "前后端分离",
  "note": "口径：只统计本期",
  "updated": "11-18",
  "done": 1,
  "total": 4
}
```

| 字段 | 规则 |
| --- | --- |
| `id` | CLI 生成，`p_` + 6 位；不可改 |
| `priority` | `P0` / `P1` / `P2` / `验证` / `约束` |
| `name` | 全库唯一；重名会被 `validation_failed` 拒绝 |
| `summary` | 卡片副标题，一句话 |
| `note` | 口径、范围、备注，可空 |
| `updated` | `MM-DD`，改项目或动其下条目时自动刷新 |
| `done` / `total` | **派生字段**，来自该项目所有 group 里的**非归档** issue；没有 group 时重算为 0 |
| `archived` | **派生字段**，该项目已归档条目数，不混进 `total/done` |

## group

```json
{
  "id": "g_7b21e0",
  "name": "第一批",
  "kind": "批次",
  "rule": "按原文顺序拆",
  "note": "",
  "issues": []
}
```

| 字段 | 规则 |
| --- | --- |
| `kind` | 只有 `批次` / `主题` |
| `rule` | 拆分规则 / 分组依据，给人和 agent 看 |
| 归属 | 一个 group 只属于一个 project；`groups[projectId]` 就是它的家 |

## issue

```json
{
  "id": "i_9c4d12",
  "title": "顶栏挤掉按钮",
  "status": "doing",
  "progress": 60,
  "type": "布局",
  "priority": "P1",
  "note": "复现步骤：…",
  "updated": "2026-11-18 14:30",
  "images": [],
  "attachments": []
}
```

| 字段 | 规则 |
| --- | --- |
| `status` | `todo` / `doing` / `done` |
| `progress` | `done`=100；`todo`=0；`doing` 夹在 1–99 |
| `type` | 自由文本，如 `布局` `接口` `文案` `文档` |
| `priority` | 同项目枚举；可空字符串 |
| `updated` | `YYYY-MM-DD HH:mm`。**停滞天数**（`idleDays`）就按它算：同一天记 0，跨自然日相减 |
| `archived` | 布尔，缺省即「未归档」。由 `issue rm` 写入，`issue restore` 清除 |
| `archivedAt` | `YYYY-MM-DD HH:mm`，归档时刻（`updated` 不因归档而变，历史保持真实） |
| `archivedFrom` | `{projectId, groupId, groupName}`，归档时它在哪个子类，供恢复与追溯 |
| `images` | 图片引用数组，每项 `{objectKey,filename,mime,size,sha256}`，由 `img add` / `img rm` 维护 |
| `attachments` | 预留，当前 CLI 不写入 |

**归档不是状态**：`status` 仍只有三档，归档是独立布尔。归档条目留在原位、不进 `total/done`、
不参与 `progress` 统计，但 `images` / `changes` / 正文全都保留；`project.archived` 单独计它们。

## 进度与派生规则（CLI 自动执行）

1. `issue set --status done` → `progress=100`；`--status todo` → `progress=0`。
2. `issue set --status doing`：不传 `--progress` 保持原值；传了则四舍五入并夹到 1–99。
3. 只传 `--progress` 时自动联动状态：0 → `todo`，1–99 → `doing`，100 → `done`；越界或非整数直接拒绝。
4. `issue set` 检测到字段变化时，往 `changes[issueId]` 头部插一条
   `{time, tool:"issue.set", change:"status: \"doing\" → \"done\""}`，最多留 20 条。
5. `issue move` 写一条 `tool:"issue.move"`，内容是 `原批次名 → 新批次名`；两个项目的 `done/total` 都重算。
6. `img add` / `img rm` 分别写入 `tool:"img.add"` / `tool:"img.rm"`。
7. 任何一次改动能成功落盘，都会把 `lastWrite` 更新为当前分钟，并把 `revision` +1。
8. `issue rm`（不带 `--hard`）写 `tool:"issue.archive"` 并打归档标记；`issue restore` 写 `tool:"issue.restore"` 并把 `updated` 刷成当前时间。
9. `issue add` 在写入前查重：同项目内标题归一后完全相同（score 1）或包含且短串占比 ≥0.6（score 0.9）即拦下，`--force` 才放行。
10. `total` / `done` 只数非归档条目；归档数进 `project.archived`。停滞只看非 done 且非归档的条目，阈值默认 3 天。

## 网页怎么用这份数据

- 项目卡显示：`priority` 角标、`name`、`summary`、`done/total` 进度条、`updated`。
- 详情抽屉：按 group 分节列 issue；每条显示状态点、`progress`、`type`、`note`、截图、`changes` 时间线。
- 页面**只读**，每 60 秒拉一次 `/api/listdeck/snapshot?k=<channel>`，ETag 未变走 304 不重渲染。

## 快照与本地文件的关系（临时文件 + TTL）

- 推送 / 连接：把当前 `projects.json` **整份** `POST` 到 `/api/listdeck/push?k=<channel>`，带 `x-sync-token`。
  `node scripts/connect.mjs listdeck` 也是同一个动作：覆盖并续期，不常驻。
- 服务器把正文放在系统临时目录 `<channel>.json`，原子覆盖；默认 10 分钟没有续期就删除。
  页面读取不续期，也不回 ack。服务器重启后，未过期的文件仍可读，过期文件会在启动和周期清扫中删除。
- 拉取：`GET /api/listdeck/snapshot?k=<channel>`，服务器 `revision` 更高才覆盖本地；
  两边都是旧格式、没有 `revision` 时才退回比较 `lastWrite`。

快照接口的三种返回：

| 状态 | 含义 | 你该做什么 |
| --- | --- | --- |
| `200` | 临时文件仍在有效期内，且客户端版本旧 | 取走并写浏览器缓存；文件继续保留到 TTL |
| `304` | 客户端 `If-None-Match` 与当前 etag 一致 | 什么都不做，本地这份就是最新的 |
| `503 channel_empty` | 没推过，或临时文件已超时删除 | 本机数据不动；`push` / `connect` 一次 |
