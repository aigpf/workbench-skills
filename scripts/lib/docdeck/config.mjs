import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DOCDECK_HOME || join(homedir(), '.workbench', 'docdeck')
export const paths = {
  dir: HOME,
  data: join(HOME, 'docs.json'),
  config: join(HOME, 'config.json')
}

const DEFAULTS = {
  baseUrl: process.env.DOCDECK_BASE_URL || 'https://qianqianquege.com',
  channel: process.env.DOCDECK_CHANNEL || '',
  syncToken: process.env.DOCDECK_SYNC_TOKEN || '',
  // 图片中转（7002）通常和文档台同域，靠 nginx 的 /api/image 反代
  relayUrl: process.env.DOCDECK_RELAY_URL || '',
  relayToken: process.env.DOCDECK_RELAY_TOKEN || ''
}

const trimUrl = (value) => String(value || '').trim().replace(/\/+$/, '')

export async function ensureDirs() {
  await mkdir(paths.dir, { recursive: true })
}

export async function loadConfig() {
  await ensureDirs()
  let file = {}
  if (existsSync(paths.config)) {
    try {
      file = JSON.parse(await readFile(paths.config, 'utf8'))
    } catch {
      file = {}
    }
  }
  const baseUrl = trimUrl(file.baseUrl || DEFAULTS.baseUrl)
  return {
    baseUrl,
    channel: String(file.channel || DEFAULTS.channel || '').trim().toLowerCase(),
    syncToken: String(file.syncToken || DEFAULTS.syncToken || ''),
    relayUrl: trimUrl(file.relayUrl || DEFAULTS.relayUrl || baseUrl),
    relayToken: String(file.relayToken || DEFAULTS.relayToken || '')
  }
}

export async function saveConfig(config) {
  await ensureDirs()
  const baseUrl = trimUrl(config.baseUrl || DEFAULTS.baseUrl)
  const clean = {
    baseUrl,
    channel: String(config.channel || '').trim().toLowerCase(),
    syncToken: String(config.syncToken || ''),
    relayUrl: trimUrl(config.relayUrl || '') || baseUrl,
    relayToken: String(config.relayToken || '')
  }
  await writeFile(paths.config, JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

export function requireChannel(config) {
  if (!/^[a-z0-9]{6,40}$/.test(config.channel || '')) {
    throw new Error('没有可用频道 key。先执行 dd config --channel <6–40 位小写字母或数字>')
  }
  return config.channel
}

// 文档台是纯只读页面：链接里只有 k=，没有任何回写令牌。
export function pageUrl(config) {
  requireChannel(config)
  return `${trimUrl(config.baseUrl)}/docdeck/index.html?k=${encodeURIComponent(config.channel)}#/docs`
}

export function mask(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}
