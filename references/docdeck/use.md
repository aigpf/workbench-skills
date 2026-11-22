# DocDeck 文档台 · 用法

文档台只有一个功能：agent 把 md 正文推上去，页面把它排成能读的样子。
**页面纯只读，没有任何回写接口、没有提交令牌**——用户不会在页面上改任何东西。

## 1. 什么时候用它

- 用户说“给我写一份 xxx 的操作手册 / 需求文档 / 说明”，或“把这份 md 发我看”。
- 需要一份能长期回看的固定页面，而不是塞在聊天窗口里。

不要用它装这些：任务进度（清单台）、验收结论（验收台）、图片/压缩包/网页（直接给链接）。

## 2. 初始化（只做一次）

```bash
node scripts/dd.mjs config --base-url https://qianqianquege.com --channel <频道key> --sync-token <同步令牌>
```

- 频道 key：6–40 位小写字母或数字。同一批文档共用一个频道。
- 同步令牌只存在本机 `~/.workbench/docdeck/config.json` 和服务器环境变量。
- 本机数据在 `~/.workbench/docdeck/docs.json`，是唯一事实源。

## 3. 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 本机篇数、频道是否就绪、服务器快照状态、页面链接 |
| `page` | 只输出 `pageUrl` |
| `list` | 列出本机文档（`--kind op|req|doc` 过滤），按更新时间倒序 |
| `add` | 新增：`--title --project --kind --summary --source --file <md>|--md "正文" [--id] [--force]` |
| `set` | 更新：`set <id> --file <md> [--project]`，正文整份替换，version 自动 +1 |
| `rm` | 删除：`rm <id>`；本机删除，不自动推送 |
| `show` | 输出某篇正文 md：`show <id>` |
| `push` | 整份覆盖推送到服务器并续期 |

`--project` 是项目名（最长 40 字），不写就是「通用」。页面按它分节、左树按它归并，服务端也必须保留这个字段（漏了就会全落到「通用」）。

`add` / `set` / `rm` 默认写盘后立刻推送；`--no-push` 只用于批量编辑，最后补一次 `push` 或 `node scripts/connect.mjs docdeck`。

### 图片：本地走中转，外链不动

`add` / `set` 会自动扫 `![alt](url)`：

| md 里的写法 | 处理 |
| --- | --- |
| `./a.png`、`../img/a.png`、`D:\shots\a.png`、`file:///...` | 读字节 → image-relay（7002）presign → PUT OSS → 正文换成 `<baseUrl>/api/image/blob?key=ld/...` |
| `https://`、`//`、`data:`、`blob:`、`/xxx.png` | 原样保留，不看也不下载 |

- 返回体的 `images` 给明细：`{ uploaded, missing, failed, kept }` 计数，`uploaded` 里有 from/to/objectKey/size。
- 单张失败不中断：失败的那张保留原路径，页面显示虚线占位。
- 整篇不上传：加 `--no-image`。
- 硬限制（来自 7002）：仅 jpg/png/webp，单张 ≤ 1 MiB，每频道每小时 20 次上传；同一路径一篇内只传一次。超限就先压缩或拆图。
- 配置：`config --relay-url http://127.0.0.1:7002 --relay-token <可选>`；默认 `relayUrl = baseUrl`，线上靠 nginx `/api/image/` 反代，通常不用改。
- 对象会被 image-relay 按年龄清扫（约 45 分钟），页面必须把字节落 IndexedDB（库 `docdeck` store `images`），否则文档放一会儿就掉图。

## 4. 数据结构

`docs.json`：

```json
{
  "schemaVersion": 1,
  "channel": "docdecktest",
  "revision": 3,
  "lastWrite": "2026-11-21 22:39",
  "docs": [
    {
      "id": "d-20261121-srqp",
      "title": "验收台操作手册",
      "kind": "op",
      "summary": "从建计划到收回结论的完整流程",
      "source": "验收台改造",
      "project": "工作台",
      "version": 1,
      "updatedAt": "2026-11-21 22:39",
      "chars": 966,
      "md": "# 标题\n\n正文……"
    }
  ]
}
```

- `kind` 三种：`op` 操作文档 / `req` 需求文档 / `doc` 说明。
- `id` 由标题生成（`d-YYYYMMDD-<slug>-xxxx`），只允许小写字母数字和 `-` `_`。
- `chars` 是去掉空白后的字数，页面按 300 字/分钟估阅读时长。
- `project` 是项目名（缺省「通用」）；页面按它分节与归并，服务端必须保留这个字段。
- 单篇默认上限 400000 字符；超了拆成多篇。

推送体就是整份 `docs.json`，服务端会再校验一遍（id 合法、标题非空、正文非空、id 不重复），服务端会把 `docs` 规整成同一字段顺序。

## 5. 页面行为

- 两层：`#/docs` 合并页（左侧项目树 + 按项目分节的文档卡片）→ `#/doc/<id>` 阅读。
- 项目与文档在同一页：不再有「先项目卡片、再项目内列表」两次跳转。项目是页内段落，不单独占一级地址。
- 左树：项目名带篇数，下面列该项目的文档标题；默认全展开，箭头只控制折叠；点项目名滚到对应段落，点文档标题滚到那张卡片（树里不放超链接，地址栏不变）。≤1000 收成页内块，由搜索框左边的「目录」按钮展开。
- 全局搜索：空格分词 AND，命中项目名 / 标题 / 摘要 / 来源任务 / 整篇正文；项目名命中的整段放出并标「项目名命中」，其余只留命中的篇；标题摘要里命中的字高亮；`×` 或 `Esc` 清空并回焦；`#/docs?q=<词>` 可分享搜索结果。
- 卡片：类型 chip + `vN`、标题、两行摘要、字数 / 约 N 分钟 / 更新时间；三列（≤1200 两列、≤680 一列）。
- 深链：`#/docs?p=<项目名>` 进页落到该项目段落；旧链接 `#/p/<项目名>` 自动重定向到这里。
- 阅读：左侧目录（h2/h3）跟随滚动高亮，正文最大 820px；顶栏 sticky，长文滚到中段返回键仍在。
- 长文辅助：右下 `↑`（回顶）/ `↓`（到文末）仅在超过两屏时出现；目录标题旁显示 `当前节/总节数`。
- 锚点与位置：点目录改地址栏为 `#/doc/<id>?at=<节id>`，可分享到某一节；刷新同一篇回到上次读到的位置（localStorage，24 小时内），从列表点进来仍从头读；合并页也记 `dd:pos:docs:<频道>`，刷新回到原来那一屏。
- 顶栏「下载 .md」：用快照里的原文生成 Blob 下载，文件名是标题 + `.md`，服务端不另存。
- 离线：快照 600 秒过期后，页面仍能从 IndexedDB 读整篇正文，顶栏 chip 变橙色「离线 · 缓存 …」。
- 手机 390：正文 15px，表格保留横滑并显示「表格可左右滑动 →」，页面本身不横向溢出，触控区 ≥44px。

## 6. md 排版约定

页面能处理：h2/h3 目录、代码块（右上角复制）、表格（横向滚动壳）、图片、引用、有序/无序列表。

写文档时注意：

1. 开头写 `# 标题` 可以，和 `--title` 一致时页面自动去掉，不会出现双标题。
2. 图片：本地截图直接写相对路径或绝对路径，`add` 时会自动传中转并换成同源地址；外部图片写完整 `https://` 地址，会原样保留。两种都行，别再手抄 `api/image/blob`。
3. 变更说明写进正文（比如文末「本次改动」），页面不做版本 diff，只显示 `vN`。
4. 表格最少给到手机能横滑的宽度，别塞十列——手机上没人愿意左右拖三次。
5. 不要放 `<script>`、`<iframe>`、表单控件：渲染层会直接删掉。

## 7. 常见错误

| `error.code` | 意思 | 怎么办 |
| --- | --- | --- |
| `duplicate_doc` | 已有同标题文档 | 用 `set <docId>` 更新，确认是新文档才 `--force` |
| `channel_invalid` | 没配频道或 key 不合规 | `dd config --channel <key>` |
| `sync_token_invalid` | 令牌不对 | 重新 `dd config --sync-token <token>` |
| `channel_empty` | 服务器快照过期或没推过 | `node scripts/connect.mjs docdeck` |
| `validation_failed` | 正文空、id 非法、超大 | 看 message 改数据 |

## 8. HTTP 接口（给排查用）

- `POST /api/docdeck/push?k=<channel>`，头 `x-sync-token`，体是整份快照；返回 `{ok,data:{docs,revision,etag,ttlSeconds,expiresAt}}`。
- `GET /api/docdeck/snapshot?k=<channel>`，`200` / `304`（ETag 未变）/ `503 channel_empty`；响应头带 `X-Snapshot-Age`、`X-Snapshot-Expires`。
- `GET /health?k=<channel>`：服务与频道状态。
- 端口 7004，临时目录 `/tmp/docdeck-relay`，默认 TTL 600 秒。
