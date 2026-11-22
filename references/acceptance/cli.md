# 验收台 CLI 参考

所有命令从技能目录执行，统一输出 JSON。成功时 `ok: true`；失败时 `ok: false` 并带 `error.code` 与 `error.message`，退出码为 1。

## 环境与配置

| 变量 | 作用 |
| --- | --- |
| `ACCEPTANCE_HOME` | 本机数据目录，默认 `~/.workbench/acceptance`；测试时建议指向沙盒目录 |
| `ACCEPTANCE_BASE_URL` | 工作台地址，默认 `https://qianqianquege.com` |
| `ACCEPTANCE_CHANNEL` | 频道 key，6–40 位小写字母或数字 |
| `ACCEPTANCE_SYNC_TOKEN` | 推送/拉取结果的令牌 |
| `ACCEPTANCE_REVIEW_TOKEN` | 页面自动回传结论的令牌；会出现在页面链接的 `r=` 参数里 |
| `ACCEPTANCE_RELAY_TOKEN` | 图片证据上传令牌，可选 |

配置文件在本机 `ACCEPTANCE_HOME/config.json`，命令参数优先于环境变量。并行任务各用独立频道；同一任务的多张验收单共用一个频道。

```bash
node scripts/ac.mjs config --base-url https://qianqianquege.com --channel mychannel001 --sync-token <sync> --review-token <review>
node scripts/ac.mjs status
node scripts/ac.mjs doctor
```

`doctor` 会检查本机数据目录和服务器 `/health`；不要把它当作页面验收，页面验收由用户完成。

## 计划

```bash
node scripts/ac.mjs plan add --title "<标题>" --source-task "<任务名>" --agent "<agent名>" --environment "<环境>" --summary "<说明>" [--id <planId>] [--no-push]
node scripts/ac.mjs plan update <planId> --title "<新标题>" --summary "<新说明>" --environment "<环境>" [--no-push]
node scripts/ac.mjs plan import --file plan.json [--no-push]
node scripts/ac.mjs plan list
node scripts/ac.mjs plan rm <planId> [--no-push]
```

- `planId` 不传时自动生成；只能用字母、数字、下划线、短横线，长度 1–64。
- `plan update` 只改标题、说明、环境；版本会加一。
- `plan import` 接受单个计划对象或 `{ "plans": [...] }`。导入后会补齐缺失的 id、版本、时间和统计字段。
- 一份计划最多 100 个章节、每章最多 100 个条目；一个频道最多 100 张计划。

## 章节

```bash
node scripts/ac.mjs section add <planId> --title "<章节标题>" --desc "<章节说明>" --no "<01>" [--id <sectionId>] [--no-push]
node scripts/ac.mjs section rm <planId> <sectionId> [--no-push]
```

`section add` 返回新建的 `section.id`，后续 `item add` 要用它。`--no` 是显示编号，不是排序主键；默认取下一个两位编号。

## 条目

```bash
node scripts/ac.mjs item add <planId> <sectionId> --title "<验收项>" --priority P0 --steps "第一步|第二步" --expected "<预期结果>" --note "<agent说明>" [--id <itemId>] [--no-push]
node scripts/ac.mjs item update <itemId> --title "<新标题>" --expected "<新预期>" --note "<新说明>" --priority P1 --steps "新步骤1|新步骤2" [--no-push]
node scripts/ac.mjs item fix <itemId> --text "<修复说明>" --version "<版本>" [--no-push]
node scripts/ac.mjs item rm <itemId> [--no-push]
```

- `priority` 只接受 `P0`、`P1`、`P2`；不传则为空。
- `steps` 用 `|` 分隔多条，最多 20 条；也可以直接传一段文字。
- `expected` 写用户能观察到的结果，不要写“代码正确”这种无法核对的描述。
- `item fix` 追加一条只读修复记录，并把所属计划版本加一；不会改变人工结论。
- `item update` 用全局 `itemId` 定位，不要求传计划 id。

## 证据

```bash
node scripts/ac.mjs evidence add <itemId> --text "<证据文字>"
node scripts/ac.mjs evidence add <itemId> --url "https://..." --label "<链接名>"
node scripts/ac.mjs evidence add <itemId> --image ./shot.png
```

- 文字和链接证据只写入计划，不需要额外令牌。
- 图片证据先上传 image-relay，再把对象信息写入计划；需要 `ACCEPTANCE_RELAY_TOKEN`，并且工作台 image-relay 可用。上传失败时退回文字描述或链接，不要卡住整个验收计划。
- 单条证据最多 24 个；文字最多 5000 字符，链接必须是 http/https。

## 推送与拉取

```bash
node scripts/ac.mjs push
node scripts/ac.mjs pull
node scripts/connect.mjs acceptance
```

- `push` / `connect.mjs` 都是把本机全部计划整份覆盖到频道，同时刷新计划 TTL。
- 区别：`connect.mjs` 是一次性连接/续期脚本，只推当前计划并打印页面链接，适合交付时调用；`push` 是普通写命令的自动推送入口。
- `pull` 拉取该频道最新人工结果，合并进本机。它不会续期，也不会删除服务器结果。
- `pull` 后如果控制器有写入，会自动再 `push` 一次，让页面看到合并后的最新计划版本。
- 结果只保留最新一份；页面每次改动都会自动回传，整份覆盖前一次。

## 报告

```bash
node scripts/ac.mjs report <planId>
node scripts/ac.mjs report <planId> --out report.md
```

不带 `--out` 时把 Markdown 打到 stdout；带 `--out` 时写文件并返回路径。报告包含计划说明、章节、条目、人工状态、实测备注和修复记录。

## 本机数据

`ACCEPTANCE_HOME` 下：

```text
plans.json   计划、章节、条目、修复记录、最近人工结果
config.json  地址、频道、令牌
```

`plans.json` 是唯一计划源。不要手工改服务器文件；需要改计划就用 CLI 或 `plan import`，然后重新推送。
