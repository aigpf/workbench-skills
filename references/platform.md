# 千千工作台 · 平台公共约定

这个文件只讲两个子平台共用的规则；具体命令看 `references/listdeck/` 和 `references/acceptance/`。

## 使用者

只有两个人：**用户本人**和 **agent**。

- 用户看页面、给结论、写备注、确认是否复测。
- agent 读写本机 JSON、推送快照、拉取结果、追加修复记录。
- 不设计多人账号、团队、审批流、会签、评审人分配、角色权限或 @提醒。

## 一句话

本机 JSON 是唯一业务数据源；服务器只是按频道分箱的临时文件中转站。

```text
本机 JSON --(agent / skill 整份覆盖)--> 服务器临时文件 --(页面读取)--> 页面
页面人工输入 --(自动整份回传)--> 服务器结果临时文件 --(agent pull)--> 本机 JSON
```

## 两个邮筒

| 邮筒 | 方向 | 内容 | 续期 |
| --- | --- | --- | --- |
| 计划 / 展示快照 | agent → 页面 | 清单项目或验收计划 | `push` / `connect` 续期 |
| 人工结果 | 页面 → agent | 验收结论、备注 | 页面自动回传时续期 |

- 默认 TTL 600 秒（10 分钟），可用服务端环境变量调整。
- 页面读取不续期；agent `pull` 也不续期。
- 新数据整份覆盖旧数据，不做字段级合并、不做 409、不做 ack。
- 服务器不做持久化；到期由清扫和读取检查共同删除。

## 页面链接

- 正式环境一律 `https://qianqianquege.com`；本地开发才允许 `http://127.0.0.1` 或 `192.168.x.x`。
- 查询参数 `?k=` 必须放在 `#` 前面。
- ListDeck：`/listdeck/index.html?k=<key>#/projects`
- 验收台：`/acceptance/index.html?k=<key>&r=<reviewToken>#/plans`
- 验收台带 `r=` 才能改结论；去掉 `r=` 是只读链接。
- 不要把 token、服务器临时目录、内网路径写进给用户的说明；只给页面链接。

## 命令入口

```bash
node scripts/ld.mjs ...                  # ListDeck 清单台
node scripts/ac.mjs ...                  # 验收台
node scripts/connect.mjs listdeck        # 清单台一次性连接/续期
node scripts/connect.mjs acceptance      # 验收台一次性连接/续期
```

所有脚本都输出 JSON；只解析 stdout，stderr 是诊断信息。

## 共同铁律

- 不在用户机器上安装、部署、启动常驻服务、开端口或监听文件。
- 不手改 `projects.json` / `plans.json`；写操作走对应 CLI。
- 不擅自新建频道、换 key、把数据分叉。
- 不在页面链接里给 `file://`、localhost 或内网地址。
- 同一频道不要多台设备同时写；后写会整份覆盖先写。
- 图片只收 jpg / png / webp，单张不超过 1 MiB。
- `--no-push` 只在调试或批量编辑时用；完成后要补一次 `push` / `connect`。

## 平台扩展方式

以后新增子平台时：

1. 在本 Skill 的 `references/<平台名>/` 下增加使用说明和协议。
2. 在 `scripts/` 下增加该平台 CLI；共享的连接、图片、HTTP 逻辑放 `scripts/lib/common/` 或复用现有 lib。
3. 在根 `SKILL.md` 的子平台路由表里增加一行。
4. 不复制一套完整 Skill；平台规则只维护这一份。
