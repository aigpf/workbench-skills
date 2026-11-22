#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig, saveConfig, pageUrl, mask, paths } from './lib/acceptance/config.mjs'
import {
  readData,
  writeData,
  markChanged,
  bumpPlan,
  planOf,
  sectionOf,
  itemOf,
  normalizePlan,
  nextSectionNo,
  newId,
  nowStamp,
  statsOfPlan,
  mergeReview,
  canonicalStatus,
  statusText
} from './lib/acceptance/data.mjs'
import { pushData, pullReview, health } from './lib/acceptance/api.mjs'
import { uploadImage } from './lib/acceptance/image.mjs'

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
const listArg = (value) => String(value || '').split(/[|\n]/).map((s) => s.trim()).filter(Boolean)
const requireFlag = (flags, name, hint) => {
  const value = flag(flags, name)
  if (!value) throw new Error(`${hint}（--${name}）`)
  return value
}

async function maybePush(data, config, flags, quiet = false) {
  if (flags['no-push']) return { status: 'skipped', reason: '--no-push' }
  if (!config.channel) return { status: 'skipped', reason: '没有频道 key' }
  try {
    const res = await pushData(data, config)
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

function latestReview(data, planId) {
  let latest = null
  for (const row of data.reviews || []) {
    if (row.planId !== planId) continue
    if (!latest || String(row.submittedAt || '') >= String(latest.submittedAt || '')) latest = row
  }
  return latest
}

function planSummary(plan, data) {
  const review = latestReview(data, plan.id)
  return {
    id: plan.id,
    title: plan.title,
    sourceTask: plan.sourceTask,
    agent: plan.agent,
    version: plan.version,
    sections: plan.sections.length,
    total: plan.sections.reduce((sum, s) => sum + s.items.length, 0),
    stats: statsOfPlan(plan, review),
    lastReviewAt: review?.submittedAt || ''
  }
}

function reportMarkdown(data, plan) {
  const review = latestReview(data, plan.id)
  const stats = statsOfPlan(plan, review)
  const lines = []
  lines.push(`# ${plan.title} · 人工验收结果`, '')
  if (plan.sourceTask) lines.push(`- 来源任务：${plan.sourceTask}`)
  if (plan.agent) lines.push(`- 执行 agent：${plan.agent}`)
  if (plan.environment) lines.push(`- 环境：${plan.environment}`)
  lines.push(`- 验收单：${plan.id}`)
  lines.push(`- 计划版本：v${plan.version}`)
  lines.push(`- 回传人：${review?.reviewer || '未回传'}`)
  lines.push(`- 回传时间：${review?.submittedAt || '未回传'}`)
  lines.push(`- 汇总：总 ${stats.total} · 待验 ${stats.pending} · 通过 ${stats.pass} · 不通过 ${stats.fail} · 暂缓 ${stats.hold}`)
  lines.push('')

  if (stats.fail) {
    lines.push('## 不通过清单', '')
    for (const section of plan.sections) {
      for (const item of section.items) {
        const row = review?.items?.[item.id]
        if (canonicalStatus(row?.status) !== 'fail') continue
        lines.push(`- [不通过] ${item.title}${item.priority ? `（${item.priority}）` : ''}`)
        if (row.note) lines.push(`  - 实测：${row.note.replace(/\n/g, ' / ')}`)
      }
    }
    lines.push('')
  }

  lines.push('## 全部明细', '')
  for (const section of plan.sections) {
    lines.push(`### ${section.no ? section.no + ' ' : ''}${section.title}`, '')
    for (const item of section.items) {
      const row = review?.items?.[item.id]
      lines.push(`- [${statusText(row?.status)}] ${item.title}${item.priority ? `（${item.priority}）` : ''}`)
      if (row?.note) lines.push(`  - 实测：${row.note.replace(/\n/g, ' / ')}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function help() {
  return {
    ok: true,
    usage: 'node scripts/ac.mjs <command> [args]',
    commands: {
      'config': '设置频道和令牌：--channel --sync-token --review-token --base-url --relay-token',
      'status': '查看本机数据、频道和页面链接',
      'doctor': '检查本机数据与服务器连通性',
      'plan add': '--title --source-task --agent --environment --summary',
      'plan update': '<planId> --title --summary --environment',
      'plan import': '--file plan.json（单个计划或 { plans: [...] }）',
      'plan list': '列出所有验收单',
      'plan rm': '<planId>',
      'section add': '<planId> --title --desc --no',
      'section rm': '<planId> <sectionId>',
      'item add': '<planId> <sectionId> --title --priority --steps "a|b" --expected --note',
      'item update': '<itemId> --title --expected --note --priority --steps',
      'item fix': '<itemId> --text --version（追加修复记录并升计划版本）',
      'item rm': '<itemId>',
      'evidence add': '<itemId> --text "..." | --url https://... --label ... | --image ./shot.png',
      'push': '把本机整份计划推到验收中转',
      'pull': '拉取人工验收结果并合并进本机 plans.json',
      'report': '<planId> [--out report.md]',
      'help': '显示本帮助'
    },
    notes: [
      '任何写命令默认自动 push；加 --no-push 可只改本机。',
      '计划默认 10 分钟 TTL；页面改结论会自动回传，agent 要在 10 分钟内 pull。',
      '验收结果只保留最新一次；重复自动回传会整份覆盖。'
    ]
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = positional.shift() || 'help'
  const sub = positional.shift() || ''
  let config = await loadConfig()
  let data = await readData()

  if (command === 'help' || command === '--help' || command === '-h') return help()

  if (command === 'config') {
    const next = { ...config }
    if (flags.channel != null) next.channel = String(flags.channel).trim().toLowerCase()
    if (flags['sync-token'] != null) next.syncToken = String(flags['sync-token'])
    if (flags['review-token'] != null) next.reviewToken = String(flags['review-token'])
    if (flags['relay-token'] != null) next.relayToken = String(flags['relay-token'])
    if (flags['base-url'] != null) next.baseUrl = String(flags['base-url'])
    if (!/^[a-z0-9]{6,40}$/.test(next.channel || '')) throw new Error('频道 key 必须是 6–40 位小写字母或数字')
    config = await saveConfig(next)
    return {
      ok: true,
      config: {
        baseUrl: config.baseUrl,
        channel: config.channel,
        syncToken: mask(config.syncToken),
        reviewToken: mask(config.reviewToken),
        relayToken: mask(config.relayToken)
      },
      pageUrl: pageUrl(config)
    }
  }

  if (command === 'status') {
    const summaries = data.plans.map((plan) => planSummary(plan, data))
    return {
      ok: true,
      channel: config.channel || '',
      pageUrl: config.channel ? pageUrl(config) : '',
      revision: data.revision,
      lastWrite: data.lastWrite,
      plans: summaries,
      dataFile: paths.data,
      configFile: paths.config,
      tokens: {
        sync: mask(config.syncToken),
        review: mask(config.reviewToken)
      }
    }
  }

  if (command === 'doctor') {
    const checks = []
    checks.push({ name: 'data_file', ok: true, path: paths.data, plans: data.plans.length })
    checks.push({ name: 'channel', ok: /^[a-z0-9]{6,40}$/.test(config.channel || ''), value: config.channel || '' })
    checks.push({ name: 'review_token', ok: Boolean(config.reviewToken), value: mask(config.reviewToken) })
    if (config.channel) {
      try {
        const h = await health(config)
        checks.push({ name: 'relay_health', ok: h.status === 200, status: h.status, body: h.body })
      } catch (err) {
        checks.push({ name: 'relay_health', ok: false, error: err.message })
      }
    }
    return { ok: checks.every((c) => c.ok), checks, pageUrl: config.channel ? pageUrl(config) : '' }
  }

  if (command === 'plan' && sub === 'add') {
    const title = requireFlag(flags, 'title', '缺少验收单标题')
    const plan = normalizePlan({
      id: flags.id || newId('a'),
      title,
      sourceTask: flag(flags, 'source-task'),
      agent: flag(flags, 'agent'),
      environment: flag(flags, 'environment'),
      summary: flag(flags, 'summary'),
      version: 1,
      createdAt: nowStamp(),
      updatedAt: nowStamp(),
      sections: []
    })
    if (data.plans.some((p) => p.id === plan.id)) throw new Error(`验收单 id 已存在：${plan.id}`)
    data.plans.push(plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, plan: planSummary(plan, data), push }
  }

  if (command === 'plan' && sub === 'update') {
    const planId = positional[0]
    if (!planId) throw new Error('用法：plan update <planId> [--title ...]')
    const plan = planOf(data, planId)
    if (flags.title != null) plan.title = String(flags.title)
    if (flags.summary != null) plan.summary = String(flags.summary)
    if (flags.environment != null) plan.environment = String(flags.environment)
    if (flags['source-task'] != null) plan.sourceTask = String(flags['source-task'])
    bumpPlan(plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, plan: planSummary(plan, data), push }
  }

  if (command === 'plan' && sub === 'import') {
    const file = resolve(requireFlag(flags, 'file', '缺少计划文件'))
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.plans) ? raw.plans : [raw]
    const imported = []
    for (const row of rows) {
      const plan = normalizePlan(row)
      if (!plan.title) throw new Error('导入计划缺少 title')
      const index = data.plans.findIndex((p) => p.id === plan.id)
      if (index >= 0) data.plans[index] = plan
      else data.plans.push(plan)
      imported.push(planSummary(plan, data))
    }
    const push = await saveAndPush(data, config, flags)
    return { ok: true, imported, push }
  }

  if (command === 'plan' && sub === 'list') {
    return {
      ok: true,
      plans: data.plans.map((plan) => planSummary(plan, data)),
      lastWrite: data.lastWrite,
      revision: data.revision,
      pageUrl: config.channel ? pageUrl(config) : ''
    }
  }

  if (command === 'plan' && sub === 'rm') {
    const planId = positional[0]
    if (!planId) throw new Error('用法：plan rm <planId>')
    const index = data.plans.findIndex((p) => p.id === planId)
    if (index < 0) throw new Error(`找不到验收单：${planId}`)
    data.plans.splice(index, 1)
    data.reviews = (data.reviews || []).filter((row) => row.planId !== planId)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, removed: planId, push }
  }

  if (command === 'section' && sub === 'add') {
    const planId = positional[0]
    if (!planId) throw new Error('用法：section add <planId> --title ...')
    const plan = planOf(data, planId)
    const section = {
      id: flags.id || newId('s'),
      no: flag(flags, 'no', nextSectionNo(plan)),
      title: requireFlag(flags, 'title', '缺少章节标题'),
      desc: flag(flags, 'desc'),
      items: []
    }
    plan.sections.push(section)
    bumpPlan(plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, plan: planSummary(plan, data), section, push }
  }

  if (command === 'section' && sub === 'rm') {
    const planId = positional[0]
    const sectionId = positional[1]
    if (!planId || !sectionId) throw new Error('用法：section rm <planId> <sectionId>')
    const plan = planOf(data, planId)
    const index = plan.sections.findIndex((s) => s.id === sectionId)
    if (index < 0) throw new Error(`找不到章节：${sectionId}`)
    plan.sections.splice(index, 1)
    bumpPlan(plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, plan: planSummary(plan, data), removed: sectionId, push }
  }

  if (command === 'item' && sub === 'add') {
    const planId = positional[0]
    const sectionId = positional[1]
    if (!planId || !sectionId) throw new Error('用法：item add <planId> <sectionId> --title ...')
    const plan = planOf(data, planId)
    const section = sectionOf(plan, sectionId)
    const item = {
      id: flags.id || newId('i'),
      priority: ['P0', 'P1', 'P2'].includes(flag(flags, 'priority')) ? flag(flags, 'priority') : '',
      title: requireFlag(flags, 'title', '缺少验收项标题'),
      steps: listArg(flag(flags, 'steps')),
      expected: flag(flags, 'expected'),
      note: flag(flags, 'note'),
      evidence: [],
      fixLog: [],
      updated: nowStamp()
    }
    section.items.push(item)
    bumpPlan(plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, item, plan: planSummary(plan, data), push }
  }

  if (command === 'item' && sub === 'update') {
    const itemId = positional[0]
    if (!itemId) throw new Error('用法：item update <itemId> [--title ...]')
    const found = itemOf(data, itemId)
    if (flags.title != null) found.item.title = String(flags.title)
    if (flags.expected != null) found.item.expected = String(flags.expected)
    if (flags.note != null) found.item.note = String(flags.note)
    if (flags.priority != null && ['P0', 'P1', 'P2'].includes(flags.priority)) found.item.priority = flags.priority
    if (flags.steps != null) found.item.steps = listArg(flags.steps)
    found.item.updated = nowStamp()
    bumpPlan(found.plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, item: found.item, plan: planSummary(found.plan, data), push }
  }

  if (command === 'item' && sub === 'fix') {
    const itemId = positional[0]
    if (!itemId) throw new Error('用法：item fix <itemId> --text ... --version ...')
    const found = itemOf(data, itemId)
    found.item.fixLog.push({
      time: nowStamp(),
      version: flag(flags, 'version'),
      text: requireFlag(flags, 'text', '缺少修复说明')
    })
    found.item.updated = nowStamp()
    bumpPlan(found.plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, item: found.item, plan: planSummary(found.plan, data), push }
  }

  if (command === 'item' && sub === 'rm') {
    const itemId = positional[0]
    if (!itemId) throw new Error('用法：item rm <itemId>')
    const found = itemOf(data, itemId)
    found.section.items = found.section.items.filter((row) => row.id !== itemId)
    bumpPlan(found.plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, removed: itemId, plan: planSummary(found.plan, data), push }
  }

  if (command === 'evidence' && sub === 'add') {
    const itemId = positional[0]
    if (!itemId) throw new Error('用法：evidence add <itemId> --text ... | --url ... | --image ...')
    const found = itemOf(data, itemId)
    if (flags.image) {
      const image = await uploadImage(resolve(flags.image), config)
      found.item.evidence.push(image)
    } else if (flags.url) {
      found.item.evidence.push({
        kind: 'link',
        url: String(flags.url),
        label: flag(flags, 'label', String(flags.url))
      })
    } else if (flags.text) {
      found.item.evidence.push({ kind: 'text', text: String(flags.text) })
    } else {
      throw new Error('证据要给 --text、--url 或 --image 之一')
    }
    found.item.updated = nowStamp()
    bumpPlan(found.plan)
    const push = await saveAndPush(data, config, flags)
    return { ok: true, item: found.item, plan: planSummary(found.plan, data), push }
  }

  if (command === 'push') {
    const push = await maybePush(data, config, { 'no-push': false }, false)
    if (push.status !== 'ok') throw new Error(push.error || push.reason)
    return { ok: true, channel: config.channel, pageUrl: pageUrl(config), push }
  }

  if (command === 'pull') {
    const result = await pullReview(config)
    if (result.empty) return { ok: true, empty: true, message: result.message }
    const review = result.data
    const changed = mergeReview(data, review)
    if (!changed) {
      return { ok: true, changed: false, message: '服务器上的结果不比本机新，未覆盖', review }
    }
    const push = await saveAndPush(data, config, flags, true)
    return { ok: true, changed: true, review, push, pageUrl: pageUrl(config) }
  }

  if (command === 'report') {
    const planId = sub || positional[0]
    if (!planId) throw new Error('用法：report <planId> [--out report.md]')
    const plan = planOf(data, planId)
    const markdown = reportMarkdown(data, plan)
    if (flags.out) {
      const out = resolve(flags.out)
      await writeFile(out, markdown, 'utf8')
      return { ok: true, out, chars: markdown.length, plan: planSummary(plan, data) }
    }
    return { ok: true, markdown, plan: planSummary(plan, data) }
  }

  throw new Error(`未知命令：${command} ${sub}`.trim())
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: { code: err.code || 'command_failed', message: err.message } }, null, 2))
    process.exit(1)
  })
