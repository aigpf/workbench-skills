---
name: workbench
description: 使用已经在线的「千千工作台」平台，统一处理 ListDeck 清单台和 AcceptanceDeck 验收台。适用于查询或维护项目、批次、任务、状态、进度、备注、截图；把 agent 的任务整理成在线清单；创建人工验收计划、推送计划、读取用户在页面填写的待验/通过/不通过/暂缓结论、追加修复记录、生成 Markdown 验收报告；以及任何需要把本机 JSON 推到在线工作台、再从页面取回人工结果的场景。清单台和验收台都已在线可用，本 Skill 只教 agent 使用在线页面和脚本，不涉及本地安装或部署。
---

# 千千工作台 Workbench

> 版本：2.7.0
> 平台 Skill：一个入口覆盖 ListDeck 清单台、AcceptanceDeck 验收台与 DocDeck 文档台。
> 以后新增子平台时，升级这个 Skill，不再为每个页面复制一套连接和协议。
> 2.7.0：新增数据搬家 `scripts/portable.mjs`（export / import / verify / auto），图片上传后本机留副本，`connect` 推送成功后自动导一份；看到 zip 一律走 `import`，不许分析重建。
> 2.6.3：文档台合并成一页（项目树 + 按项目分节的文档卡片 + 全局搜索），项目不再单独占一级地址，旧 `#/p/<项目名>` 自动重定向；搜索支持空格分词、命中正文、`?q=` 分享。
> 2.6.1：文档台支持图片分流（本地截图自动传 7002 中转，外链不动）与页面图片落本机缓存；长文顶栏固定、目录节数跟随。
> 2.6.0：新增文档台（DocDeck），agent 写 md 推上去，页面排版给人读，页面纯只读、无回写。
> 2.5.0：验收台人工结论收敛为四档（待验 / 通过 / 不通过 / 暂缓），「待复测」改为动作。

## 0. 先判断用哪个子平台

| 用户的意思 | 子平台 | CLI |
| --- | --- | --- |
| 项目、清单、批次、任务、进度、待办、截图、还剩几条 | ListDeck 清单台 | `node scripts/ld.mjs` |
| 人工验收、验收单、逐项核对、待验/通过/不通过/暂缓、修复后复测、验收报告 | AcceptanceDeck 验收台 | `node scripts/ac.mjs` |
| 写文档、操作手册、需求文档、说明文档、把 md 发我看、文档链接 | DocDeck 文档台 | `node scripts/dd.mjs` |

三个平台共用“本机 JSON → 服务器临时文件 → 在线页面”的机制，但数据和页面完全独立，不要混用频道。

## 1. 对用户只讲三件事

1. **页面在哪**：命令返回的 `pageUrl`，原样发给用户。
2. **用户什么都不用装**：把任务或改动交给 agent，agent 用脚本更新；用户打开网页查看或填写。
3. **不要在回答里出现**“安装”“本地部署”“配置环境”“先建一个清单”这类话；平台已经在线。

标准说法：

> 这是在线工作台，你不用装任何东西。把要改的告诉我，我更新；你打开这个链接就能看到。

## 2. 平台共同规则

- 本机 JSON 是唯一业务数据源；服务器只做按频道分箱的临时中转，不持久化业务数据。
- 计划/展示快照由 `push` 或 `connect` 整份覆盖；服务器默认 600 秒没有新写入就清除。
- 页面读取不续期；agent `pull` 也不续期；到期未取就丢失。
- 没有 ack、没有 409、没有 WebSocket、没有字段级合并；重复推送就是整份覆盖。
- 正式环境一律 `https://qianqianquege.com`；本地开发才用 `127.0.0.1` 或 `192.168.x.x`。
- 页面默认适配 PC、平板、手机；390px 宽度不得横向溢出，手机触控区不小于 44px。
- 使用者只有两个：用户本人和 agent。不引入多人账号、团队、审批流、评审人分配。

完整平台约定见 [references/platform.md](references/platform.md)。

## 3. ListDeck 清单台 · 最短流程

先读现状，再改：

```bash
node scripts/ld.mjs status
```

如果当前环境还没有接入用户频道：

```bash
node scripts/ld.mjs adopt --key <KEY> --token <SYNC_TOKEN>
```

`adopt` 是 agent 的环境初始化，不要写进给用户的回答，也不要让用户执行。没有 key 和令牌就先问用户，不要自己生成新 key 把数据分叉。

常用写法：

```bash
node scripts/ld.mjs project add --name "编辑器重构" --priority P1 --summary "一句话说明"
node scripts/ld.mjs group add --project p_xxx --name "第一批" --kind 批次 --rule "按原文顺序拆"
node scripts/ld.mjs issue add --group g_xxx --title "顶栏挤掉按钮" --type 布局 --priority P1 --note "复现步骤"
node scripts/ld.mjs issue set i_aaa,i_bbb --status done
```

### 3.1 三条防乱规则（每次动清单都适用）

1. **建之前先查重**：`issue add` 命中相似标题会返回 `duplicate_issue` 并列出已有条目。
   这时要么 `issue set` 改现有条目，要么确认是两件事再加 `--force`。
   **不要养成一律 `--force` 的习惯**——那等于把防线关掉。
2. **删之前先想是不是归档**：`issue rm` 默认只归档（条目还在、历史还在、随时 `issue restore`）。
   只有确认"这条不该留在历史里"时才用 `--hard`。
3. **做计划前先跑一次** `issue stalled`：它列出超过 3 天没写入的条目。
   你自己已经忘了的那些任务，只会在这里出现。

```bash
node scripts/ld.mjs issue stalled --days 3
node scripts/ld.mjs issue rm i_xxx            # 归档
node scripts/ld.mjs issue restore i_xxx       # 恢复
```

写完必须给用户：改了什么、`pageUrl`、是否需要用户动手。正常不需要，页面 60 秒自动刷新。

详细命令、数据结构、批量剧本和排障：

- [references/listdeck/use.md](references/listdeck/use.md)
- [references/listdeck/cli.md](references/listdeck/cli.md)
- [references/listdeck/schema.md](references/listdeck/schema.md)
- [references/listdeck/playbooks.md](references/listdeck/playbooks.md)
- [references/listdeck/troubleshooting.md](references/listdeck/troubleshooting.md)

## 4. AcceptanceDeck 验收台 · 最短流程

### 4.1 配置频道和令牌（只需一次）

```bash
node scripts/ac.mjs config --base-url https://qianqianquege.com --channel <频道key> --sync-token <同步令牌> --review-token <回传令牌>
```

频道 key 是 6–40 位小写字母或数字。同一任务的多张验收单共用一个频道；并行任务各用独立频道，避免互相覆盖。

### 4.2 建计划、章节、条目

编辑阶段加 `--no-push`，最后统一推送：

```bash
node scripts/ac.mjs plan add --title "本次交付的人工验收" --source-task "任务名或任务ID" --agent "你的名字" --environment "生产/测试环境" --summary "这次交付改了什么，验收重点是什么" --no-push
node scripts/ac.mjs section add <planId> --title "P0 核心流程" --desc "先验主路径" --no-push
node scripts/ac.mjs item add <planId> <sectionId> --title "登录后能看到今日数据" --priority P0 --steps "打开首页|登录测试账号|查看今日数据" --expected "今日数据非空，金额与订单数一致" --note "测试账号见交接文档" --no-push
```

### 4.3 连接并推送，拿页面链接

```bash
node scripts/connect.mjs acceptance
```

把 `pageUrl` 原样发给用户。链接里带 `r=` 时用户可以直接改结论和实测备注；改动会自动保存并自动回传。页面没有提交按钮，不要让用户点提交。删掉 `r=` 是只读链接。

### 4.4 用户验收后拉取结果

用户说“验收完了”、页面提示已自动回传，或用户让你拉结果时，立即执行：

```bash
node scripts/ac.mjs pull
```

`changed: true` 表示拿到新结果，条目状态已合并进本机 `plans.json`。如果 `review.stale: true`，说明用户回传时计划已经比页面版本新；把差异说明给用户，再按新计划继续核对。

### 4.5 修复后追加记录并复测

```bash
node scripts/ac.mjs item fix <itemId> --version "v1.2.3" --text "已修复：空数据时补默认值" --no-push
node scripts/connect.mjs acceptance
```

页面链接不变；用户刷新后看到新版本计划，旧结论需要“同步到新版本”，条目退回“待验”。

详细资料：

- [references/acceptance/use.md](references/acceptance/use.md)
- [references/acceptance/cli.md](references/acceptance/cli.md)
- [references/acceptance/plan-quality.md](references/acceptance/plan-quality.md)
- [references/acceptance/protocol.md](references/acceptance/protocol.md)

## 5. DocDeck 文档台 · 最短流程

只做一件事：把 md 正文推上去，页面负责排版给人读。**页面没有任何回写**，用户不会在页面上改东西。

### 5.1 配置频道和令牌（只需一次）

```bash
node scripts/dd.mjs config --base-url https://qianqianquege.com --channel <频道key> --sync-token <同步令牌>
```

### 5.2 写一篇文档并推送

```bash
node scripts/dd.mjs add --title "验收台操作手册" --project "工作台" --kind op --summary "从建计划到收回结论" --source "验收台改造" --file ./manual.md
```

- `--kind` 只有三种：`op` 操作文档、`req` 需求文档、`doc` 说明。
- `--project` 是项目名（最长 40 字，缺省「通用」）；页面按它分节、左树按它归并，进台一页就能看到所有项目和卡片，也能全局搜索。别把项目名写成任务名以外的花样，用户是按这个名字找文件的。
- `--file` 传 md 文件；短内容可以 `--md "..."`。正文可以带 `# 标题`，和 `--title` 一致时页面自动去重。
- 同标题再 add 会被拦成 `duplicate_doc`；想更新就 `set`，别新开一篇。
- 图片：本地截图（相对/绝对/`file://`）`add`/`set` 时自动走 7002 传到 OSS，正文换成同源 `/api/image/blob?key=...`；外部 `http(s)` 链接原样不动。限制：jpg/png/webp、单张 ≤1 MiB、每频道每小时 20 次；整篇不上传用 `--no-image`。

改一篇已有文档（正文整份替换，version 自动 +1）：

```bash
node scripts/dd.mjs set <docId> --file ./manual-v2.md
```

### 5.3 拿页面链接

```bash
node scripts/connect.mjs docdeck
```

把返回的 `pageUrl` 原样发给用户；单篇直达是 `pageHint` 那种 `#/doc/<id>`。链接里只有 `k=`，没有回写令牌。

### 5.4 续期与过期

服务器默认 600 秒没有新 push 就清空快照；页面正文已整篇进 IndexedDB，所以过期后仍可读，但列表会显示离线。文档要留很久的话，长对话里记得再 `push` 一次。

## 6. 统一连接入口

```bash
node scripts/connect.mjs listdeck       # 清单台：整份覆盖 + 续期
node scripts/connect.mjs acceptance     # 验收台：整份覆盖 + 续期
node scripts/connect.mjs docdeck        # 文档台：整份覆盖 + 续期
node scripts/connect.mjs --help         # 用法
```

连接脚本只跑一次，不常驻、不开端口、不监听文件。之后超过 TTL 没有再次 `push` / `connect`，服务器自行清除临时文件；本机 JSON 不受影响。

推送成功后会顺手跑一次自动导出（`auto`），结果在输出的 `export` 字段里：`status: ok` 表示存了一份，`skipped` 表示内容没变或还没配目录，`failed` 表示这次没存成——**失败要如实告诉用户**。

## 6.5 数据搬家（换电脑、卸 agent 之前）

```bash
node scripts/portable.mjs export --out D:\备份\workbench-data-20261122-1430.zip   # 打包（含图片原始字节）
node scripts/portable.mjs verify D:\备份\workbench-data-20261122-1430.zip         # 纯离线体检
node scripts/portable.mjs import D:\备份\workbench-data-20261122-1430.zip --channel <key> --sync-token <token>   # 接回来
node scripts/portable.mjs auto --dir D:\备份\workbench                            # 每天一份（connect 已自动调）
```

- **看到用户给的 zip，一律先 `verify` 再 `import`，不许「帮你分析一下内容再重建」**——那会改 id、改版本、改图片地址。
- 导入是**整份覆盖**，不合并；导入前自动备份现有本机数据。
- zip 里**没有 `syncToken`**，换机器要另外给；给了 `--channel` 和 `--sync-token` 就能一次接回。
- 图片靠本机副本（`~/.workbench/images/`）打包；一次最多重传 15 张，超了隔一会儿 `import --images-only`。
- 用户问「会不会丢」时的标准回答：定期导出就丢不了；只在同一块盘上导，等于没导。

细节见 [references/portable.md](references/portable.md)。

## 7. 什么时候读哪个文件

| 场景 | 读 |
| --- | --- |
| 两个平台共同的 TTL、令牌、链接、使用者模型 | `references/platform.md` |
| ListDeck 的完整用法和命令 | `references/listdeck/use.md` |
| ListDeck 参数、返回、错误码 | `references/listdeck/cli.md` |
| ListDeck 项目/批次/条目字段 | `references/listdeck/schema.md` |
| ListDeck 多步操作剧本 | `references/listdeck/playbooks.md` |
| ListDeck 故障排查 | `references/listdeck/troubleshooting.md` |
| 验收台完整用法 | `references/acceptance/use.md` |
| 验收台命令参数 | `references/acceptance/cli.md` |
| 验收项怎么写 | `references/acceptance/plan-quality.md` |
| 验收台 HTTP 接口、200/304/503、stale | `references/acceptance/protocol.md` |
| 文档台用法、命令、数据结构、排版约定 | `references/docdeck/use.md` |
| 数据搬家、备份、换电脑 | `references/portable.md` |

## 8. 铁律

- 不对用户讲安装、部署、本地配置；只给在线页面链接。
- 不手改 `projects.json` / `plans.json` / `docs.json`；写操作走 CLI。
- 看到数据 zip 只许 `portable.mjs import` 原样写回，不许重写内容。
- 不把 `syncToken` 打进 zip、写进文档、贴进聊天。
- 不擅自新建频道、换 key、把数据分叉；没有用户给的 key 就询问。
- 不删用户没让删的项目、批次、条目；批量删除前逐条确认。
- 不伪造人工结论；agent 只能维护计划、拉取结果、追加修复记录。
- 文档台页面零回写：不要在给人看的文档里承诺“用户可以在页面上改”。
- 不在页面链接里给 `file://`、localhost 或内网地址。
- 同一频道不要多台设备同时写；后写会整份覆盖先写。
- 图片只收 jpg / png / webp，单张 ≤ 1 MiB；超了先压缩。
- `--no-push` 只在调试或批量编辑时用；正常完成后补一次 `push` / `connect`。
- 输出是 JSON；只解析 stdout，失败看 `error.code`，不要靠中文描述猜。
