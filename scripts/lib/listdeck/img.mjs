// 图片上传：本机算 hash → 向中转要 PUT 凭证 → 直接传 OSS → 只把引用写进快照。
// 中转侧给的是短命签名；图片始终是「私有桶 + 页面同源回流」，不经过服务器硬盘。
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { saveLocalCopy } from '../portable/cache.mjs'

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

export const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || ''

const MAX_BYTES = 1048576

export async function uploadImage(file, cfg) {
  const bytes = await readFile(file)
  const mime = mimeOf(file)
  if (!mime) throw new Error(`只支持 jpg / png / webp：${basename(file)}`)
  if (bytes.length > MAX_BYTES) {
    throw new Error(`图片 ${(bytes.length / 1048576).toFixed(2)} MiB 超过 1 MiB 上限，先压缩再传：${basename(file)}`)
  }
  if (!cfg.relayUrl) throw new Error('没配 relayUrl，无法取上传凭证')

  const res = await fetch(`${cfg.relayUrl}/api/image/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 频道 key 本身就是上传凭据，服务器不用配任何令牌；
      // 服务器若另配了 RELAY_TOKEN，这里也一并发过去
      'x-ld-key': cfg.channel,
      ...(cfg.relayToken ? { 'x-relay-token': cfg.relayToken } : {})
    },
    body: JSON.stringify({ filename: basename(file), mime, size: bytes.length }),
    signal: AbortSignal.timeout(6000)
  })
  if (!res.ok) {
    const why = await res.text().catch(() => '')
    throw new Error(`取上传凭证失败：HTTP ${res.status} ${why.slice(0, 160)}`)
  }
  const { data } = await res.json()
  const put = await fetch(data.uploadUrl, {
    method: data.method || 'PUT',
    headers: data.headers || { 'content-type': mime },
    body: bytes,
    signal: AbortSignal.timeout(20000)
  })
  if (!put.ok) throw new Error(`传图到 OSS 失败：HTTP ${put.status}`)

  // 本机留一份原始字节：OSS 约 45 分钟清扫，这份是导出时唯一的图源
  const local = await saveLocalCopy(data.objectKey, bytes).catch((err) => ({ saved: false, error: err.message }))

  return {
    objectKey: data.objectKey,
    filename: basename(file),
    mime,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    localFile: local.file || '',
    localError: local.error || ''
  }
}
