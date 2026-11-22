# 操作剧本

每个剧本都是「先读 → 再写 → 回报」三段。命令里的 `pnpm`/`npm` 不涉及，全部是 `node scripts/ld.mjs`。

**这些都是你（agent）在自己执行环境里的动作，不是让用户去做的事。**
清单台已在线，不要把这些步骤写成给用户的「安装 / 部署教程」。

先把路径记牢：Windows `scripts\ld.mjs`，macOS/Linux `scripts/ld.mjs`，下文统一写 `/`。

---

## 剧本 1：新 agent 接管一份已有清单

**触发**：用户说「这是清单台的 key，你来管」/ 换了台电脑 / 手机端 agent 第一次接入。

```bash
node scripts/ld.mjs adopt --key <KEY> --token <SYNC_TOKEN>
node scripts/ld.mjs status
```

判断成功：`adopt` 返回 `pulled:true` 且 `projects` 数量与用户说的一致；`status` 的 `pageUrl` 能打开。

- 返回 `pulled:false` 且带空频道 `note`：没推过，或临时文件已超时清除。先确认 key 没抄错；原机器执行 `push` / `connect` 后再 adopt。**不要在没确认本机数据正确时直接 push 覆盖。**
- 返回 `pulled:false` 且本地已有数据：服务器那份不比本地新，保持本地，正常。

**只读场景**（用户只让你看看进度，不改）：可以只 `adopt --key` 不带 `--token`，照样能看；要动手再补 `config --sync-token`。

---

## 剧本 2：把一批任务录进清单

**触发**：「这些需求记进清单台」「新建个项目」。

1. 查重

```bash
node scripts/ld.mjs project list
```

同名项目不再新建（`project add` 也会拒绝重名）。已有项目就复用它的 `id`。

2. 建项目

```bash
node scripts/ld.mjs project add --name "编辑器重构" --priority P1 --summary "前后端分离，先动 UI"
```

3. 建分组（没有合适批次时）

```bash
node scripts/ld.mjs group add --project p_xxx --name "第一批" --kind 批次 --rule "按页面顺序"
```

4. 逐条录（一次一条，命令自带推送）

```bash
node scripts/ld.mjs issue add --group g_xxx --title "顶栏挤掉按钮" --type 布局 --priority P1 --note "390 宽下复现"
node scripts/ld.mjs issue add --group g_xxx --title "详情抽屉滚动错位" --type 布局 --priority P2
```

5. 收尾核对

```bash
node scripts/ld.mjs status
```

回报：项目名、批次名、录入条数、`pageUrl`。

> 一次录 10 条以上时，每条都会触发一次 push（每次几百毫秒）。可以先 `--no-push` 批量写，最后统一 `push`：
> `issue add … --no-push` × N，然后 `node scripts/ld.mjs push`。

---

## 剧本 3：更新进度 / 收口

**触发**：「这条做完了」「这批到 60% 了」「今天把剩下三条清掉」。

```bash
# 1. 找 ID
node scripts/ld.mjs issue list --project p_xxx --status doing

# 2. 单条推进
node scripts/ld.mjs issue set i_xxx --status doing --progress 60

# 3. 单条完成
node scripts/ld.mjs issue set i_xxx --status done

# 4. 批量完成
node scripts/ld.mjs issue set i_aaa,i_bbb,i_ccc --status done
```

注意：

- `done` 会把 `progress` 写死 100，不用再传 `--progress`。
- 批量时任意一个 ID 找不到，整个命令会失败、一条都不落盘；先全量核对 ID。
- 改完 `status` 看一眼 `done/total` 是否符合预期。

---

## 剧本 4：挂截图

**触发**：「把这张图挂到那条任务上」。

1. 确认图：jpg / png / webp，≤ 1 MiB。超了先压缩（可用 `byted-mediakit-image`），不要硬传。
2. 找条目 ID：`node scripts/ld.mjs issue list --project p_xxx`
3. 上传：

```bash
node scripts/ld.mjs img add i_xxx --file "D:\shots\topbar.png"
```

4. 回报：文件名 + 条目 + pageUrl。图片 30–45 分钟后桶内会被清扫，但页面打开过一次就存进 OPFS，不会丢。

---

## 剧本 5：跨设备 / 换机

**触发**：手机上也要看；换电脑；两个 agent 交替干活。

```bash
# 新设备
node scripts/ld.mjs adopt --key <KEY> --token <SYNC_TOKEN>
```

规矩：

- **同一个 key 后推覆盖**。两端同时写会互相盖掉，必须串行：A 写完、页面刷新看到、B 再写。
- 每次写命令前 CLI 都会自动 pull，按 `revision` 判断新版，所以串行场景不会拿旧数据覆盖新数据。
- **临时文件会过期**：默认 10 分钟没有 `push` / `connect`，服务器就删除中转文件。
  新设备第一次打开、或新 agent `adopt` 时如果拿不到正文，让原机器执行
  `node scripts/connect.mjs listdeck`（或 `ld push`），再重试即可。本机数据不受影响。
- 不要为了「同步」新建第二个频道，那只会得到两份数据。

---

## 剧本 6：页面空了 / 临时文件过期

**触发**：页面显示空态，或 `doctor` 报频道为空，或用户说「刚才还好好的」。

```bash
node scripts/ld.mjs status     # 确认本机数据还在
node scripts/connect.mjs listdeck       # 整份覆盖并续期；也可以用 ld push
```

推完让用户等 60 秒（或手动刷新）。如果报 401，是令牌问题，不是数据问题。

`503 频道为空` 只有两类原因：从没推过，或默认 10 分钟没有续期、临时文件已被清除。
服务器重启不是必然原因：未过期文件重启后仍可读。无论哪种都用 `push` / `connect` 解决，
真正的数据源始终是本机 `projects.json`。

---

## 剧本 7：交付前自检

**触发**：把 skill 交给另一个 agent 之前 / 排查「为什么它写不进去」。

```bash
node scripts/ld.mjs doctor
node scripts/ld.mjs version
```

`doctor` 的 `ok:true` 才代表环境可用。`checks` 里 `level:"soft"` 的项（比如没配令牌）不影响只读，但写会 401。
