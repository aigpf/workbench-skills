# 千千工作台 · Workbench Skill

给 AI agent 用的一个技能：把「清单、验收、文档」三件事放到三个在线页面上，再配一个能带走的 zip 备份。
This repository is a skill for AI agents: three online decks for task lists, acceptance, and documents, plus a portable zip backup.

---

## 中文

### 这是什么

一个 skill，入口只有一个：`workbench`。agent 学会之后，你在聊天里说一句话，它就把数据推到在线页面，你打开链接看；你在页面上点结论，它再把结果拉回来。

页面什么都不用装，也不用注册账号。数据存在**你自己的电脑**上，服务器只做临时中转（默认 10 分钟没有新写入就清空）。

| 台 | 干嘛的 | 页面权限 |
| --- | --- | --- |
| **清单台** ListDeck | 项目 → 批次 → 任务，带优先级、进度、备注、截图 | 只读，agent 写 |
| **验收台** AcceptanceDeck | 把交付拆成一条条验收项，你在网页上点结论 | 带 `r=` 的链接可填，其余只读 |
| **文档台** DocDeck | md 推上去变成能读的网页，按项目分节、能搜能下载 | 纯只读，零回写 |

### 能干什么

清单台：建项目、拆批次、加任务、改进度、批量标完成、跨批次挪、加/删截图、列出超过三天没动的条目、归档与恢复、整库汇总。

验收台：建验收单（标题/来源任务/环境/重点）、分章节、写步骤与预期、挂文字或链接证据、生成可填结论的链接、拉回结论（待验 / 通过 / 不通过 / 暂缓）、修复后升版本复测、导出 `report.md`。

文档台：把 md 变成网页、按项目归类（`op` 操作文档 / `req` 需求文档 / `doc` 说明）、正文搜索、搜索结果可分享、定位到某一节、下载 md、手机上表格横滑。

备份搬家：`export` 打包成 zip（含图片原始字节）、`verify` 离线体检、`import` 整份接回、`auto` 每次推送后自动存一份。

### 怎么接进 agent

把整个目录放进 agent 的 skills 目录，目录名建议用 `workbench`（技能 id 以 `SKILL.md` 里的 `name` 为准）：

```text
<agent workspace>/.skills/workbench/SKILL.md
<agent workspace>/.skills/workbench/scripts/…
<agent workspace>/.skills/workbench/references/…
```

运行环境需要 **Node ≥ 18**。之后在聊天里正常说话就行，例如：

> 使用千千工作台技能，把「编辑器重构」这些活记成一个清单，我后面边做边更新

> 使用千千工作台技能，把这次交付做成一张验收单，我一项一项点

> 使用千千工作台技能，把这份 md 变成网页，我要发给人看

英文说 `使用 workbench 技能` 也认，是同一个技能。**46 个现成说法**在 [`docs/usage-guide.html`](docs/usage-guide.html)，浏览器直接打开即可。

### 第一次用要做的两件事

频道 key 和同步令牌由你提供，agent 只负责写进它自己的本机配置，不会自己造新频道把数据分叉：

```bash
node scripts/ld.mjs adopt --key <KEY> --token <SYNC_TOKEN>
node scripts/ac.mjs config --base-url https://qianqianquege.com --channel <KEY> --sync-token <TOKEN> --review-token <REVIEW_TOKEN>
node scripts/dd.mjs config --base-url https://qianqianquege.com --channel <KEY> --sync-token <TOKEN>
```

### 数据与隐私

- **本机 JSON 是唯一数据源**：`~/.workbench/listdeck/projects.json`、`~/.workbench/acceptance/plans.json`、`~/.workbench/docdeck/docs.json`。
- 服务器只按频道分箱，**临时中转**；默认 600 秒没有新的推送就清除。页面读取和 `pull` 都不续期。
- 没有 ack、没有字段级合并：重复推送就是整份覆盖。
- 图片只收 jpg / png / webp，单张 ≤ 1 MiB，每频道每小时 20 次上传；对象约 45 分钟后清扫，页面靠浏览器缓存继续显示。
- 仓库里**不含任何令牌**；`syncToken` 不会进 zip、不进文档、不进聊天。

### 备份和换电脑

```bash
node scripts/portable.mjs export --out D:\backup\workbench-20261122-1430.zip
node scripts/portable.mjs verify D:\backup\workbench-20261122-1430.zip
node scripts/portable.mjs import D:\backup\workbench-20261122-1430.zip --channel <KEY> --sync-token <TOKEN>
```

导入是**整份覆盖**，导入前自动把现有本机数据备份到 `~/.workbench/.backup/<时间戳>/`。看到 zip 只许 `import`，不许「分析一下重建」——那会改 id、改版本、改图片地址。

### 目录结构

```text
SKILL.md                 技能定义（何时用、最短流程、铁律）
references/              三个台的完整用法、命令、数据结构、排查
  platform.md            三个台共用的 TTL / 令牌 / 使用者模型
  listdeck/              清单台：use / cli / schema / playbooks / troubleshooting
  acceptance/            验收台：use / cli / plan-quality / protocol
  docdeck/use.md         文档台
  portable.md            数据搬家
scripts/                 唯一入口：ld.mjs / ac.mjs / dd.mjs / connect.mjs / portable.mjs
  lib/                   内部模块（按台分目录）
docs/usage-guide.html    46 个示例说法（搜「你想干的事」就有）
```

### 不做什么

- 不做账号体系、团队、审批流、评审人分配；页面只有两个使用者：**你本人和 agent**。
- 不在用户机器上起常驻服务、开端口、监听文件。
- 文档台零回写；不伪造人工结论；不替你把状态改成「通过」。
- 不手改本机 JSON，写操作一律走 CLI。

---

## English

### What this is

A single skill, one entry point: `workbench`. Once installed, you say something in chat, the agent pushes data to an online deck and hands you a link. You read (or tick) on the page; the agent pulls the result back.

Nothing to install for the reader, no sign-up. Your data lives **on your own machine**; the relay server keeps a channel snapshot for 10 minutes by default and then clears it.

| Deck | What it holds | Page access |
| --- | --- | --- |
| **ListDeck** (清单台) | projects → batches → tasks, with priority, progress, notes, screenshots | read-only, agent writes |
| **AcceptanceDeck** (验收台) | a delivery split into checkable items you tick | links with `r=` can write, others read-only |
| **DocDeck** (文档台) | markdown published as a readable page, grouped by project, searchable, downloadable | strictly read-only |

### Capabilities

ListDeck: create projects, split batches, add tasks, update progress, bulk-complete, move across batches, attach or remove screenshots, list items untouched for 3+ days, archive and restore, whole-library summary.

AcceptanceDeck: create a plan (title / source task / environment / focus), add sections, write steps and expected results, attach text or link evidence, mint a fillable link, pull conclusions (pending / pass / fail / hold), add fix records and bump the version, export `report.md`.

DocDeck: publish markdown, group by project (`op` how-to / `req` spec / `doc` note), full-text search, shareable search links, deep links to a section, download the original `.md`, horizontally scrollable tables on mobile.

Backup: `export` to a zip (original image bytes included), `verify` offline, `import` to restore wholesale, `auto` a copy after every push.

### Install

Drop the whole folder into your agent's skills directory; a folder named `workbench` is recommended (the id comes from `name:` in `SKILL.md`):

```text
<agent workspace>/.skills/workbench/SKILL.md
<agent workspace>/.skills/workbench/scripts/…
<agent workspace>/.skills/workbench/references/…
```

Requires **Node ≥ 18**. Then just talk:

> Use the workbench skill to turn what I just listed into a task list I can watch.

> Use the workbench skill to turn this delivery into an acceptance sheet I can tick item by item.

> Use the workbench skill to publish this markdown as a page I can send to someone.

46 ready-made phrasings live in [`docs/usage-guide.html`](docs/usage-guide.html) (Chinese UI, open it in a browser).

### Data & privacy

- Your local JSON is the single source of truth (`~/.workbench/{listdeck,acceptance,docdeck}/*.json`).
- The server is a **temporary relay** per channel; snapshots expire after 600 s without a new push. Page reads and `pull` do not extend them.
- No acks, no field-level merge: a push replaces the whole snapshot.
- Images: jpg / png / webp only, ≤ 1 MiB each, 20 uploads per channel per hour; objects are swept after roughly 45 minutes while the page keeps a browser-side cache.
- **No tokens in this repository.** `syncToken` never enters a zip, a document, or a chat message.

### Backup and machine migration

```bash
node scripts/portable.mjs export --out D:\backup\workbench-20261122-1430.zip
node scripts/portable.mjs verify D:\backup\workbench-20261122-1430.zip
node scripts/portable.mjs import D:\backup\workbench-20261122-1430.zip --channel <KEY> --sync-token <TOKEN>
```

Import **overwrites** the whole local dataset and backs up the current one to `~/.workbench/.backup/<timestamp>/` first. Given a zip, only `import` it — never "read it and rebuild", which would rewrite ids, versions and image URLs.

### Layout

```text
SKILL.md                 skill definition: when to use, shortest path, hard rules
references/              per-deck usage, CLI, schema, troubleshooting
  platform.md            shared TTL / tokens / two-user model
  listdeck/              listdeck: use / cli / schema / playbooks / troubleshooting
  acceptance/            acceptance: use / cli / plan-quality / protocol
  docdeck/use.md         docdeck
  portable.md            backup and migration
scripts/                 entry points: ld.mjs / ac.mjs / dd.mjs / connect.mjs / portable.mjs
  lib/                   internal modules, grouped per deck
docs/usage-guide.html    46 example phrasings
```

### Out of scope

- No accounts, teams, approval flows, reviewer assignment; the only two users are **you and the agent**.
- No daemon, no open port, no file watching on your machine.
- DocDeck never writes back; the agent never fabricates a human verdict.
- Local JSON is never edited by hand; all writes go through the CLI.

---

## License

MIT © 2026 aigpf — see [LICENSE](LICENSE).
