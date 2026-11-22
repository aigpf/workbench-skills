# 排障

按「现象 → 原因 → 动作」查。凡是涉及服务器（nginx、PM2、`.env`、OSS）的，都不是 agent 的活，如实告诉用户找维护者，不要尝试自己改。

## 命令跑不起来

| 现象 | 原因 | 动作 |
| --- | --- | --- |
| `node: command not found` / `不是内部或外部命令` | 你的执行环境没有 Node | 换到有 Node ≥ 18 的执行环境跑脚本；**不要**让用户去装 |
| `node_too_old` | 执行环境 Node < 18 | 同上；18 以下没有全局 `fetch`，整套都跑不了 |
| `缺少参数 --xxx` | flag 拼错或值被 shell 吃掉 | 核对 `help`；值里含空格要整体加引号 |
| `bad_command` | 子命令写错 | 只支持 `list/add/set/rm`，`issue` 另有 `move` |
| 输出不是 JSON，只有中文报错 | 用了 `console` 之外的脚本，或旧版本 | 只调用 `scripts/ld.mjs` |

## 读写数据

| 现象 | 原因 | 动作 |
| --- | --- | --- |
| `not_found` | ID 过期（被删/被覆盖） | 重新 `project list` / `group list` / `issue list` 取现网 ID |
| `validation_failed: 项目名已存在` | 重名 | 复用已有项目，或改名 |
| `validation_failed: priority 只能是…` | 枚举写错 | 用 `P0/P1/P2/验证/约束` |
| `data_corrupt` | `projects.json` 不是合法 JSON | **停手**：先复制一份备份，问用户要不要从 `backups/` 恢复，不要直接覆盖 |
| 改了没生效 | 只落盘没推（`--no-push`） | `node scripts/ld.mjs push` |
| 卡片数字和明细对不上 | 有人手改过 JSON | 让 CLI 重算：随便做一次 `issue set`（哪怕只改 note），或 `backup` 后让维护者修 |

## 推送（`pushed:false`）

| 返回 | 原因 | 动作 |
| --- | --- | --- |
| `HTTP 401` / `sync_token_invalid` | 令牌缺失或与服务器 `SYNC_TOKEN` 不一致 | `config --sync-token <正确值>`，再重试任意写命令 |
| `HTTP 401` 且从没配过令牌 | 只读接入 | 向用户要 `SYNC_TOKEN` |
| `HTTP 404` | `syncUrl` 指错（指到了 `/api` 或别的路径） | `config --sync-url https://qianqianquege.com` |
| 超时 / `ENOTFOUND` / `ECONNREFUSED` | 网络或服务器不可达 | 数据已落盘；恢复后 `push`。`doctor` 复测 |
| `HTTP 5xx` | 服务器中转异常 | 稍后 `push`；持续失败让用户看 PM2 |
| 推送成功但页面 60 秒后仍是旧数据 | 页面用的是旧 key / 缓存 | 核对 `pageUrl` 的 `?k=`；让用户 Ctrl+F5 |

## 拉取（`pull`）

| 现象 | 原因 | 动作 |
| --- | --- | --- |
| `503` / `empty:true` | 从没 push，或临时文件已超时清除 | 本机数据不动；`push` 或 `node scripts/connect.mjs listdeck` 一次 |
| `pulled:false` 但确定别人改过 | 对方没推成功，或服务器 `revision` 不高于本地 | 让对方 `push` 并核对两边 `status.revision`；必要时 `backup` 后手动比对 |
| `pull` 覆盖了本地改动 | 本地没推过，服务器更新 | 这就是设计：先写先推。用 `backups/` 找回 |

## 图片

| 现象 | 原因 | 动作 |
| --- | --- | --- |
| `只支持 jpg / png / webp` | 格式不对 | 转成 jpg/png/webp，别传 gif、pdf、heic 原图 |
| `超过 1 MiB 上限` | 文件太大 | 先压缩（`byted-mediakit-image`），目标 < 800 KB 留余量 |
| `取上传凭证失败：HTTP 503 oss_not_configured` | 服务器 image-relay 的 AK/SK/region/bucket/RELAY_SECRET 不对 | 不是 agent 能修的，转给维护者 |
| 图片过一阵变成 404 | 桶内 30–45 分钟轮转清扫 | 预期行为；打开过的页面已存 OPFS，不影响 |
| 新设备看不到旧图 | OPFS 是本机的，图片引用在快照里 | 页面打开并拉到图后会自行缓存；桶已清扫则需重新 `img add` |
| 想去掉某张图 | 只需要删除条目里的引用 | `img rm <issueId> <objectKey>`；原图由中转清扫回收 |

## 环境自检

`node scripts/ld.mjs doctor` 的 `checks`：

| check | 含义 | 不过怎么办 |
| --- | --- | --- |
| `node` | Node 版本 | 换到 Node ≥ 18 的执行环境 |
| `data` | `projects.json` 存在且可解析 | `backup` + 人工确认，别覆盖 |
| `channel` | 频道 key 格式（20 位小写字母数字） | `adopt --key <正确值>` |
| `sync` | 快照接口可达 | 检查网络 / `config --sync-url` |
| `token`（soft） | 是否配了同步令牌 | 只读可忽略；写必须配 |
| `relay`（soft） | 图片中转地址是否配置 | 默认跟 `syncUrl`，一般无需单独配 |

## 不属于本 skill 的事

以下问题一律描述现象、交给用户或维护者，agent 不要动手：

- PM2 进程起不来、端口 7001/7002 不通、nginx 反代顺序、`client_max_body_size`；
- 服务器 `.env` 的 `SYNC_TOKEN` / OSS AK/SK；
- 网页构建、部署、`git pull`、宝塔文件上传；
- 修改网页代码或给网页加写入口。
