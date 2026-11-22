import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.ACCEPTANCE_HOME || join(homedir(), '.workbench', 'acceptance')
export const paths = {
  dir: HOME,
  data: join(HOME, 'plans.json'),
  config: join(HOME, 'config.json')
}

const DEFAULTS = {
  baseUrl: process.env.ACCEPTANCE_BASE_URL || 'https://qianqianquege.com',
  channel: process.env.ACCEPTANCE_CHANNEL || '',
  syncToken: process.env.ACCEPTANCE_SYNC_TOKEN || '',
  reviewToken: process.env.ACCEPTANCE_REVIEW_TOKEN || '',
  relayToken: process.env.ACCEPTANCE_RELAY_TOKEN || ''
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
  return {
    baseUrl: trimUrl(file.baseUrl || DEFAULTS.baseUrl),
    channel: String(file.channel || DEFAULTS.channel || '').trim().toLowerCase(),
    syncToken: String(file.syncToken || DEFAULTS.syncToken || ''),
    reviewToken: String(file.reviewToken || DEFAULTS.reviewToken || ''),
    relayToken: String(file.relayToken || DEFAULTS.relayToken || '')
  }
}

export async function saveConfig(config) {
  await ensureDirs()
  const clean = {
    baseUrl: trimUrl(config.baseUrl || DEFAULTS.baseUrl),
    channel: String(config.channel || '').trim().toLowerCase(),
    syncToken: String(config.syncToken || ''),
    reviewToken: String(config.reviewToken || ''),
    relayToken: String(config.relayToken || '')
  }
  await writeFile(paths.config, JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

export function requireChannel(config) {
  if (!/^[a-z0-9]{6,40}$/.test(config.channel || '')) {
    throw new Error('没有可用频道 key。先执行 ac config --channel <6–40 位小写字母或数字>')
  }
  return config.channel
}

export function pageUrl(config) {
  requireChannel(config)
  const base = trimUrl(config.baseUrl)
  const key = encodeURIComponent(config.channel)
  const review = config.reviewToken ? `&r=${encodeURIComponent(config.reviewToken)}` : ''
  return `${base}/acceptance/index.html?k=${key}${review}#/plans`
}

export function mask(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}
