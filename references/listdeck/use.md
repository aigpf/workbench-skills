# ListDeck 清单台 · 使用说明

> 版本：2.3.0 ｜ 更新 2026-11-18

**清单台已经在线可用。本 skill 不是安装教程，是教 agent 怎么维护这份在线清单。**

用户看到的是网页；你（agent）做的是执行脚本。两件事，别混。

## 0. 对用户只讲三件事

1. **页面在哪**：`status` 返回的 `pageUrl`，形如
   `https://qianqianquege.com/listdeck/index.html?k=<key>#/projects`
   （`?k=` 必须在 `#` 前面，顺序反了打不开频道）。
2. **用户什么都不用装**：把任务交给你，你更新；他在网页上看，60 秒自动刷新，不用 Ctrl+F5。
3. **禁止在回答里出现**「安装 listdeck」「本地部署」「配置环境」「先新建一个清单」这类话。
   页面和数据都已经在跑，你只是来维护任务。

用户问「这玩意怎么用」，标准回答是：
> 这是在线清单台，你不用装任何东西。把任务或改动告诉我，我更新；你打开这个链接就能看到，页面每 60 秒自动刷新。

## 1. 你要执行的动作

```bash
node scripts/ld.mjs status     # 先读：现有项目、条数、pageUrl
```

只有当你的运行环境还没接上用户的频道（key 不是用户那个、或本地还没配置）时，才补一步：

```bash
node scripts/ld.mjs adopt --key <KEY> --token <SYNC_TOKEN>
```

这一步是**你**的环境初始化，跟用户无关，**不要**写进给用户的回答，也不要让用户去做。
key 和令牌由用户提供；没有就先问，**不要**自己生成新 key 把数据分叉。

如果 `adopt` 返回 `pulled:false`：频道可能没有快照，也可能临时文件已超时清除。
这不是本机数据丢失——让原机器执行一次 `ld push` 或 `node scripts/connect.mjs listdeck`，再重新 `adopt`。

之后按需执行第 3 节的命令。每条写命令自动拉最新、改完推回快照，网页 60 秒内更新。

> 实现细节（不用告诉用户）：脚本在你的执行环境里读写 `~/.workbench/listdeck/projects.json`，
> 改完把快照整份覆盖到服务器临时目录，并刷新有效期。默认 10 分钟没有 `push` / `connect`
> 续期，服务器就删除临时文件；网页读取不续期。本机数据永远保留。
> 全程不起常驻服务、不开端口，命令跑完就退出。运行环境需要 Node ≥ 18，否则报 `node_too_old`。

## 2. 数据是三层结构

```text
project（项目，一张卡）
└── group（子类，批次 / 主题）
    └── issue（条目，一个任务）
```

| 对象 | 关键字段 | 硬约束 |
| --- | --- | --- |
| project | `id` `name` `priority` `summary` `note` `done/total` | `priority`：`P0 / P1 / P2 / 验证 / 约束`；`name` 全库唯一；`done/total` 只读 |
| group | `id` `name` `kind` `rule` `note` `issues[]` | `kind`：`批次 / 主题`；一个 group 只属于一个 project |
| issue | `id` `title` `status` `progress` `type` `priority` `note` `images[]` | `status`：`todo / doing / done`；`progress`：done=100，todo=0，doing 收在 1–99 |

ID 形如 `p_3f9a1c`、`g_...`、`i_...`，由脚本生成，**不要自己编**。
进度联动与 `changes` 变更记录由脚本自动维护，细节见 [schema.md](schema.md)。

## 3. 常用命令

```bash
node scripts/ld.mjs status                 # 概览：频道、pageUrl、每个项目 total/done/doing/todo
node scripts/ld.mjs doctor                 # 体检：数据完整性、频道、令牌、网络可达性
node scripts/ld.mjs help                   # 命令清单（JSON）
node scripts/ld.mjs key | url              # 只要 key / 只要页面链接

node scripts/ld.mjs project list | add | set | rm
node scripts/ld.mjs group   list | add | set | rm
node scripts/ld.mjs issue   list | add | set | move | rm
node scripts/ld.mjs img add <issueId> --file <path>
node scripts/ld.mjs img rm <issueId> <objectKey>
node scripts/ld.mjs guide set --file <guide.json>

node scripts/ld.mjs push | pull | backup | config
node scripts/connect.mjs listdeck               # 一次性连接并续期，不常驻
node scripts/ld.mjs adopt --key <KEY> [--token <T>]
```

参数、返回结构、错误码见 [cli.md](cli.md)。

三个最常用的写法：

```bash
node scripts/ld.mjs project add --name "编辑器重构" --priority P1 --summary "一句话说明"
node scripts/ld.mjs group add --project p_xxx --name "第一批" --kind 批次 --rule "按原文顺序拆"
node scripts/ld.mjs issue add --group g_xxx --title "顶栏挤掉按钮" --type 布局 --priority P1 --note "复现步骤"
```

批量改状态用逗号：

```bash
node scripts/ld.mjs issue set i_aaa,i_bbb,i_ccc --status done
```

## 4. 常见活怎么干

先读再写，别凭记忆。每条写命令都会先拉一次服务器最新，所以照着查到的 ID 操作是安全的。

| 用户说 | 你怎么做 |
| --- | --- |
| 「把这条标成完成」 | `issue list --status doing` 定位 → `issue set i_xxx --status done` |
| 「这批全做完」 | `issue list --project p_xxx --status todo` → `issue set i_a,i_b,… --status done` |
| 「还剩几条」 | `status` 看汇总；要明细就 `issue list --status todo`，**不要估算** |
| 「记一批任务」 | `project list` 查重 → 没有就 `project add` → `group add` → 逐条 `issue add` |
| 「加个截图」 | 压到 1 MiB 内（jpg/png/webp）→ `img add i_xxx --file <绝对路径>` |
| 「挪到另一个批次」 | `issue move i_xxx --to g_yyy`，**不要**删了重加 |
| 「这项目不要了」 | 先跟用户确认 → `project rm p_xxx`（连带删掉其批次、条目和变更记录） |

更细的多步剧本见 [playbooks.md](playbooks.md)。

## 5. 干完怎么回复用户

每次写完，回答里必须带上这三样：

1. **改了什么**：`i_xxx「顶栏挤掉按钮」→ done（100%）`，批量就写「3 条 → done」；
2. **页面链接**：`status` 里的 `pageUrl`；
3. **要不要用户动手**：正常**不用**，60 秒自动刷新；只有服务器临时文件已超时清除、或推送失败时才需要补一次 `push` / `connect`。

推送失败也要如实说：数据已落盘，但网页暂时看不到，并给出下一步（见第 7 节）。

## 6. 铁律

- **不对用户讲安装、部署、本地配置**；清单台已在线，你的脚本细节不必展开。
- **不主动新建清单 / 新频道**；接入只做 `adopt`，避免数据分叉。
- **不手改 `projects.json`**，不改 `config.json` 里的频道 key（除非用户明确给了新 key）。
- **不删**用户没让你删的项目 / 批次 / 条目；批量删除前逐条确认。
- **不给网页加写入口**，不写本地预览页，不起本地服务，不开端口。
- **不动服务器**：nginx、PM2、`.env`、仓库部署都不是本 skill 的事，遇到让用户找维护者。
- **同一频道不要多台设备同时写**：设计是「后推覆盖」，并发写会丢改动；串行使用没问题（每次写前自动 pull）。
- **图片只收 jpg / png / webp，单张 ≤ 1 MiB**，超了先压缩再传。
- **`--no-push` 只在调试时用**；正常写完不要留下没推送的本地改动。
- 输出永远是 JSON；失败看 `error.code`，别靠中文描述猜。**JSON 只走 stdout，诊断人话走 stderr**，只解析 stdout。

## 7. 出错怎么办

| 现象 / `error.code` | 含义 | 你该做什么 |
| --- | --- | --- |
| `node_too_old` | 运行环境 Node < 18 | 换到 Node 22 LTS 的环境执行 |
| `missing_arg` / `bad_command` | 参数或子命令写错 | 看 `help` 与 cli.md，改命令重试 |
| `not_found` | 项目 / 批次 / 条目 ID 不存在 | 先 `project list` / `group list` / `issue list` 重新取 ID |
| `validation_failed` | 枚举值不对、项目重名 | 按报错里的允许值改 |
| `data_corrupt` | `projects.json` 不是合法 JSON | **停手**：先 `backup` 或复制一份，再问用户，不要直接覆盖 |
| `pushed:false` + `HTTP 401` | 同步令牌不对 | `config --sync-token <服务器 SYNC_TOKEN>` 后重试写命令 |
| `pushed:false` + 网络错误 | 服务器不可达 | 数据已落盘；恢复后 `push` |
| `HTTP 503` / 频道为空 | 没推过，或服务器临时文件已超时清除 | 本机数据不变；`push` 或 `node scripts/connect.mjs listdeck` 一次 |
| 图片上传 `oss_not_configured` / 503 | 服务器图片中转没配好 | 不是 agent 能修的，让用户找维护者 |

完整排障见 [troubleshooting.md](troubleshooting.md)。

## 8. 深入资料

| 文件 | 用途 |
| --- | --- |
| `cli.md` | 每条命令的参数、返回、错误码 |
| `schema.md` | 数据结构、字段语义、派生规则 |
| `playbooks.md` | 多步操作剧本 |
| `troubleshooting.md` | 症状 → 原因 → 动作 |
| `../../scripts/ld.mjs` | 唯一 CLI 入口 |
| `../../scripts/lib/listdeck/` | 内部模块，agent 不必看 |
