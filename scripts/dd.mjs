#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { loadConfig, saveConfig, pageUrl, mask, requireChannel } from './lib/docdeck/config.mjs'
import {
  readData,
  writeData,
  markChanged,
  addDoc,
  setDoc,
  removeDoc,
  docOf,
  docSummary,
  charsOf,
  KIND_TEXT,
  nowStamp
} from './lib/docdeck/data.mjs'
import { pushDocs, health } from './lib/docdeck/api.mjs'
import { relayLocalImages } from './lib/docdeck/image.mjs'

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (['no-push', 'force'].includes(key)) flags[key] = true
      else {
        const value = argv[++i]
        flags[key] = value == null ? '' : value
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

const flag = (flags, name, fallback = '') => (flags[name] == null ? fallback : String(flags[name]))
const requireFlag = (flags, name, hint) => {
  const value = flag(flags, name)
  if (!value) throw new Error(`${hint}（--${name}）`)
  return value
}

async function readBody(flags) {
  if (flags.file) {
    const file = resolve(String(flags.file))
    return { md: await readFile(file, 'utf8'), from: file, baseDir: dirname(file) }
  }
  if (flags.md != null) return { md: String(flags.md), from: '--md', baseDir: process.cwd() }
  return { md: '', from: '', baseDir: process.cwd() }
}

// 本地图片走 7002 中转，外链原样保留；--no-image 可以整段跳过
async function relayImages(md, body, config, flags) {
  const res = await relayLocalImages(md, {
    baseDir: body.baseDir,
    cfg: { baseUrl: config.baseUrl, relayUrl: config.relayUrl, channel: config.channel, relayToken: config.relayToken },
    skip: Boolean(flags['no-image'])
  })
  return res
}

async function maybePush(data, config, flags, quiet = false) {
  if (flags['no-push']) return { status: 'skipped', reason: '--no-push' }
  if (!config.channel) return { status: 'skipped', reason: '没有频道 key' }
  try {
    const res = await pushDocs(data, config)
    return { status: 'ok', data: res.data }
  } catch (err) {
    if (!quiet) console.error(`[warn] 推送失败：${err.message}`)
    return { status: 'failed', error: err.message }
  }
}

async function saveAndPush(data, config, flags, quiet = false) {
  markChanged(data)
  await writeData(data)
  return maybePush(data, config, flags, quiet)
}

function help() {
  return {
    ok: true,
    usage: 'node scripts/dd.mjs <command> [args]',
    commands: {
      config: '设置频道和令牌：--channel --sync-token --base-url [--relay-url] [--relay-token]',
      status: '本机文档数、频道、页面链接、服务器是否在线',
      page: '只输出页面链接 pageUrl',
      list: '列出本机文档（--kind op|req|doc、--project 名称过滤）',
      add: '新增文档：--title --project --kind --summary --source --file <md 文件>|--md "正文" [--id] [--force] [--no-push] [--no-image]',
      set: '更新正文并按版本 +1：set <id> --file <md 文件>|--md "正文" [--title] [--project] [--summary] [--kind] [--source] [--no-push] [--no-image]',
      rm: '删除文档：rm <id>（本机删除，不自动推送）',
      show: '输出某篇的正文 md：show <id> [--out file.md]',
      push: '整份覆盖推送到服务器并续期'
    },
    kinds: KIND_TEXT,
    notes: [
      '页面只读：用户不会在页面上改任何东西，文档台没有回写接口',
      '同一频道整份覆盖；本机 docs.json 是唯一数据源',
      'md 里的本地图片（相对路径 / 绝对路径 / file://）add 和 set 时会自动走 7002 图片中转上传，正文里换成 /api/image/blob?key= 地址；http(s)/data 外链原样不动，--no-image 可整篇跳过',
      '服务器默认 600 秒没有新 push 就清空临时文件，页面靠本机 IndexedDB 缓存兜底'
    ]
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = positional[0] || 'help'
  const sub = positional[1] || ''
  const config = await loadConfig()

  if (command === 'help' || flags.help) return help()

  if (command === 'config') {
    const next = {
      baseUrl: flag(flags, 'base-url', config.baseUrl),
      channel: flag(flags, 'channel', config.channel).toLowerCase(),
      syncToken: flag(flags, 'sync-token', config.syncToken),
      relayUrl: flag(flags, 'relay-url', config.relayUrl),
      relayToken: flag(flags, 'relay-token', config.relayToken)
    }
    if (!/^[a-z0-9]{6,40}$/.test(next.channel)) throw new Error('频道 key 只能是 6–40 位小写字母或数字')
    const saved = await saveConfig(next)
    return {
      ok: true,
      config: {
        baseUrl: saved.baseUrl,
        channel: saved.channel,
        syncToken: mask(saved.syncToken),
        relayUrl: saved.relayUrl,
        relayToken: saved.relayToken ? mask(saved.relayToken) : ''
      },
      pageUrl: pageUrl(saved),
      configPath: '~/.workbench/docdeck/config.json'
    }
  }

  if (command === 'page') {
    return { ok: true, pageUrl: pageUrl(config), channel: requireChannel(config) }
  }

  if (command === 'status') {
    const data = await readData()
    let server = null
    if (config.channel) {
      try {
        const res = await health(config)
        server = res.body?.ok
          ? { ok: true, ...res.body.snapshot }
          : { ok: false, status: res.status, message: res.body?.error?.message || `HTTP ${res.status}` }
      } catch (err) {
        server = { ok: false, message: err.message }
      }
    }
    return {
      ok: true,
      channel: config.channel || '',
      channelReady: Boolean(config.channel),
      syncTokenSet: Boolean(config.syncToken),
      baseUrl: config.baseUrl,
      docs: data.docs.length,
      revision: data.revision,
      lastWrite: data.lastWrite,
      kinds: data.docs.reduce((acc, doc) => {
        acc[doc.kind] = (acc[doc.kind] || 0) + 1
        return acc
      }, {}),
      server,
      pageUrl: config.channel ? pageUrl(config) : '',
      dataPath: '~/.workbench/docdeck/docs.json'
    }
  }

  if (command === 'list') {
    const data = await readData()
    const kind = flag(flags, 'kind')
    const project = flag(flags, 'project')
    const rows = data.docs
      .filter((doc) => (kind ? doc.kind === kind : true))
      .filter((doc) => (project ? doc.project === project : true))
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(docSummary)
    const projects = [...new Set(data.docs.map((doc) => doc.project))]
    return { ok: true, total: rows.length, projects, docs: rows }
  }

  if (command === 'add') {
    const data = await readData()
    const body = await readBody(flags)
    if (!body.md.trim()) throw new Error('缺少正文：用 --file <md 文件> 或 --md "正文"')
    const relayed = await relayImages(body.md, body, config, flags)
    const doc = addDoc(
      data,
      {
        id: flag(flags, 'id'),
        title: requireFlag(flags, 'title', '缺少标题'),
        kind: flag(flags, 'kind', 'doc'),
        summary: flag(flags, 'summary'),
        source: flag(flags, 'source'),
        project: flag(flags, 'project'),
        md: relayed.md
      },
      Boolean(flags.force)
    )
    const push = await saveAndPush(data, config, flags)
    return {
      ok: true,
      doc: docSummary(doc),
      from: body.from,
      images: relayed.summary,
      push,
      pageUrl: config.channel ? pageUrl(config) : '',
      pageHint: config.channel ? `${pageUrl(config).split('#')[0]}#/doc/${doc.id}` : ''
    }
  }

  if (command === 'set') {
    const id = sub || positional[2]
    if (!id) throw new Error('用法：set <id> --file <md 文件>')
    const data = await readData()
    const doc = docOf(data, id)
    const body = await readBody(flags)
    const relayed = body.md ? await relayImages(body.md, body, config, flags) : null
    const next = setDoc(data, id, {
      md: relayed ? relayed.md : undefined,
      title: flag(flags, 'title') || undefined,
      kind: flag(flags, 'kind') || undefined,
      summary: flags.summary == null ? undefined : flag(flags, 'summary'),
      source: flags.source == null ? undefined : flag(flags, 'source'),
      project: flags.project == null ? undefined : flag(flags, 'project')
    })
    const push = await saveAndPush(data, config, flags)
    return {
      ok: true,
      doc: docSummary(next),
      previousVersion: doc.version,
      images: relayed ? relayed.summary : undefined,
      push,
      pageUrl: config.channel ? pageUrl(config) : ''
    }
  }

  if (command === 'rm') {
    const id = sub || positional[2]
    if (!id) throw new Error('用法：rm <id>')
    const data = await readData()
    const removed = removeDoc(data, id)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, removed: docSummary(removed), remaining: data.docs.length, push }
  }

  if (command === 'show') {
    const id = sub || positional[2]
    if (!id) throw new Error('用法：show <id>')
    const data = await readData()
    const doc = docOf(data, id)
    return { ok: true, doc: docSummary(doc), chars: charsOf(doc.md), md: doc.md }
  }

  if (command === 'push') {
    requireChannel(config)
    const data = await readData()
    const res = await pushDocs(data, config)
    return {
      ok: true,
      pushedAt: nowStamp(),
      docs: data.docs.length,
      server: res.data,
      pageUrl: pageUrl(config)
    }
  }

  throw new Error(`未知命令：${command} ${sub}`.trim())
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: { code: err.code || 'command_failed', message: err.message }, data: err.data || null }, null, 2))
    process.exit(1)
  })
