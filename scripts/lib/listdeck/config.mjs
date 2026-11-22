// 本机配置：数据目录、频道 key、推送地址。全部存在用户自己电脑上，仓库里不带任何个人信息。
// 优先级：命令行/环境变量 > ~/.workbench/listdeck/config.json > 默认值
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export const ROOT = process.env.LD_DATA_DIR || join(homedir(), '.workbench', 'listdeck')
export const DATA_FILE = join(ROOT, 'projects.json')
export const CONFIG_FILE = join(ROOT, 'config.json')

const DEFAULTS = {
  channel: '',
  syncUrl: 'https://qianqianquege.com',
  syncToken: '',
  relayUrl: '',
  relayToken: ''
}

const randomKey = () => createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)

export async function ensureRoot() {
  await mkdir(ROOT, { recursive: true })
}

export async function readConfig() {
  await ensureRoot()
  let file = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    } catch {
      file = {}
    }
  }
  const cfg = { ...DEFAULTS, ...file }
  // 频道 key 第一次使用时生成并落盘：一台电脑一个抽屉，换机器就是另一份数据。
  // 临时用环境变量指定频道时不要落盘，避免把一个随机 key 写进配置。
  const envChannel = (process.env.LD_CHANNEL || '').trim()
  if (!cfg.channel && !envChannel) {
    cfg.channel = randomKey()
    await writeConfig(cfg)
  }
  if (process.env.LD_CHANNEL) cfg.channel = envChannel
  if (process.env.LD_SYNC_URL) cfg.syncUrl = process.env.LD_SYNC_URL.trim()
  if (process.env.LD_SYNC_TOKEN) cfg.syncToken = process.env.LD_SYNC_TOKEN.trim()
  if (process.env.LD_RELAY_TOKEN) cfg.relayToken = process.env.LD_RELAY_TOKEN.trim()
  if (process.env.LD_RELAY_URL) cfg.relayUrl = process.env.LD_RELAY_URL.trim()
  cfg.syncUrl = (cfg.syncUrl || '').replace(/\/+$/, '')
  // 图片中转默认走同一个域名（nginx 的 /api/image 反代到 7002），本地开发可单独指 7002
  cfg.relayUrl = (cfg.relayUrl || cfg.syncUrl).replace(/\/+$/, '')
  return cfg
}

export async function writeConfig(cfg) {
  await ensureRoot()
  const keep = ['channel', 'syncUrl', 'syncToken', 'relayUrl', 'relayToken']
  const out = {}
  for (const k of keep) out[k] = cfg[k] ?? DEFAULTS[k]
  await writeFile(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8')
}

// 页面地址：query 必须放在 hash 前面，否则 ?k= 会被当成路由的一部分
export const pageUrl = (cfg, path = '/listdeck/index.html', hash = '#/projects') =>
  `${cfg.syncUrl}${path}?k=${encodeURIComponent(cfg.channel)}${hash}`
