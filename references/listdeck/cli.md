# ld.mjs 命令参考

入口：`node scripts/ld.mjs <命令> [位置参数] [--flag 值]`

- 输出**永远**是 JSON：成功 `{ "ok": true, ... }`，失败 `{ "ok": false, "error": { "code", "message" } }`，失败退出码非 0。
- **JSON 只写 stdout**，进度和失败说明写 stderr。agent 只解析 stdout，不要把两者合并后再解析。
- 支持 `--flag=值` 和 `--flag 值` 两种写法；`-h` 等同于 `help`。
- 所有写命令默认「先 pull → 再改 → 再 push」，可用 `--no-pull` / `--no-push` 单独关闭（只在调试时用）。

## 全局命令

| 命令 | 说明 | 返回要点 |
| --- | --- | --- |
| `help` | 命令清单与示例 | `usage` / `commands` / `examples` |
| `version` | 本 skill 版本、Node 版本、数据文件路径 | `skill` `version` `node` `dataFile` |
| `doctor` | 体检：Node、数据完整性、频道、令牌、网络 | `ok`、`checks[]`（每项 `name/ok/level/detail`）、`summary` |
| `status` | 概览 | `channel` `pageUrl` `dataFile` `lastWrite` `revision` `projects[]` `counts` `guide` |
| `key` | 只要频道 key | `channel` `pageUrl` `syncUrl` |
| `url` | 只要页面地址 | `url` |
| `config` | 查看/修改本机配置（不推送） | 设置时 `updated:true`；查看时令牌只报 `syncTokenSet` |
| `push` | 把当前 `projects.json` 整份覆盖到服务器临时文件并续期 | `{ok,channel,data:{channel,etag,projects,ttlSeconds,expiresAt}}` |
| `pull` | 拉频道最新，服务器 `revision` 更新才覆盖本地 | `{pulled,lastWrite,revision,projects}` |
| `adopt --key <key> [--token <token>] [--url <url>]` | 接入已有频道：写 key（可选令牌/地址）并立即 pull | `{channel,pageUrl,pulled,projects?}`；频道为空时带 `note` |
| `backup` | 备份当前数据到 `~/.workbench/listdeck/backups/`，保留最近 20 份 | `{file,kept}` |

`config` 支持的 flag：

| flag | 含义 |
| --- | --- |
| `--sync-url <url>` | 快照服务根地址，默认 `https://qianqianquege.com` |
| `--sync-token <token>` | 推送令牌（服务器 `SYNC_TOKEN` 同值），写操作必需 |
| `--relay-url <url>` | 图片中转地址，默认跟 `syncUrl` 同域 |
| `--relay-token <token>` | 图片中转令牌，一般留空 |

环境变量（优先级高于 `config.json`）：`LD_DATA_DIR`、`LD_CHANNEL`、`LD_SYNC_URL`、`LD_SYNC_TOKEN`、`LD_RELAY_URL`、`LD_RELAY_TOKEN`、`LD_BOOTSTRAP_FROM`、`TZ_NAME`。

首次运行会生成 20 位频道 key 并写进 `~/.workbench/listdeck/config.json`。**接入别人的清单时先 `adopt`，不要先跑别的命令**。

## 临时邮筒与连接续期

服务器把快照放在系统临时目录的 `<channel>.json` 中。`push` 或一次性连接脚本都会**整份覆盖并续期**：

```bash
node scripts/connect.mjs listdeck
```

- `connect.mjs` 不常驻、不开端口，执行完就退出；返回 `connected`、`ttlSeconds`、`expiresAt`。
- 默认 10 分钟没有 `push` / `connect` 续期，服务器自动删除临时文件；页面读取**不续期**。
- 新数据总是整份覆盖；本机 `projects.json` 永不被清除。

| 状态 | 含义 | CLI 的表现 |
| --- | --- | --- |
| `200` | 临时文件仍在有效期内 | `pull` 在服务器 `revision` 更高时覆盖本地；旧数据没有 `revision` 时退回比较 `lastWrite` |
| `304` | ETag 没变 | 不下载、不重渲染 |
| `503 channel_empty` | 没推过，或临时文件已超时删除 | `pull` 回 `empty:true`，本机数据不动；`push` / `connect` 一次即可 |

## project

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `project list` | — | `projects` 原样（`id/name/priority/summary/note/updated/done/total`） |
| `project add` | `--name`（必填、唯一）`--priority`（必填）`--summary` `--note` | `project` |
| `project set <id>` | 至少一个：`--name` `--priority` `--summary` `--note`（传空串即清空） | `project` |
| `project rm <id>` | — | `removed`，连带删掉该项目的 groups 与 changes |

`priority` 枚举：`P0` `P1` `P2` `验证` `约束`。

## group（子类）

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `group list` | 可选 `--project p_x` | 不带项目时返回整张 groups 表 |
| `group add` | `--project`（必填）`--name`（必填）`--kind`（`批次`/`主题`，默认主题）`--rule` `--note` | 新增一个子类 |
| `group set <gid>` | `--project`（必填）+ 任意 `--name` `--kind` `--rule` `--note` | 改子类 |
| `group rm <gid>` | `--project`（必填） | 删子类，连带删掉其下所有条目与变更记录 |

## issue（条目）

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `issue list` | 可选 `--project` `--group` `--status` `--archived` `--all` | 默认只看活条目；`--archived` 只看归档，`--all` 全给。每条带 `projectId/groupId/groupName/idleDays` |
| `issue add` | `--group`（必填，找不到会跨项目搜）`--title`（必填）`--type` `--priority` `--status`（默认 todo）`--progress` `--note` `--force` | 新条目 `images`、`attachments` 为空数组。**同项目内按标题查重**，命中返回 `duplicate_issue`；`--force` 才建，结果带 `duplicates` |
| `issue set <id[,id2,…]>` | `--status` `--progress` `--title` `--note` `--type` `--priority` | 批量用逗号；状态变了会重算 progress 并写一条 changes |
| `issue move <id>` | `--to <gid>` | 跨项目也能挪，两个项目的 total/done 都会重算 |
| `issue rm <id[,id2,…]>` | `--hard` | **默认只归档**：打 `archived/archivedAt/archivedFrom`，条目留在原位，图片与变更记录都保留，不进 `total/done`，计入 `project.archived`。`--hard` 才真删并清 `changes` |
| `issue restore <id[,id2,…]>` | — | 从归档恢复：清三个归档字段、刷新 `updated`、写一条 `issue.restore`。不在归档里的条目返回 `validation_failed` |
| `issue stalled` | `--days N`（默认 3）`--project` | 列出非 done、非归档且 `updated` 超过 N 天没写入的条目，按 `idleDays` 倒序；查计划前先跑一次。无结果时带 `note` |

`issue add` 的查重口径：标题去掉空白与常见中英文标点后，完全相同记 1、包含且短串占比 ≥0.6 记 0.9，否则不算相似。
命中时消息里会列出前 3 条（`id`、标题、子类、状态），并提示「要改现有的用 `issue set`」——**不要为了绕过它而一律 `--force`**。

`issue stalled` 是清单台唯一不依赖 agent 自觉的信号：agent 忘了这条，自己报告不了，但 `updated` 停在那里，时间会说话。

进度规则：`done` 恒 100，`todo` 恒 0，`doing` 收在 1–99。
只传 `--progress`、不传 `--status` 时，状态自动按 `0 → todo / 1–99 → doing / 100 → done` 联动；
显式传了 `--status` 就以状态为准。进度必须是 0–100 的整数。

## img

`img add <issueId> --file <路径>`

- 支持 jpg / png / webp，单张 ≤ 1 MiB。
- 流程：先确认条目存在 → 算 sha256 → `POST {relayUrl}/api/image/presign` 取 PUT 凭证 → 直传 OSS → 把 `{objectKey,filename,mime,size,sha256}` 追加到该条目的 `images`。
- 上传凭据就是频道 key（请求头 `x-ld-key`）；服务器若另配了 `RELAY_TOKEN`，脚本会自动带上。
- 图片是短命中转：桶内 30–45 分钟轮转清扫，页面拉到后会存进 OPFS，按 sha256 命名，之后不再依赖桶。

`img rm <issueId> <objectKey>` 或 `img rm <issueId> --key <objectKey>`

- 从该条目的 `images` 删除引用并写变更记录，找不到条目或引用会返回 `not_found`。
- **只删引用**，不把 OSS 删除令牌写进快照；原对象由 image-relay 的轮转清扫自动回收。

## guide

`guide set --file <json>`：整份替换 `guide`，自动补 `updatedAt`。

```json
{
  "title": "ListDeck 怎么用",
  "intro": "页面只读，写入走本机脚本。",
  "sections": [
    {
      "id": "how",
      "tag": "快速上手",
      "title": "三句话",
      "body": "……",
      "rows": [["命令", "作用"]],
      "prompts": ["把这条标成完成"],
      "code": "node scripts/ld.mjs status"
    }
  ]
}
```

`sections` 每段最多 8 行 `rows`、6 条 `prompts`；`rows` 是两元组数组，页面按表格渲染。

## 返回里的推送字段

写命令的结果里除了业务字段，还会有：

| 字段 | 含义 |
| --- | --- |
| `pushed` | 是否推送成功 |
| `pushError` | 失败原因，如 `HTTP 401` |
| `pushDetail` | 服务器返回的错误体片段（如 `sync_token_invalid`） |
| `pushHint` | 面向 agent 的下一步建议 |

推送失败**不会**让命令失败：数据已经落盘，修好网络或令牌后执行一次 `push` 即可。

## 错误码

| code | 含义 |
| --- | --- |
| `node_too_old` | 运行环境的 Node 低于 18 |
| `missing_arg` | 缺必填参数 |
| `validation_failed` | 枚举值不对、项目重名、key 格式不对、条目不在归档里 |
| `not_found` | 项目 / 子类 / 条目找不到 |
| `bad_command` | 子命令写错 |
| `data_corrupt` | `projects.json` 不是合法 JSON 或缺 `projects` 数组 |
| `error` | 其它运行时错误（网络、OSS、磁盘） |
