// 文档里的图片分两类：本地截图（相对路径 / 绝对路径 / file://）走 image-relay 传 OSS，
// 外部链接（http/https/data/blob，以及已经写好的 /api/image/...）原样保留。
// 上传完把地址换成同源 blob 入口，页面能读到字节、也能自己落缓存。
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { saveLocalCopy } from '../portable/cache.mjs'

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

export const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || ''
const MAX_BYTES = 1048576

// ![alt](url "title") —— 只处理这一种，参考式链接和 html <img> 不动
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

const isRemote = (url) =>
  /^(https?:|data:|blob:|mailto:|ftp:)/i.test(url) ||
  url.startsWith('//') ||
  url.startsWith('/')

const isLocalPath = (url) =>
  /^file:/i.test(url) || /^[a-zA-Z]:\\/.test(url) || (!isRemote(url) && !url.startsWith('#'))

const urlToPath = (url, baseDir) => {
  if (/^file:/i.test(url)) return decodeURI(url.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''))
  if (isAbsolute(url)) return url
  return resolve(baseDir, url)
}

export async function uploadImage(file, cfg) {
  const bytes = await readFile(file)
  const mime = mimeOf(file)
  if (!mime) throw new Error(`只支持 jpg / png / webp：${basename(file)}`)
  if (bytes.length > MAX_BYTES) {
    throw new Error(`图片 ${(bytes.length / 1048576).toFixed(2)} MiB 超过 1 MiB，先压缩：${basename(file)}`)
  }
  if (!cfg.relayUrl) throw new Error('没配 relayUrl，无法取上传凭证')

  const res = await fetch(`${cfg.relayUrl}/api/image/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 频道 key 就是上传凭据，和页面 ?k= 是同一个串
      'x-ld-key': cfg.channel,
      ...(cfg.relayToken ? { 'x-relay-token': cfg.relayToken } : {})
    },
    body: JSON.stringify({ filename: basename(file), mime, size: bytes.length }),
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) {
    const why = await res.text().catch(() => '')
    throw new Error(`取上传凭证失败：HTTP ${res.status} ${why.slice(0, 160)}`)
  }
  const { data } = await res.json()
  const put = await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: data.headers || { 'content-type': mime },
    body: bytes,
    signal: AbortSignal.timeout(20000)
  })
  if (!put.ok) throw new Error(`传图到 OSS 失败：HTTP ${put.status}`)

  // 传上去只是「页面能看见」；本机再留一份原始字节，导出/搬家才有东西可打包
  const local = await saveLocalCopy(data.objectKey, bytes).catch((err) => ({ saved: false, error: err.message }))

  return {
    objectKey: data.objectKey,
    blobPath: data.blobPath || `/api/image/blob?key=${encodeURIComponent(data.objectKey)}`,
    filename: basename(file),
    mime,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    localFile: local.file || '',
    localError: local.error || ''
  }
}

// 把 md 里的本地图片换成中转地址；外链一律不碰。返回替换后的 md 和明细。
export async function relayLocalImages(md, { baseDir, cfg, skip = false }) {
  const text = String(md || '')
  const uploaded = []
  const missing = []
  const failed = []
  const kept = []
  const cache = new Map()
  const pack = (out, keptList = kept) => ({
    md: out,
    uploaded,
    missing,
    failed,
    kept: keptList,
    summary: {
      uploaded: uploaded.length,
      missing: missing.length,
      failed: failed.length,
      kept: keptList.length
    }
  })
  const hits = []
  let m
  while ((m = IMG_RE.exec(text))) {
    const [whole, alt, url] = m
    hits.push({ whole, alt, url, index: m.index })
  }
  if (!hits.length) return pack(text)

  if (skip) return pack(text, hits.map((h) => h.url))
  if (!cfg.channel) {
    // 没有频道就没法上传，保持原样，让页面显示“图片没能加载”
    return pack(text, hits.filter((h) => isLocalPath(h.url)).map((h) => h.url))
  }

  const replacements = new Map()
  for (const hit of hits) {
    if (!isLocalPath(hit.url)) {
      kept.push(hit.url)
      continue
    }
    const file = urlToPath(hit.url, baseDir)
    const key = file.toLowerCase()
    if (cache.has(key)) {
      replacements.set(hit.url, cache.get(key))
      continue
    }
    try {
      await stat(file)
    } catch {
      missing.push(hit.url)
      continue
    }
    try {
      const info = await uploadImage(file, cfg)
      const publicUrl = `${cfg.baseUrl.replace(/\/+$/, '')}${info.blobPath}`
      cache.set(key, publicUrl)
      uploaded.push({ from: hit.url, to: publicUrl, objectKey: info.objectKey, size: info.size })
      replacements.set(hit.url, publicUrl)
    } catch (err) {
      // 单张图失败不拖垮整篇：保留原路径，页面会显示占位，调用方能看到 failed
      failed.push({ from: hit.url, message: err.message })
    }
  }

  let out = text
  for (const [from, to] of replacements) {
    // 只替换 md 里出现的图片地址，做转义避免正则元字符
    const safe = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(!\\[[^\\]]*\\]\\()${safe}`, 'g'), `$1${to}`)
  }
  return pack(out)
}
