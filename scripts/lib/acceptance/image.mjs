// 证据图片走现有 image-relay：本机算 hash → 取 PUT 签名 → 直接传 OSS。
// 验收计划和图片引用分开，服务器不存图片本体。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { saveLocalCopy } from '../portable/cache.mjs'

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const MAX_BYTES = 1048576

const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || ''

export async function uploadImage(file, config) {
  const bytes = await readFile(file)
  const mime = mimeOf(file)
  if (!mime) throw new Error(`只支持 jpg / png / webp：${basename(file)}`)
  if (bytes.length > MAX_BYTES) {
    throw new Error(`图片 ${(bytes.length / 1048576).toFixed(2)} MiB 超过 1 MiB，先压缩再传：${basename(file)}`)
  }
  if (!config.channel) throw new Error('没有频道 key，无法上传证据图片')

  const res = await fetch(`${config.baseUrl}/api/image/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ld-key': config.channel,
      ...(config.relayToken ? { 'x-relay-token': config.relayToken } : {})
    },
    body: JSON.stringify({ filename: basename(file), mime, size: bytes.length }),
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) {
    const why = await res.text().catch(() => '')
    throw new Error(`取上传签名失败：HTTP ${res.status} ${why.slice(0, 160)}`)
  }
  const { data } = await res.json()
  const put = await fetch(data.uploadUrl, {
    method: data.method || 'PUT',
    headers: data.headers || { 'content-type': mime },
    body: bytes,
    signal: AbortSignal.timeout(20000)
  })
  if (!put.ok) throw new Error(`传图到 OSS 失败：HTTP ${put.status}`)

  // 证据图最不能丢：本机留原始字节，导出时打包
  const local = await saveLocalCopy(data.objectKey, bytes).catch((err) => ({ saved: false, error: err.message }))

  return {
    kind: 'image',
    objectKey: data.objectKey,
    filename: basename(file),
    mime,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    localFile: local.file || '',
    localError: local.error || ''
  }
}
