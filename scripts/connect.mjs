#!/usr/bin/env node
// 平台统一的一次性连接 / 续期入口。按子平台调用，跑完即退出，不常驻、不开端口。
//   node scripts/connect.mjs listdeck
//   node scripts/connect.mjs acceptance
//   node scripts/connect.mjs docdeck
import { readConfig as readListdeckConfig, pageUrl as listdeckPageUrl } from './lib/listdeck/config.mjs'
import { readData as readListdeckData } from './lib/listdeck/data.mjs'
import { pushSnapshot } from './lib/listdeck/push.mjs'
import { loadConfig as loadAcceptanceConfig, pageUrl as acceptancePageUrl, requireChannel } from './lib/acceptance/config.mjs'
import { readData as readAcceptanceData } from './lib/acceptance/data.mjs'
import { pushData } from './lib/acceptance/api.mjs'
import { loadConfig as loadDocdeckConfig, pageUrl as docdeckPageUrl, requireChannel as requireDocChannel } from './lib/docdeck/config.mjs'
import { readData as readDocdeckData } from './lib/docdeck/data.mjs'
import { pushDocs } from './lib/docdeck/api.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// 推送成功之后顺手跑一次自动导出：内容没变会自己跳过，没配目录会返回 skipped。
// 失败绝不静默：结果挂在输出的 export 字段里，用户至少要能看到「这次没导成」。
function runAutoExport() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'portable.mjs'), 'auto'], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ status: 'failed', reason: 'timeout' })
    }, 30000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ status: 'failed', reason: err.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const json = JSON.parse(stdout.trim())
        resolve({
          status: json.status || (json.ok ? 'ok' : 'failed'),
          path: json.file || json.lastPath || '',
          bytes: json.bytes,
          counts: json.counts,
          missingImages: json.missingImages,
          reason: json.reason,
          hint: json.hint,
          error: json.error
        })
      } catch {
        resolve({ status: 'failed', reason: 'bad_output', detail: (stdout || stderr).slice(0, 200) })
      }
    })
  })
}

const out = (obj, code = 0) => {
  console.log(JSON.stringify(obj, null, 2))
  process.exit(code)
}

const help = () => {
  out({
    ok: true,
    usage: 'node scripts/connect.mjs <listdeck|acceptance|docdeck>',
    platforms: {
      listdeck: '把本机 projects.json 整份覆盖到清单台中转并续期',
      acceptance: '把本机 plans.json 整份覆盖到验收台中转并续期',
      docdeck: '把本机 docs.json 整份覆盖到文档台中转并续期'
    },
    note: '脚本只连接一次，不常驻；页面读取不会续期'
  })
}

async function connectListdeck() {
  const cfg = await readListdeckConfig()
  const { text } = await readListdeckData()
  const result = await pushSnapshot(text, { quiet: true })
  if (!result.ok) {
    return out({
      ok: false,
      platform: 'listdeck',
      connected: false,
      channel: cfg.channel,
      error: {
        code: result.status ? `http_${result.status}` : (result.code || 'connect_failed'),
        message: result.detail || result.error || '连接或续期失败'
      },
      note: '本机数据未受影响；服务器临时文件会在原 TTL 到期后自动清除'
    }, 1)
  }
  const autoExport = await runAutoExport()
  out({
    ok: true,
    platform: 'listdeck',
    connected: true,
    channel: cfg.channel,
    pageUrl: cfg.channel ? listdeckPageUrl(cfg) : '',
    projects: result.data?.projects ?? 0,
    revision: result.data?.revision,
    lastWrite: result.data?.lastWrite || '',
    ttlSeconds: result.data?.ttlSeconds,
    expiresAt: result.data?.expiresAt || '',
    export: autoExport,
    message: '已整份覆盖并续期；脚本已退出，页面读取不会续期'
  })
}

async function connectAcceptance() {
  const config = await loadAcceptanceConfig()
  requireChannel(config)
  const data = await readAcceptanceData()
  const result = await pushData(data, config)
  const autoExport = await runAutoExport()
  out({
    ok: true,
    platform: 'acceptance',
    connected: true,
    channel: config.channel,
    pageUrl: acceptancePageUrl(config),
    plans: result.data?.plans ?? data.plans.length,
    revision: result.data?.revision ?? data.revision,
    ttlSeconds: result.data?.ttlSeconds ?? 600,
    expiresAt: result.data?.expiresAt || '',
    export: autoExport,
    message: '已整份覆盖并续期；脚本已退出，页面读取不会续期'
  })
}

async function connectDocdeck() {
  const config = await loadDocdeckConfig()
  requireDocChannel(config)
  const data = await readDocdeckData()
  const result = await pushDocs(data, config)
  const autoExport = await runAutoExport()
  out({
    ok: true,
    platform: 'docdeck',
    connected: true,
    channel: config.channel,
    pageUrl: docdeckPageUrl(config),
    docs: result.data?.docs ?? data.docs.length,
    revision: result.data?.revision ?? data.revision,
    ttlSeconds: result.data?.ttlSeconds ?? 600,
    expiresAt: result.data?.expiresAt || '',
    export: autoExport,
    message: '已整份覆盖并续期；脚本已退出，页面读取不会续期'
  })
}

async function main() {
  const which = String(process.argv[2] || '').toLowerCase()
  if (!which || which === '--help' || which === '-h' || which === 'help') return help()
  if (which === 'listdeck' || which === 'ld') return connectListdeck()
  if (which === 'acceptance' || which === 'acceptance-deck' || which === 'ac') return connectAcceptance()
  if (which === 'docdeck' || which === 'dd') return connectDocdeck()
  out({
    ok: false,
    error: {
      code: 'bad_platform',
      message: `未知子平台：${which}；只支持 listdeck、acceptance 或 docdeck`
    }
  }, 1)
}

main().catch((err) => out({
  ok: false,
  connected: false,
  error: { code: err.code || 'connect_failed', message: err.message }
}, 1))
