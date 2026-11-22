// 本机图片副本：上传成功后留一份原始字节，导出时才有东西可打包。
// OSS 上的对象大约 45 分钟后被清扫，本机这份是唯一的长期底本。
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const imageCacheDir = () =>
  process.env.WB_IMAGE_CACHE || join(homedir(), '.workbench', 'images')

// objectKey 形如 ld/20261122/<sha256>.<ext>；落盘文件用它的 basename，天然按内容去重
export const localNameOf = (objectKey) => basename(String(objectKey || ''))

export const localPathOf = (objectKey) => join(imageCacheDir(), localNameOf(objectKey))

export async function saveLocalCopy(objectKey, bytes) {
  const name = localNameOf(objectKey)
  if (!name) return { saved: false, reason: 'empty_key' }
  const dir = imageCacheDir()
  const file = join(dir, name)
  if (existsSync(file)) return { saved: true, file, existed: true }
  await mkdir(dir, { recursive: true })
  await writeFile(file, bytes)
  return { saved: true, file, existed: false }
}
