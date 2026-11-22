# 数据搬家 · export / import / verify / auto

> 一句话：一个命令把三个台的本机数据（含图片原始字节）打成 zip，换台电脑、换个 agent，一个命令原样接回去。
> 这不是云同步，也不是托管；它只保证**能带走、能接回**。

## 1. 什么时候用

| 用户的意思 | 用哪个 |
| --- | --- |
| 「换电脑了」「这个 agent 要卸载了」「帮我把数据存一份」 | `export` |
| 「这个 zip 是我以前的备份，接回来」 | `import`（**先 `verify`**） |
| 「这份备份坏了没有」 | `verify` |
| 不用人开口，接完推送顺手存一份 | `auto`（`connect` 已经自动调） |

## 2. export

```bash
node scripts/portable.mjs export --out D:\备份\workbench-data-20261122-1430.zip
```

- 读三份本机 JSON（`projects.json` / `plans.json` / `docs.json`），哪个台没有就标 `missing`，不报错。
- 图片从 `~/.workbench/images/` 取原始字节；上传那一刻就留了一份副本，因为 OSS 上的对象约 45 分钟被清扫。
- 包里放 `restore.json`（机器读）、`checksums.txt`（防截断）、`README.md`（人读）、`data/`、`images/`。
- 输出 JSON：路径、字节数、sha256、各台条数、缺图数。

`--no-images` 只打包文本，用于图太多、只想先留文字。

## 3. import

```bash
node scripts/portable.mjs import D:\备份\workbench-data-20261122-1430.zip --channel <频道key> --sync-token <同步令牌> [--review-token <回传令牌>]
```

顺序是定死的：

1. 先 `verify`，不通过直接停。
2. 备份现在的本机数据到 `~/.workbench/.backup/<时间戳>/`。
3. 写配置（三个台的 `config.json`），新机器一次就能用。
4. 原样写回三份 JSON——不重新归一化，不改 id、不改 revision。
5. 图片逐张重传（旧地址早被清扫），拿到新 key 后把正文里的 blob 地址和清单/验收里的 `objectKey` 换掉。
6. 三个台各 push 一次，整份覆盖。

开关：

- `--no-image` 只恢复文本，断网/限流时的保命开关。
- `--no-push` 只写本机，不上线。
- `--dry-run` 演练，什么都不写。
- `--images-only` 补图专用（一次最多 15 张，撞了每小时 20 次的限流就隔一阵再跑）。

## 4. verify

```bash
node scripts/portable.mjs verify D:\备份\workbench-data-20261122-1430.zip
```

纯离线，不联网。查：JSON 能解析、id 不重复、`checksums.txt` 全对、每张图的 sha256 与实际字节一致、正文里的 blob 地址在包里都能找到、文档篇数没超频道上限（200）。

**没验过的备份等于没有备份。** 这条命令最便宜也最值钱。

## 5. auto

```bash
node scripts/portable.mjs auto --dir D:\备份\workbench [--keep 14]
```

- 不给用户单独点，`connect.mjs` 推送成功后自动调一次，结果挂在 `connect` 输出的 `export` 字段里。
- 内容没变就跳过（比三份 JSON 的 sha256）；每天一个包，当天覆盖；留最近 14 天；带锁可重入。
- **失败绝不静默**：`export.status` 会是 `failed` 并带原因。
- 目录配置在 `~/.workbench/export.json`：

```json
{ "dir": "D:\\备份\\workbench", "keep": 14 }
```

**默认目录不能落在 `~/.workbench` 里。** 源数据和备份同盘等于没备份——第一次配置就该指到别的盘、U 盘或网盘同步目录。没配时 `auto` 返回 `status: "skipped"`, `reason: "export_dir_not_set"`。

## 6. 几条不许做的

1. **看到 zip 不许「分析一下内容」再重建。** 一律走 `import` 原样写回；自己重写会改 id、改版本、改图片地址，导入后页面就对不上了。
2. **不许把 `syncToken` 放进 zip。** 放进去，zip 就成了能写你全部频道的钥匙，转发即泄。
3. **不许合并式导入。** 同 id 不同内容谁赢说不清，整份覆盖才是可解释的。
4. **不许只导图不导文本、或只导文本还宣称「已备份」**，缺什么必须说清。

## 7. 撞上限怎么办

| 情况 | 处理 |
| --- | --- |
| 图超过 15 张没传完 | 隔一会儿 `import --images-only`，别一次顶满 |
| 单张 > 1 MiB | 先压缩再挂；`import` 会逐条报文件名 |
| 文档篇数 > 200 | 拆频道，不要试图自动拆包 |
| 文档台单次请求 > 8 MB / 清单台 2 MB / 验收台 4 MB | 同上，拆频道 |

## 8. 自测（改完这个脚本要跑一遍）

```bash
node scripts/portable.mjs export --out D:\temp\t.zip
node scripts/portable.mjs verify D:\temp\t.zip
# 换一个空目录当新机器：
$env:WB_HOME="D:\temp\new"; $env:LD_DATA_DIR="D:\temp\new\listdeck"
node scripts/portable.mjs import D:\temp\t.zip --channel testch123 --sync-token x --no-push
# 对比三份文件的 sha256 应与原来完全一致
```

导出、导入前后 JSON 字节完全一致，是这套东西唯一条真标准。
