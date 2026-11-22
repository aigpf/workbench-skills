# 验收台 AcceptanceDeck

## 这个技能做什么

验收台是千千工作台的在线页面。agent 负责**写验收计划并推送**，用户在网页上**逐项点结论、写实测原因**，agent 再**拉回结果**继续修复或收尾。

关键边界：

- 用户只需要打开一个网页链接。不要指导用户安装 Node、npm、脚本、浏览器插件或本技能。
- 不要提“本地安装 listdeck”或复用 ListDeck 的安装说明；验收台不是本地软件。
- 页面已经适配 PC、平板、手机；agent 不需要为不同设备另做页面。
- 计划是 agent 维护的只读内容；人工结论只存在用户浏览器草稿和临时结果邮筒里。

## 最短流程

在技能目录下执行。所有命令都输出 JSON。

1. 配置频道与令牌（只需一次，之后会保存在本机）：

```bash
node scripts/ac.mjs config --base-url https://qianqianquege.com --channel <频道key> --sync-token <同步令牌> --review-token <回传令牌>
```

`频道key` 是 6–40 位小写字母或数字；同一频道下的多张验收单会一起出现在页面。并行任务各用独立频道，避免互相覆盖；同一任务的多张验收单共用一个频道。不要把生产令牌写进 Skill 源文件或提交到公开仓库。

2. 建计划、章节和条目。编辑阶段加 `--no-push`，最后统一推送，避免每改一项都产生一次快照：

```bash
node scripts/ac.mjs plan add --title "本次交付的人工验收" --source-task "任务名或任务ID" --agent "你的名字" --environment "生产/测试环境" --summary "这次交付改了什么，验收重点是什么" --no-push
node scripts/ac.mjs section add <planId> --title "P0 核心流程" --desc "先验主路径" --no-push
node scripts/ac.mjs item add <planId> <sectionId> --title "登录后能看到今日数据" --priority P0 --steps "打开首页|登录测试账号|查看今日数据" --expected "今日数据非空，金额与订单数一致" --note "测试账号见交接文档" --no-push
```

3. 可选：给条目补充证据。文字和链接最稳；图片证据依赖 image-relay，未配置上传令牌时不要用 `--image`：

```bash
node scripts/ac.mjs evidence add <itemId> --text "构建日志显示 0 error"
node scripts/ac.mjs evidence add <itemId> --url "https://example.com/build/123" --label "构建记录"
node scripts/ac.mjs evidence add <itemId> --image ./shot.png
```

4. 一次性连接并推送，拿到页面链接：

```bash
node scripts/connect.mjs acceptance
```

把输出里的 `pageUrl` 原样发给用户。链接里带 `r=` 时用户可以直接改结论和实测备注，改动会自动保存并自动回传；页面没有提交按钮，不要让用户点提交。删掉 `r=` 后是只读链接。只发链接，不要附加安装步骤。

5. 用户说验收完了，或页面已提示自动回传成功后，在 10 分钟内拉取结果：

```bash
node scripts/ac.mjs pull
```

`changed: true` 表示拿到了新结果，条目状态已合并进本机 `plans.json`。如果输出 `review.stale: true`，说明用户回传时计划已经比页面版本新；把差异说明给用户，再按新计划继续核对，不要把旧结论直接当成新版本结论。

6. 根据不通过项修复后，追加修复记录并重新推送：

```bash
node scripts/ac.mjs item fix <itemId> --version "v1.2.3" --text "已修复：空数据时补默认值" --no-push
node scripts/connect.mjs acceptance
```

页面链接不变；用户刷新后看到新版本计划，已给过结论的旧条目需要“同步到新版本”，条目退回“待验”。

## 常用命令

```bash
node scripts/ac.mjs status
node scripts/ac.mjs doctor
node scripts/ac.mjs plan list
node scripts/ac.mjs push
node scripts/ac.mjs pull
node scripts/ac.mjs report <planId> --out report.md
node scripts/ac.mjs help
```

写命令默认自动推送；加 `--no-push` 只改本机。`push` 会把本机全部验收单整份覆盖到服务器，不是追加。`pull` 只拉取该频道最新一份人工结果，不删除服务器文件。

## 使用者模型

页面只有两个使用者：用户本人和 agent。

- 用户负责看页面、给结论、写实测备注、决定是否复测；不需要选择验收人、团队或审批人。
- agent 负责创建和维护计划、推送、拉取结果、追加修复记录、推进下一轮。
- 不设计多人账号、团队空间、审批流、会签、角色权限或 @提醒；轮次记录只写“用户结论 + agent 修复”。

## 页面和数据规则

- 本机 `plans.json` 是唯一计划源；服务器只做临时中转，不保留业务数据。
- 计划上行：`connect.mjs` 或 `push` 整份覆盖。服务器默认 600 秒没有新写入就清除该频道计划。
- 结果下行：用户在页面改结论或备注后，页面自动保存并自动回传，不需要点提交。结果从最后一次自动回传起临时保存 600 秒；页面读取和 agent `pull` 都不会续期，也不会删除。超时未拉取就丢失。
- 没有 ack、没有“已读即删”、没有 WebSocket、没有字段级合并。重复推送或重复自动回传都是整份覆盖。
- 用户说验收完了、页面提示已回传，或用户让你拉结果时，立即 `pull`，不要等用户再次提醒。超过 10 分钟只能请用户再改一次结论触发回传。
- 不要把 token、内部路径、服务器临时目录写进给用户的说明；只给页面链接。

## 什么时候读参考文件

- 写验收项没有把握，或需要决定 P0/P1/P2、步骤和预期怎么写：读 `plan-quality.md`。
- 不记得命令参数、导入格式、环境变量：读 `cli.md`。
- 要直接调 HTTP 接口、排查 200/304/503、鉴权或 stale 语义：读 `protocol.md`。

## 不要做的事

- 不要伪造人工结论，不要替用户把状态改成通过；agent 只能维护计划、拉取结果和追加修复记录。
- 不要把自动化测试结果写成“人工已验收”；自动化结果应作为证据文字或链接。
- 不要在用户机器上启动常驻服务、端口监听、文件监听或浏览器自动化来“保持连接”。连接脚本是一次性的。
- 不要把验收台和 ListDeck 的任务看板混在一起；两者是不同页面、不同频道、不同数据。
- 不要在页面链接里附带 `file://`、localhost 或内网地址给真实用户；正式链接使用已配置的 HTTPS 工作台域名。
