#!/usr/bin/env node
// 数据搬家：把三个台的本机数据打成 zip，换台电脑 / 换个 agent 再原样接回去。
//   node scripts/portable.mjs export --out D:\备份\workbench-data-20261122-1430.zip
//   node scripts/portable.mjs import D:\备份\workbench-data.zip --channel <key> --sync-token <token>
//   node scripts/portable.mjs verify D:\备份\workbench-data.zip
//   node scripts/portable.mjs auto --dir D:\备份\workbench
// 语义：导入 = 整份覆盖，绝不合并；zip 里不放 syncToken；恢复时原样写回，不重新归一化。
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readZip, writeZip } from './lib/portable/zip.mjs'
import { imageCacheDir, localNameOf, localPathOf } from './lib/portable/cache.mjs'

const WB_ROOT = process.env.WB_HOME || join(homedir(), '.workbench')
const STATE_FILE = join(WB_ROOT, '.export-state.json')
const LOCK_FILE = join(WB_ROOT, '.export.lock')
const EXPORT_CFG = join(WB_ROOT, 'export.json')
const IMAGE_LIMIT_PER_RUN = 15

const DECKS = {
  listdeck: {
    dir: process.env.LD_DATA_DIR || join(WB_ROOT, 'listdeck'),
    data: 'projects.json',
    config: 'config.json',
    pack: 'data/listdeck.json',
    unit: 'projects'
  },
  acceptance: {
    dir: process.env.ACCEPTANCE_HOME || join(WB_ROOT, 'acceptance'),
    data: 'plans.json',
    config: 'config.json',
    pack: 'data/acceptance.json',
    unit: 'plans'
  },
  docdeck: {
    dir: process.env.DOCDECK_HOME || join(WB_ROOT, 'docdeck'),
    data: 'docs.json',
    config: 'config.json',
    pack: 'data/docdeck.json',
    unit: 'docs'
  }
}

const out = (obj, code = 0) => {
  console.log(JSON.stringify(obj, null, 2))
  process.exit(code)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
const dayStamp = () => stamp().slice(0, 8)

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i += 1
      }
    } else pos.push(arg)
  }
  return { pos, flags }
}

async function readJsonFile(file) {
  if (!existsSync(file)) return { exists: false, text: '', json: null }
  const text = await readFile(file, 'utf8')
  try {
    return { exists: true, text, json: JSON.parse(text) }
  } catch (err) {
    return { exists: true, text, json: null, error: err.message }
  }
}

function endpoint(flags, docdeckCfg, acceptanceCfg, listdeckCfg) {
  return {
    baseUrl: String(flags['base-url'] || docdeckCfg.baseUrl || acceptanceCfg.baseUrl || listdeckCfg.syncUrl || 'https://qianqianquege.com').replace(/\/+$/, ''),
    channel: String(flags.channel || docdeckCfg.channel || acceptanceCfg.channel || listdeckCfg.channel || '').trim().toLowerCase(),
    syncToken: String(flags['sync-token'] || docdeckCfg.syncToken || acceptanceCfg.syncToken || listdeckCfg.syncToken || ''),
    reviewToken: String(flags['review-token'] || acceptanceCfg.reviewToken || '')
  }
}

// 从三份数据里捞出所有图片引用：清单/验收看 objectKey 字段，文档台看正文里的 blob 地址
function collectImageRefs(json) {
  const refs = new Map()
  const BLOB_RE = /\/api\/image\/blob\?key=([^)\s"'#]+)/g
  const add = (key) => {
    if (!key) return
    refs.set(key, (refs.get(key) || 0) + 1)
  }
  const scanString = (str) => {
    if (!str.includes('/api/image/blob')) return
    let m
    BLOB_RE.lastIndex = 0
    while ((m = BLOB_RE.exec(str))) {
      let key = m[1]
      try {
        key = decodeURIComponent(key)
      } catch {
        /* 保持原样 */
      }
      add(key)
    }
  }
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') return scanString(node)
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'objectKey' && typeof value === 'string') add(value)
      else walk(value)
    }
  }
  walk(json)
  return refs
}

const mimeOfName = (name) => {
  const ext = String(name).toLowerCase().split('.').pop()
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'application/octet-stream'
}

async function buildPackage({ withImages = true } = {}) {
  const dataFiles = []
  const images = []
  const missingImages = []
  const missingDecks = []
  const deckMeta = {}
  const allRefs = new Map()

  for (const [id, deck] of Object.entries(DECKS)) {
    const file = join(deck.dir, deck.data)
    const read = await readJsonFile(file)
    if (!read.exists || !read.json) {
      missingDecks.push({ deck: id, file, reason: read.exists ? 'json_parse_failed' : 'file_missing' })
      deckMeta[id] = { file: deck.pack, present: false, [deck.unit]: 0, revision: 0 }
      continue
    }
    dataFiles.push({ name: deck.pack, data: read.text })
    const list = Array.isArray(read.json[deck.unit]) ? read.json[deck.unit].length : 0
    deckMeta[id] = {
      file: deck.pack,
      present: true,
      [deck.unit]: list,
      revision: Number(read.json.revision) || 0,
      lastWrite: read.json.lastWrite || ''
    }
    for (const [key, count] of collectImageRefs(read.json)) {
      const prev = allRefs.get(key) || { decks: [], count: 0 }
      allRefs.set(key, { decks: prev.decks.includes(id) ? prev.decks : [...prev.decks, id], count: prev.count + count })
    }
  }

  if (withImages) {
    for (const [key, meta] of allRefs) {
      const name = localNameOf(key)
      const file = localPathOf(key)
      if (!existsSync(file)) {
        missingImages.push({ key, decks: meta.decks, reason: 'local_copy_missing' })
        continue
      }
      const bytes = await readFile(file)
      const sha = sha256(bytes)
      images.push({ name, key, sha256: sha, mime: mimeOfName(name), bytes, decks: meta.decks })
    }
  }

  const channel = String(
    (await readJsonFile(join(DECKS.docdeck.dir, DECKS.docdeck.config))).json?.channel ||
    (await readJsonFile(join(DECKS.acceptance.dir, DECKS.acceptance.config))).json?.channel ||
    (await readJsonFile(join(DECKS.listdeck.dir, DECKS.listdeck.config))).json?.channel ||
    ''
  ).trim()
  const restore = {
    kind: 'workbench-data',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    channel,
    decks: deckMeta,
    images: images.map((img) => ({
      sha256: img.sha256,
      file: `images/${img.name}`,
      mime: img.mime,
      key: img.key,
      ref: `/api/image/blob?key=${encodeURIComponent(img.key)}`,
      decks: img.decks
    })),
    counts: {
      projects: deckMeta.listdeck?.[DECKS.listdeck.unit] || 0,
      plans: deckMeta.acceptance?.[DECKS.acceptance.unit] || 0,
      docs: deckMeta.docdeck?.[DECKS.docdeck.unit] || 0,
      images: images.length
    },
    missingDecks,
    missingImages,
    notes: ['不含 syncToken，换机器导入时单独提供']
  }

  const checksums = []
  const entries = []
  entries.push({ name: 'restore.json', data: JSON.stringify(restore, null, 2) })
  for (const file of dataFiles) {
    checksums.push(`${sha256(Buffer.from(file.data, 'utf8'))}  ${file.name}`)
    entries.push(file)
  }
  for (const img of images) {
    checksums.push(`${img.sha256}  images/${img.name}`)
    entries.push({ name: `images/${img.name}`, data: img.bytes })
  }
  checksums.sort()
  entries.splice(1, 0, { name: 'checksums.txt', data: checksums.join('\n') + '\n' })
  entries.splice(2, 0, { name: 'README.md', data: readmeFor(restore) })
  return { entries, restore, checksums }
}

function readmeFor(restore) {
  const lines = []
  lines.push('# 千千工作台 · 数据包', '')
  lines.push(`导出时间：${restore.exportedAt}`)
  lines.push(`频道：${restore.channel || '（未记录）'}`, '')
  lines.push('## 里面有什么')
  lines.push('')
  lines.push('| 台 | 文件 | 条数 |')
  lines.push('| --- | --- | --- |')
  lines.push(`| 清单台 | ${restore.decks.listdeck?.present ? 'data/listdeck.json' : '（这台没数据）'} | ${restore.decks.listdeck?.projects ?? 0} |`)
  lines.push(`| 验收台 | ${restore.decks.acceptance?.present ? 'data/acceptance.json' : '（这台没数据）'} | ${restore.decks.acceptance?.plans ?? 0} |`)
  lines.push(`| 文档台 | ${restore.decks.docdeck?.present ? 'data/docdeck.json' : '（这台没数据）'} | ${restore.decks.docdeck?.docs ?? 0} |`)
  lines.push(`| 图片 | images/ | ${restore.counts.images} |`)
  lines.push('')
  lines.push('## 怎么恢复')
  lines.push('')
  lines.push('```bash')
  lines.push('node scripts/portable.mjs verify <这个 zip>   # 先体检')
  lines.push('node scripts/portable.mjs import <这个 zip> --channel <频道key> --sync-token <同步令牌>')
  lines.push('```')
  lines.push('')
  lines.push('导入是整份覆盖，不是合并；导入前会自动备份现有的本机数据。')
  lines.push('')
  lines.push('## 两件要说明的事')
  lines.push('')
  lines.push('1. **包里没有 syncToken**。频道号（渠道 key）在包里，但写权限的钥匙不在；换机器要另外给。')
  lines.push('2. **图片必须跟着包走**。旧图片地址一小时后会被清掉，所以包里存了原始字节，导入时会重新上传换成新地址。')
  if (restore.missingImages?.length) {
    lines.push('')
    lines.push(`本次有 ${restore.missingImages.length} 张图没找到本机副本，导入后那些位置会缺图：`)
    for (const item of restore.missingImages.slice(0, 20)) lines.push(`- \`${item.key}\`（${item.decks.join('、')}）`)
  }
  lines.push('')
  return lines.join('\n')
}

async function cmdExport({ flags }) {
  if (flags.out === true) {
    out({ ok: false, action: 'export', error: { code: 'missing_value', message: '--out 后面要跟一个 zip 路径' } }, 1)
  }
  const target = resolve(String(flags.out || `workbench-data-${stamp()}.zip`))
  const withImages = !flags['no-images']
  const { entries, restore } = await buildPackage({ withImages })
  const buf = writeZip(entries)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, buf)
  out({
    ok: true,
    action: 'export',
    file: target,
    bytes: buf.length,
    sha256: sha256(buf),
    counts: restore.counts,
    missingImages: restore.missingImages.length,
    missingDecks: restore.missingDecks.map((d) => d.deck),
    note: restore.missingImages.length
      ? '有图缺本机副本：那些位置导入后会是空的。逐张重新挂一次图再导出即可补齐。'
      : '包里有全部数据与图片原始字节'
  })
}

function verifyPackage(files) {
  const problems = []
  const warnings = []
  const restoreText = files.get('restore.json')
  if (!restoreText) return { problems: ['包里没有 restore.json，不是本工具导出的数据包'], warnings, restore: null }
  let restore
  try {
    restore = JSON.parse(restoreText.toString('utf8'))
  } catch (err) {
    return { problems: [`restore.json 不是合法 JSON：${err.message}`], warnings, restore: null }
  }
  if (restore.kind !== 'workbench-data') problems.push(`kind 不对：${restore.kind}`)

  // checksums
  const sums = files.get('checksums.txt')?.toString('utf8') || ''
  const listed = new Map()
  for (const line of sums.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s{2}(.+)$/)
    if (m) listed.set(m[2].trim(), m[1])
  }
  if (!listed.size) warnings.push('没有 checksums.txt，跳过校验和检查')
  for (const [name, digest] of listed) {
    const buf = files.get(name)
    if (!buf) {
      problems.push(`checksums 里列了 ${name}，包里却没有`)
      continue
    }
    if (sha256(buf) !== digest) problems.push(`${name} 校验和对不上（可能被截断或改过）`)
  }

  // 数据文件
  for (const [id, meta] of Object.entries(restore.decks || {})) {
    if (!meta.present) continue
    const buf = files.get(meta.file)
    if (!buf) {
      problems.push(`${id} 说有数据，但包里缺 ${meta.file}`)
      continue
    }
    try {
      const json = JSON.parse(buf.toString('utf8'))
      const unit = DECKS[id]?.unit
      if (unit && !Array.isArray(json[unit])) problems.push(`${id} 的 ${unit} 不是数组`)
      const ids = new Set()
      for (const row of json[unit] || []) {
        const rid = row?.id
        if (!rid) problems.push(`${id} 有记录缺 id`)
        else if (ids.has(rid)) problems.push(`${id} 有重复 id：${rid}`)
        else ids.add(rid)
      }
    } catch (err) {
      problems.push(`${id} 的 ${meta.file} 不是合法 JSON：${err.message}`)
    }
  }

  // 图片：每个 images 条目本位存在、sha 对得上；正文里的 blob 地址能找到图
  for (const img of restore.images || []) {
    const buf = files.get(img.file)
    if (!buf) problems.push(`缺图文件 ${img.file}`)
    else if (sha256(buf) !== img.sha256) problems.push(`${img.file} 内容与记录的 sha256 不一致`)
  }
  const packedKeys = new Set((restore.images || []).map((img) => String(img.key || '')))
  const docBuf = files.get(restore.decks?.docdeck?.file || 'data/docdeck.json')
  if (docBuf && packedKeys.size) {
    const keys = new Set()
    const RE = /\/api\/image\/blob\?key=([^)\s"'#]+)/g
    const text = docBuf.toString('utf8')
    let m
    while ((m = RE.exec(text))) {
      let key = m[1]
      try {
        key = decodeURIComponent(key)
      } catch {
        /* 原样 */
      }
      keys.add(key)
    }
    const dangling = [...keys].filter((key) => !packedKeys.has(key)).length
    if (dangling) warnings.push(`文档正文里有 ${dangling} 个图片地址在包里没有对应图，导入后会显示成虚线框`)
  }

  const counts = restore.counts || {}
  if ((counts.docs || 0) > 200) problems.push(`文档台 ${counts.docs} 篇，超过单频道 200 篇上限，要拆频道`)
  return { problems, warnings, restore }
}

async function cmdVerify({ pos }) {
  const file = pos[0]
  if (!file) out({ ok: false, error: { code: 'missing_arg', message: '用法：portable.mjs verify <zip>' } }, 1)
  const buf = await readFile(resolve(file))
  const files = readZip(buf)
  const result = verifyPackage(files)
  out({
    ok: result.problems.length === 0,
    action: 'verify',
    file: resolve(file),
    bytes: buf.length,
    entries: files.size,
    counts: result.restore?.counts || {},
    problems: result.problems,
    warnings: result.warnings,
    message: result.problems.length ? '体检没通过，先修包再导' : '体检通过'
  }, result.problems.length ? 1 : 0)
}

async function uploadImage(bytes, { baseUrl, channel, relayToken }, filename) {
  const presign = await fetch(`${baseUrl}/api/image/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ld-key': channel,
      ...(relayToken ? { 'x-relay-token': relayToken } : {})
    },
    body: JSON.stringify({ filename, mime: mimeOfName(filename), size: bytes.length }),
    signal: AbortSignal.timeout(8000)
  })
  if (!presign.ok) throw new Error(`取上传凭证失败：HTTP ${presign.status}`)
  const { data } = await presign.json()
  const put = await fetch(data.uploadUrl, {
    method: data.method || 'PUT',
    headers: data.headers || { 'content-type': mimeOfName(filename) },
    body: bytes,
    signal: AbortSignal.timeout(20000)
  })
  if (!put.ok) throw new Error(`传图到 OSS 失败：HTTP ${put.status}`)
  return data.objectKey
}

async function pushAll(endpoint, dataTexts) {
  const results = {}
  const post = async (url, body, headers = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(20000)
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 200) }
    try {
      return { ok: true, data: JSON.parse(text)?.data || null }
    } catch {
      return { ok: true, data: null }
    }
  }
  const token = endpoint.syncToken ? { 'x-sync-token': endpoint.syncToken } : {}
  if (dataTexts.listdeck) {
    results.listdeck = await post(`${endpoint.baseUrl}/api/listdeck/push?k=${encodeURIComponent(endpoint.channel)}`, dataTexts.listdeck, token)
  }
  if (dataTexts.acceptance) {
    results.acceptance = await post(`${endpoint.baseUrl}/api/acceptance/push?k=${encodeURIComponent(endpoint.channel)}`, dataTexts.acceptance, token)
  }
  if (dataTexts.docdeck) {
    results.docdeck = await post(`${endpoint.baseUrl}/api/docdeck/push?k=${encodeURIComponent(endpoint.channel)}`, dataTexts.docdeck, token)
  }
  return results
}

function patchBlobKeys(text, map) {
  if (!map.size) return text
  return text.replace(/\/api\/image\/blob\?key=([^)\s"'#]+)/g, (whole, enc) => {
    let key = enc
    try {
      key = decodeURIComponent(enc)
    } catch {
      /* 原样 */
    }
    const next = map.get(key)
    return next ? `/api/image/blob?key=${encodeURIComponent(next)}` : whole
  })
}

function patchObjectKeys(text, map) {
  if (!map.size) return text
  let result = text
  for (const [oldKey, newKey] of map) result = result.split(oldKey).join(newKey)
  return result
}

async function cmdImport({ pos, flags }) {
  const file = pos[0]
  if (!file || file === true) out({ ok: false, error: { code: 'missing_arg', message: '用法：portable.mjs import <zip> --channel <key> --sync-token <token>' } }, 1)
  const zipPath = resolve(file)
  const files = readZip(await readFile(zipPath))
  const check = verifyPackage(files)
  if (check.problems.length) {
    out({
      ok: false,
      action: 'import',
      error: { code: 'verify_failed', message: '包体检没通过，先修包：' + check.problems.join('；') },
      problems: check.problems
    }, 1)
  }
  const restore = check.restore
  const docdeckCfg = (await readJsonFile(join(DECKS.docdeck.dir, DECKS.docdeck.config))).json || {}
  const acceptanceCfg = (await readJsonFile(join(DECKS.acceptance.dir, DECKS.acceptance.config))).json || {}
  const listdeckCfg = (await readJsonFile(join(DECKS.listdeck.dir, DECKS.listdeck.config))).json || {}
  const ep = endpoint(flags, docdeckCfg, acceptanceCfg, listdeckCfg)
  if (!/^[a-z0-9]{6,40}$/.test(ep.channel)) {
    out({ ok: false, action: 'import', error: { code: 'no_channel', message: '要给一个频道 key：--channel <6-40 位小写字母或数字>' } }, 1)
  }

  const dryRun = Boolean(flags['dry-run'])
  const imagesOnly = Boolean(flags['images-only'])
  const withImages = !flags['no-image']
  const doPush = !flags['no-push'] && !dryRun

  // 1) 备份现有本机数据
  const backupDir = join(WB_ROOT, '.backup', stamp())
  const backups = []
  if (!dryRun && !imagesOnly) {
    for (const deck of Object.values(DECKS)) {
      const src = join(deck.dir, deck.data)
      if (!existsSync(src)) continue
      await mkdir(backupDir, { recursive: true })
      const dst = join(backupDir, `${deck.data}`)
      await copyFile(src, dst)
      backups.push(dst)
    }
  }

  // 2) 写配置（新机器直接可用）
  if (!dryRun && !imagesOnly) {
    const ld = {
      channel: ep.channel,
      syncUrl: ep.baseUrl,
      syncToken: ep.syncToken,
      relayUrl: listdeckCfg.relayUrl || '',
      relayToken: listdeckCfg.relayToken || ''
    }
    const ac = {
      baseUrl: ep.baseUrl,
      channel: ep.channel,
      syncToken: ep.syncToken,
      reviewToken: ep.reviewToken || acceptanceCfg.reviewToken || '',
      relayToken: acceptanceCfg.relayToken || ''
    }
    const dd = {
      baseUrl: ep.baseUrl,
      channel: ep.channel,
      syncToken: ep.syncToken,
      relayUrl: docdeckCfg.relayUrl || '',
      relayToken: docdeckCfg.relayToken || ''
    }
    await mkdir(DECKS.listdeck.dir, { recursive: true })
    await mkdir(DECKS.acceptance.dir, { recursive: true })
    await mkdir(DECKS.docdeck.dir, { recursive: true })
    await writeFile(join(DECKS.listdeck.dir, DECKS.listdeck.config), JSON.stringify(ld, null, 2), 'utf8')
    await writeFile(join(DECKS.acceptance.dir, DECKS.acceptance.config), JSON.stringify(ac, null, 2), 'utf8')
    await writeFile(join(DECKS.docdeck.dir, DECKS.docdeck.config), JSON.stringify(dd, null, 2), 'utf8')
  }

  // 3) 取数据文本（原样，不重新归一化）
  const texts = {}
  for (const [id, deck] of Object.entries(DECKS)) {
    const meta = restore.decks?.[id]
    if (!meta?.present) continue
    const buf = files.get(meta.file)
    if (!buf) continue
    texts[id] = buf.toString('utf8')
  }

  // 4) 图片回程：旧地址一小时后就被清扫，必须重传
  const imageMap = new Map()
  const imageReport = { uploaded: 0, failed: [], pending: [] }
  if (withImages && (restore.images || []).length) {
    if (!ep.baseUrl || !ep.channel) {
      imageReport.pending = restore.images.map((img) => img.file)
    } else {
      let index = 0
      for (const img of restore.images) {
        if (index >= IMAGE_LIMIT_PER_RUN) {
          imageReport.pending.push(img.file)
          continue
        }
        index += 1
        const buf = files.get(img.file)
        if (!buf) {
          imageReport.failed.push({ file: img.file, reason: 'not_in_zip' })
          continue
        }
        try {
          const newKey = await uploadImage(buf, ep, localNameOf(img.file))
          imageMap.set(String(img.key || ''), newKey)
          imageReport.uploaded += 1
        } catch (err) {
          imageReport.failed.push({ file: img.file, reason: err.message })
        }
      }
    }
  }

  // 5) 把新地址换回去（文档正文换 URL，清单/验收换 objectKey）
  for (const [id, text] of Object.entries(texts)) {
    const next = id === 'docdeck' ? patchBlobKeys(text, imageMap) : patchObjectKeys(text, imageMap)
    texts[id] = next
  }

  // 6) 落盘
  if (!dryRun && !imagesOnly) {
    for (const [id, text] of Object.entries(texts)) {
      await mkdir(DECKS[id].dir, { recursive: true })
      await writeFile(join(DECKS[id].dir, DECKS[id].data), text, 'utf8')
    }
  }

  // 7) 推一次，整份覆盖
  const push = doPush ? await pushAll(ep, texts) : null
  const pushOk = !push || Object.values(push).every((r) => r.ok)

  out({
    ok: pushOk,
    action: 'import',
    file: zipPath,
    dryRun,
    channel: ep.channel,
    restored: {
      projects: restore.counts?.projects || 0,
      plans: restore.counts?.plans || 0,
      docs: restore.counts?.docs || 0
    },
    images: imageReport,
    pushed: push,
    backups: backups.map((b) => b),
    warnings: check.warnings,
    message: dryRun
      ? '演练：包没问题，什么都没写'
      : imagesOnly
        ? `只补了图片${doPush ? '并重新推送' : ''}`
        : imageReport.pending.length
          ? `数据和 ${imageReport.uploaded} 张图已恢复到本机；还有 ${imageReport.pending.length} 张撞限流，过一会儿跑 import --images-only 补齐`
          : doPush
            ? '数据已恢复，三个台都推上去了'
            : '数据已恢复到本机（没推送；要上线再跑一次不带 --no-push）'
  }, pushOk ? 0 : 1)
}

async function readExportConfig() {
  return (await readJsonFile(EXPORT_CFG)).json || {}
}

async function acquireLock() {
  await mkdir(WB_ROOT, { recursive: true })
  try {
    const handle = await open(LOCK_FILE, 'wx')
    await handle.writeFile(String(Date.now()))
    await handle.close()
    return true
  } catch {
    const info = await stat(LOCK_FILE).catch(() => null)
    if (info && Date.now() - info.mtimeMs > 600000) {
      await unlink(LOCK_FILE).catch(() => {})
      return acquireLock()
    }
    return false
  }
}

async function cmdAuto({ flags }) {
  const cfg = await readExportConfig()
  const dir = flags.dir && flags.dir !== true ? resolve(String(flags.dir)) : cfg.dir ? resolve(String(cfg.dir)) : ''
  const keep = Number(flags.keep || cfg.keep || 14) || 14
  const quiet = Boolean(flags.quiet)

  if (!dir) {
    return {
      ok: true,
      action: 'auto',
      status: 'skipped',
      reason: 'export_dir_not_set',
      hint: `先定一个导出目录（不要放在 ${WB_ROOT} 里，同盘备份等于没备份）：node scripts/portable.mjs auto --dir D:\\备份\\workbench`
    }
  }
  if (!(await acquireLock())) {
    return { ok: true, action: 'auto', status: 'skipped', reason: 'locked' }
  }

  let result
  try {
    await mkdir(dir, { recursive: true })
    const hashes = {}
    for (const [id, deck] of Object.entries(DECKS)) {
      const file = join(deck.dir, deck.data)
      hashes[id] = existsSync(file) ? sha256(await readFile(file)) : ''
    }
    const state = (await readJsonFile(STATE_FILE)).json || {}
    const unchanged = Object.keys(hashes).every((id) => state.files?.[id] === hashes[id])
    if (unchanged && state.lastPath && existsSync(state.lastPath)) {
      result = {
        ok: true,
        action: 'auto',
        status: 'skipped',
        reason: 'unchanged',
        lastPath: state.lastPath,
        lastExport: state.lastExport || ''
      }
    } else {
      const { entries, restore } = await buildPackage({ withImages: true })
      const buf = writeZip(entries)
      const target = join(dir, `workbench-data-${dayStamp()}.zip`)
      await writeFile(target, buf)
      await mkdir(WB_ROOT, { recursive: true })
      await writeFile(STATE_FILE, JSON.stringify({
        files: hashes,
        lastExport: new Date().toISOString(),
        lastPath: target,
        bytes: buf.length,
        counts: restore.counts
      }, null, 2), 'utf8')

      // 只留最近 keep 天
      const cutoff = Date.now() - keep * 86400000
      const removed = []
      for (const name of await readdir(dir)) {
        const m = name.match(/^workbench-data-(\d{4})(\d{2})(\d{2})\.zip$/)
        if (!m) continue
        const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
        if (at < cutoff) {
          await unlink(join(dir, name)).catch(() => {})
          removed.push(name)
        }
      }
      result = {
        ok: true,
        action: 'auto',
        status: 'ok',
        file: target,
        bytes: buf.length,
        counts: restore.counts,
        missingImages: restore.missingImages.length,
        pruned: removed.length,
        keepDays: keep
      }
    }
  } catch (err) {
    result = { ok: false, action: 'auto', status: 'failed', error: { code: err.code || 'auto_failed', message: err.message } }
  } finally {
    await unlink(LOCK_FILE).catch(() => {})
  }
  if (quiet && result.ok) {
    // 给 connect 用：照常打 JSON，调用方只看 status
    out(result, 0)
  }
  out(result, result.ok ? 0 : 1)
}

const help = () => out({
  ok: true,
  usage: 'node scripts/portable.mjs <export|import|verify|auto>',
  commands: {
    export: 'export --out <zip 路径> [--no-images]  把三台的本机数据（含图片原始字节）打包',
    import: 'import <zip 路径> --channel <key> --sync-token <token> [--review-token <t>] [--no-image] [--no-push] [--dry-run] [--images-only]',
    verify: 'verify <zip 路径>  纯离线体检，不联网',
    auto: 'auto --dir <目录> [--keep 14]  每天一个包、当天覆盖、超期删除、内容没变就跳过'
  },
  notes: [
    '导入是整份覆盖，不合并；导入前自动备份现有数据到 ~/.workbench/.backup/<时间戳>/',
    `图片本机副本放在 ${imageCacheDir()}，导出时从这里取`,
    'zip 里不放 syncToken；换机器要单独给'
  ]
})

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return help()
  if (cmd === 'export') return cmdExport({ flags })
  if (cmd === 'import') return cmdImport({ pos, flags })
  if (cmd === 'verify') return cmdVerify({ pos })
  if (cmd === 'auto') return cmdAuto({ flags })
  out({ ok: false, error: { code: 'bad_command', message: `未知命令：${cmd}；只支持 export、import、verify、auto` } }, 1)
}

main().catch((err) => out({
  ok: false,
  error: { code: err.code || 'portable_failed', message: err.message }
}, 1))
