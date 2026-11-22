#!/usr/bin/env node
// listdeck 本地写入口：直接改本机 projects.json，改完推一份快照到服务器邮筒。
// 不起任何服务、不开端口；每次执行跑完就退出。所有输出都是 JSON，方便 agent 直接读。
//
// 用法：node scripts/ld.mjs <命令> [参数] [--flag 值]
// 命令一览见 references/listdeck/cli.md
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig, writeConfig, pageUrl, ROOT, DATA_FILE, CONFIG_FILE } from './lib/listdeck/config.mjs'
import {
  readData,
  mutate,
  findProject,
  findGroup,
  findIssue,
  groupsOf,
  syncProject,
  logChange,
  newId,
  stamp,
  dayStamp,
  normalizeProgress,
  activeIssues,
  isArchived,
  daysSince,
  similarTitle,
  PRIORITIES,
  STATUSES,
  KINDS,
  STALL_DAYS,
  fail
} from './lib/listdeck/data.mjs'
import { pushSnapshot, pullSnapshot } from './lib/listdeck/push.mjs'
import { uploadImage } from './lib/listdeck/img.mjs'

const MIN_NODE = 18

const out = (obj, code = 0) => {
  console.log(JSON.stringify(obj, null, 2))
  process.exit(code)
}

// 老 Node 没有全局 fetch / AbortSignal.timeout，先拦下来给一句人话
const nodeMajor = Number(String(process.versions.node).split('.')[0])
if (!(nodeMajor >= MIN_NODE)) {
  out({
    ok: false,
    error: {
      code: 'node_too_old',
      message: `需要 Node ${MIN_NODE}+，当前 ${process.version}。装 Node 22 LTS 后重试`
    }
  }, 1)
}

const argv = process.argv.slice(2)

function parseArgs(list) {
  const pos = []
  const flags = {}
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a === '-h') {
      flags.help = true
      continue
    }
    if (a.startsWith('--')) {
      let key = a.slice(2)
      const eq = key.indexOf('=')
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1)
        continue
      }
      const next = list[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

const { pos, flags } = parseArgs(argv)
const [cmd, sub, ...rest] = pos

const need = (v, name) => {
  if (v == null || v === '' || v === true) throw fail('missing_arg', `缺少参数 --${name}`)
  return v
}

const pickPriority = (p) => {
  if (p == null) return undefined
  if (!PRIORITIES.includes(p)) throw fail('validation_failed', `priority 只能是 ${PRIORITIES.join(' / ')}`)
  return p
}

const pickStatus = (s) => {
  if (s == null) return undefined
  if (!STATUSES.includes(s)) throw fail('validation_failed', `status 只能是 ${STATUSES.join(' / ')}`)
  return s
}

const pickProgress = (p) => {
  if (p == null) return undefined
  const n = Number(p)
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw fail('validation_failed', 'progress 必须是 0–100 的整数')
  }
  return n
}

// 只给进度、没显式给状态时，让状态跟着进度走；否则 todo 的进度会被规则归 0，像被吞掉
const statusForProgress = (progress, fallback = 'todo') => {
  if (progress == null) return fallback
  if (progress >= 100) return 'done'
  if (progress > 0) return 'doing'
  return 'todo'
}

async function skillVersion() {
  try {
    const md = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
    // 版本号写在正文首行（frontmatter 只允许 name/description）
    const m = md.match(/^>\s*版本[：:]\s*(\S+)/m)
    return m ? m[1].trim() : 'unknown'
  } catch {
    return 'unknown'
  }
}

const HELP = {
  usage: 'node scripts/ld.mjs <命令> [参数] [--flag 值]   （Windows 用 scripts\\ld.mjs）',
  output: '永远是 JSON；失败时 { ok:false, error:{ code, message } }，退出码非 0',
  groups: [
    {
      title: '接入与自检',
      items: [
        'version  技能版本 / Node / 数据文件路径',
        'doctor   体检：Node、数据完整性、频道、令牌、网络可达性',
        'status   概览：频道、pageUrl、每个项目 total/done/doing/todo',
        'key      只输出频道 key 与页面地址',
        'url      只输出页面地址',
        'config   --sync-url / --sync-token / --relay-url / --relay-token；不带参数时查看（令牌打码）',
        'adopt    --key <key> [--token <t>] [--url <u>]  接入已有频道并立即 pull'
      ]
    },
    {
      title: '同步',
      items: [
        'push     把本机 projects.json 整份推到临时邮筒并续期',
        'pull     拉频道最新，服务器更新时覆盖本地',
        'backup   备份到 ~/.workbench/listdeck/backups/，保留最近 20 份',
        '连接脚本 node scripts/connect.mjs listdeck：一次性连接并续期（非常驻，超时由服务器清除）'
      ]
    },
    {
      title: '数据',
      items: [
        'project  list | add --name --priority [--summary] [--note] | set <id> | rm <id>',
        'group    list [--project] | add --project --name [--kind 批次|主题] [--rule] [--note] | set <gid> --project | rm <gid> --project',
        'issue    list [--project] [--group] [--status] [--archived|--all] | add --group --title [--type] [--priority] [--status] [--progress] [--note] [--force]',
        '         set <id[,id2]> [--status] [--progress] [--title] [--note] [--type] [--priority]',
        '         move <id> --to <gid> | rm <id[,id2]> （归档，不删；--hard 才真删）',
        '         restore <id[,id2]> （从归档恢复） | stalled [--days 3] [--project]   （多久没动）',
        'img      add <issueId> --file <绝对路径>   （jpg/png/webp，≤1 MiB）',
        '         rm <issueId> <objectKey>          （只删引用，原图由中转清扫回收）',
        'guide    set --file <guide.json>'
      ]
    }
  ],
  examples: [
    'node scripts/ld.mjs adopt --key 1fa546a91b523caf7626 --token <SYNC_TOKEN>',
    'node scripts/ld.mjs project add --name "编辑器重构" --priority P1 --summary "前后端分离"',
    'node scripts/ld.mjs group add --project p_xxx --name "第一批" --kind 批次',
    'node scripts/ld.mjs issue add --group g_xxx --title "顶栏挤掉按钮" --type 布局 --priority P1',
    'node scripts/ld.mjs issue set i_aaa,i_bbb --status done',
    'node scripts/ld.mjs img add i_xxx --file "D:\\shots\\topbar.png"'
  ],
  flags: '写命令默认先 pull 再 push；--no-pull / --no-push 只在调试时用。环境变量：LD_DATA_DIR / LD_CHANNEL / LD_SYNC_URL / LD_SYNC_TOKEN / LD_RELAY_URL / LD_RELAY_TOKEN'
}

// 推送失败时给 agent 一句能直接照做的建议
function pushHint(r) {
  if (!r || r.ok) return undefined
  if (r.status === 401 || r.status === 403) {
    return '同步令牌不对：node scripts/ld.mjs config --sync-token <服务器 SYNC_TOKEN 同值>，再重试写命令'
  }
  if (r.status === 404) return '推送路由不存在：确认 syncUrl 指到站点根（如 https://qianqianquege.com），不要带 /api'
  if (r.status >= 500) return '服务器中转异常：稍后重试；持续失败找维护者看 PM2'
  if (r.code === 'timeout') return '推送超时：数据已落盘，网络恢复后执行 node scripts/ld.mjs push'
  if (r.error) return '网络不可达：数据已落盘，恢复后执行 node scripts/ld.mjs push'
  return undefined
}

// 写完后自动推一次；--no-push 只落本地（离线、或批量写完统一推）
async function afterWrite(text) {
  if (flags['no-push']) return { pushed: false, note: '按 --no-push 只写本地，记得稍后 push' }
  const r = await pushSnapshot(text, { quiet: true })
  if (r.ok) return { pushed: true }
  return {
    pushed: false,
    pushError: r.status ? `HTTP ${r.status}` : (r.error || 'unknown'),
    ...(r.detail ? { pushDetail: r.detail } : {}),
    pushHint: pushHint(r)
  }
}

function stats(data) {
  return data.projects.map(p => {
    const groups = data.groups[p.id] || []
    const raw = groups.flatMap(g => g.issues)
    const all = activeIssues(raw)
    const done = all.filter(i => i.status === 'done').length
    const doing = all.filter(i => i.status === 'doing').length
    return {
      id: p.id,
      name: p.name,
      priority: p.priority,
      groups: groups.length,
      total: all.length,
      done,
      doing,
      todo: all.length - done - doing,
      archived: raw.length - all.length
    }
  })
}

function totals(data) {
  let total = 0; let done = 0; let doing = 0; let todo = 0; let archived = 0
  for (const groups of Object.values(data.groups || {})) {
    for (const g of groups) {
      for (const i of g.issues) {
        if (isArchived(i)) {
          archived++
          continue
        }
        total++
        if (i.status === 'done') done++
        else if (i.status === 'doing') doing++
        else todo++
      }
    }
  }
  return { projects: data.projects.length, issues: total, done, doing, todo, archived }
}

async function run() {
  const cfg = await readConfig()

  if (flags.help || cmd === 'help' || cmd === undefined) {
    return out({ ok: true, skill: 'listdeck', version: await skillVersion(), ...HELP })
  }

  // 同一用户可能 PC 和手机都在写：动手之前先拉一次，服务器上有更新就以它为准，
  // 再基于它改；推的时候直接覆盖（同一个 key 就是同一个抽屉）。
  const WRITE_CMDS = new Set(['project', 'group', 'issue', 'img', 'guide'])
  if (WRITE_CMDS.has(cmd) && !flags['no-pull']) await pullSnapshot({ quiet: true })

  switch (cmd) {
    // ---------- 概览与自检 ----------
    case 'version':
      return out({
        ok: true,
        skill: 'listdeck',
        version: await skillVersion(),
        node: process.version,
        dataFile: DATA_FILE,
        configFile: CONFIG_FILE
      })

    case 'doctor': {
      const checks = []
      const add = (name, ok, level, detail) => checks.push({ name, ok, level, detail })

      add('node', true, 'hard', `Node ${process.version}（要求 ≥ ${MIN_NODE}）`)

      let data = null
      let dataError = null
      try {
        data = (await readData()).data
      } catch (e) {
        dataError = e
      }
      if (data) {
        const t = totals(data)
        add('data', true, 'hard', `${DATA_FILE}｜${t.projects} 个项目 / ${t.issues} 条任务｜lastWrite ${data.lastWrite || '（空）'}`)
      } else {
        add('data', false, 'hard', `${DATA_FILE}｜${dataError.message}`)
      }

      const keyOk = /^[a-z0-9]{6,40}$/.test(cfg.channel || '')
      add('channel', keyOk, 'hard', keyOk
        ? `${cfg.channel} → ${pageUrl(cfg)}`
        : `频道 key 异常：${cfg.channel || '（空）'}；用 adopt --key <正确值> 重建`)

      add('token', !!cfg.syncToken, 'soft', cfg.syncToken
        ? '已配置同步令牌，可写'
        : '未配置同步令牌：只能读；写入会 401，用 config --sync-token 补')

      add('relay', !!(cfg.relayUrl || cfg.syncUrl), 'soft', cfg.relayUrl || cfg.syncUrl || '未配置图片中转地址')

      if (!cfg.syncUrl) {
        add('sync', false, 'hard', '未配置 syncUrl，快照无法推送/拉取')
      } else {
        const url = `${cfg.syncUrl}/api/listdeck/snapshot?k=${encodeURIComponent(cfg.channel)}`
        try {
          const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
          if (res.status === 200) {
            const body = await res.json().catch(() => null)
            const n = Array.isArray(body?.projects) ? body.projects.length : '?'
            add('sync', true, 'hard', `${cfg.syncUrl} 可达，频道快照 ${n} 个项目`)
          } else if (res.status === 503) {
            add('sync', true, 'hard', `${cfg.syncUrl} 可达，但频道暂无有效快照（还没 push，或临时文件已超时清除）`)
          } else {
            add('sync', false, 'hard', `${cfg.syncUrl} 返回 HTTP ${res.status}：确认 syncUrl 指到站点根`)
          }
        } catch (e) {
          add('sync', false, 'hard', `${cfg.syncUrl} 不可达：${e.name === 'TimeoutError' ? '超时' : e.message}`)
        }
      }

      const ok = checks.filter(c => c.level === 'hard').every(c => c.ok)
      return out({
        ok,
        skill: 'listdeck',
        version: await skillVersion(),
        channel: cfg.channel,
        pageUrl: pageUrl(cfg),
        dataFile: DATA_FILE,
        configFile: CONFIG_FILE,
        counts: data ? totals(data) : null,
        checks,
        summary: ok ? '环境可用' : '有硬性检查项未通过，先按 checks 里的 detail 处理'
      }, ok ? 0 : 1)
    }

    case 'status': {
      const { data } = await readData()
      return out({
        ok: true,
        channel: cfg.channel,
        pageUrl: pageUrl(cfg),
        dataFile: DATA_FILE,
        lastWrite: data.lastWrite || '',
        revision: Number(data.revision) || 0,
        counts: totals(data),
        projects: stats(data),
        guide: data.guide ? { title: data.guide.title, sections: (data.guide.sections || []).length } : null
      })
    }

    case 'key':
      return out({ ok: true, channel: cfg.channel, pageUrl: pageUrl(cfg), syncUrl: cfg.syncUrl })

    case 'url':
      return out({ ok: true, url: pageUrl(cfg) })

    // ---------- 配置 ----------
    case 'config': {
      const sets = {
        syncUrl: flags['sync-url'],
        syncToken: flags['sync-token'],
        relayUrl: flags['relay-url'],
        relayToken: flags['relay-token']
      }
      const touched = Object.entries(sets).filter(([, v]) => v != null)
      if (touched.length) {
        for (const [k, v] of touched) cfg[k] = String(v).trim()
        cfg.syncUrl = (cfg.syncUrl || '').replace(/\/+$/, '')
        cfg.relayUrl = (cfg.relayUrl || '').replace(/\/+$/, '')
        await writeConfig(cfg)
      }
      return out({
        ok: true,
        updated: touched.length > 0,
        configFile: CONFIG_FILE,
        channel: cfg.channel,
        syncUrl: cfg.syncUrl,
        relayUrl: cfg.relayUrl || cfg.syncUrl,
        syncTokenSet: !!cfg.syncToken,
        relayTokenSet: !!cfg.relayToken
      })
    }

    // ---------- 推送 / 拉取 / 认领频道 / 备份 ----------
    case 'push': {
      const { text } = await readData()
      const r = await pushSnapshot(text)
      return out({ ok: !!r.ok, channel: cfg.channel, hint: pushHint(r), ...r }, r.ok ? 0 : 1)
    }

    // 手机、另一台电脑：把频道 key 带过来，接上同一个抽屉
    case 'adopt': {
      const key = String(need(flags.key, 'key')).trim().toLowerCase()
      if (!/^[a-z0-9]{6,40}$/.test(key)) throw fail('validation_failed', '频道 key 只能是 6–40 位小写字母或数字')
      cfg.channel = key
      if (flags.token != null) cfg.syncToken = String(flags.token).trim()
      if (flags.url != null) cfg.syncUrl = String(flags.url).trim().replace(/\/+$/, '')
      await writeConfig(cfg)
      const r = await pullSnapshot({ quiet: true })
      return out({
        ok: true,
        channel: key,
        pageUrl: pageUrl(cfg),
        syncTokenSet: !!cfg.syncToken,
        pulled: !!r.pulled,
        ...(r.pulled
          ? { projects: r.projects, lastWrite: r.lastWrite, revision: r.revision || 0 }
          : { note: '频道暂无有效快照：可能还没 push，或临时文件已超时清除。确认 key 没抄错，或让原机器 push / connect 一次后重试' })
      })
    }

    case 'pull': {
      const r = await pullSnapshot()
      const { data } = await readData()
      return out({
        ok: !!r.ok,
        ...(r.ok ? {} : { hint: pushHint(r) }),
        channel: cfg.channel,
        pulled: !!r.pulled,
        lastWrite: data.lastWrite || '',
        revision: Number(data.revision) || 0,
        projects: data.projects.length,
        ...(r.empty ? { note: '频道暂无有效快照（可能已超时清除）；本机数据未改动，push / connect 一次即可重新放入' } : {})
      }, r.ok ? 0 : 1)
    }

    case 'backup': {
      const { text } = await readData()
      const dir = join(ROOT, 'backups')
      await mkdir(dir, { recursive: true })
      const name = `projects-${stamp().replace(/[: ]/g, '-')}.json`
      const file = join(dir, name)
      await writeDataCopy(file, text)
      const list = (await readdir(dir))
        .filter(n => n.startsWith('projects-') && n.endsWith('.json'))
        .sort()
      const keep = 20
      const extra = list.slice(0, Math.max(0, list.length - keep))
      for (const n of extra) await unlink(join(dir, n)).catch(() => {})
      return out({ ok: true, file, kept: Math.min(list.length, keep) })
    }

    // ---------- 项目 ----------
    case 'project': {
      if (sub === 'list') {
        const { data } = await readData()
        return out({ ok: true, projects: data.projects })
      }
      if (sub === 'add') {
        const name = need(flags.name, 'name')
        const priority = pickPriority(need(flags.priority, 'priority'))
        const r = await mutate((d) => {
          if (d.projects.some(p => p.name === name)) throw fail('validation_failed', `项目名「${name}」已存在`)
          const project = {
            id: newId('p'),
            priority,
            name,
            summary: flags.summary || '',
            note: flags.note || '',
            updated: dayStamp(),
            done: 0,
            total: 0
          }
          d.projects.push(project)
          return project
        })
        const { text } = await readData()
        return out({ ok: true, project: r, ...(await afterWrite(text)) })
      }
      if (sub === 'set') {
        const id = need(rest[0] || flags.id, 'id')
        const r = await mutate((d) => {
          const p = findProject(d, id)
          if (flags.name != null) p.name = flags.name
          if (flags.priority != null) p.priority = pickPriority(flags.priority)
          if (flags.summary != null) p.summary = flags.summary
          if (flags.note != null) p.note = flags.note
          p.updated = dayStamp()
          return p
        })
        const { text } = await readData()
        return out({ ok: true, project: r, ...(await afterWrite(text)) })
      }
      if (sub === 'rm') {
        const id = need(rest[0] || flags.id, 'id')
        const r = await mutate((d) => {
          const p = findProject(d, id)
          d.projects = d.projects.filter(x => x.id !== id)
          for (const g of d.groups[id] || []) {
            for (const i of g.issues) delete d.changes[i.id]
          }
          delete d.groups[id]
          return { removed: p }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }
      throw fail('bad_command', 'project 子命令：list / add / set / rm')
    }

    // ---------- 子类（批次 / 主题）----------
    case 'group': {
      if (sub === 'list') {
        const { data } = await readData()
        const projectId = flags.project
        if (projectId) return out({ ok: true, groups: groupsOf(data, projectId) })
        return out({ ok: true, groups: data.groups })
      }
      if (sub === 'add') {
        const projectId = need(flags.project, 'project')
        const name = need(flags.name, 'name')
        const kind = flags.kind || '主题'
        if (!KINDS.includes(kind)) throw fail('validation_failed', `kind 只能是 ${KINDS.join(' / ')}`)
        const r = await mutate((d) => {
          findProject(d, projectId)
          const group = {
            id: newId('g'),
            name,
            kind,
            rule: flags.rule || '',
            note: flags.note || '',
            issues: []
          }
          groupsOf(d, projectId).push(group)
          syncProject(d, projectId)
          return group
        })
        const { text } = await readData()
        return out({ ok: true, group: r, ...(await afterWrite(text)) })
      }
      if (sub === 'set') {
        const projectId = need(flags.project, 'project')
        const groupId = need(rest[0] || flags.id, 'id')
        const r = await mutate((d) => {
          const g = findGroup(d, projectId, groupId)
          if (flags.name != null) g.name = flags.name
          if (flags.kind != null) {
            if (!KINDS.includes(flags.kind)) throw fail('validation_failed', `kind 只能是 ${KINDS.join(' / ')}`)
            g.kind = flags.kind
          }
          if (flags.rule != null) g.rule = flags.rule
          if (flags.note != null) g.note = flags.note
          syncProject(d, projectId)
          return g
        })
        const { text } = await readData()
        return out({ ok: true, group: r, ...(await afterWrite(text)) })
      }
      if (sub === 'rm') {
        const projectId = need(flags.project, 'project')
        const groupId = need(rest[0] || flags.id, 'id')
        const r = await mutate((d) => {
          const g = findGroup(d, projectId, groupId)
          for (const i of g.issues) delete d.changes[i.id]
          d.groups[projectId] = groupsOf(d, projectId).filter(x => x.id !== groupId)
          syncProject(d, projectId)
          return { removed: g }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }
      throw fail('bad_command', 'group 子命令：list / add / set / rm')
    }

    // ---------- 条目 ----------
    case 'issue': {
      if (sub === 'list') {
        const { data } = await readData()
        const rows = []
        for (const [projectId, groups] of Object.entries(data.groups)) {
          if (flags.project && flags.project !== projectId) continue
          for (const g of groups) {
            if (flags.group && flags.group !== g.id) continue
            for (const i of g.issues) {
              // 默认只看活条目；--archived 只看归档，--all 两样都要
              if (!flags.all && (flags.archived ? !isArchived(i) : isArchived(i))) continue
              if (flags.status && flags.status !== i.status) continue
              rows.push({
                ...i,
                projectId,
                groupId: g.id,
                groupName: g.name,
                idleDays: daysSince(i.updated)
              })
            }
          }
        }
        return out({ ok: true, count: rows.length, issues: rows })
      }
      if (sub === 'add') {
        const groupId = need(flags.group, 'group')
        const title = need(flags.title, 'title')
        const progress = pickProgress(flags.progress)
        const r = await mutate((d) => {
          let projectId = flags.project
          if (!projectId) {
            for (const [pid, groups] of Object.entries(d.groups)) {
              if (groups.some(g => g.id === groupId)) { projectId = pid; break }
            }
          }
          if (!projectId) throw fail('not_found', `找不到子类 ${groupId}`)
          const g = findGroup(d, projectId, groupId)

          // 建之前先查重：重复的任务会让清单越用越乱，而 agent 自己不会主动查。
          // 相似度只做保守判断（同标题或包含且够长），误报可以用 --force 放行。
          const duplicates = []
          for (const gg of groupsOf(d, projectId)) {
            for (const i of gg.issues) {
              if (isArchived(i)) continue
              const score = similarTitle(title, i.title)
              if (score > 0) {
                duplicates.push({
                  id: i.id,
                  title: i.title,
                  groupId: gg.id,
                  groupName: gg.name,
                  status: i.status,
                  score
                })
              }
            }
          }
          if (duplicates.length && !flags.force) {
            const top = duplicates.slice(0, 3)
              .map(x => `${x.id}「${x.title}」（${x.groupName} · ${x.status}）`)
              .join('；')
            throw fail(
              'duplicate_issue',
              `项目里已有相似条目：${top}。要改现有的用 ld issue set，确实新开才加 --force`
            )
          }

          const status = pickStatus(flags.status) || statusForProgress(progress)
          const issue = {
            id: newId('i'),
            title,
            status,
            progress: normalizeProgress(status, progress),
            type: flags.type || '',
            priority: pickPriority(flags.priority) || '',
            note: flags.note || '',
            updated: stamp(),
            images: [],
            attachments: []
          }
          g.issues.push(issue)
          syncProject(d, projectId)
          return { issue, duplicates }
        })
        const { text } = await readData()
        return out({
          ok: true,
          issue: r.issue,
          ...(r.duplicates.length ? { duplicates: r.duplicates } : {}),
          ...(await afterWrite(text))
        })
      }
      if (sub === 'set') {
        const ids = String(need(rest[0] || flags.ids, 'id')).split(',').map(s => s.trim()).filter(Boolean)
        const progress = pickProgress(flags.progress)
        const r = await mutate((d) => {
          const changed = []
          for (const id of ids) {
            const { projectId, group, issue } = findIssue(d, id)
            const before = { ...issue }
            if (flags.title != null) issue.title = flags.title
            if (flags.note != null) issue.note = flags.note
            if (flags.type != null) issue.type = flags.type
            if (flags.priority != null) issue.priority = pickPriority(flags.priority)
            if (flags.status != null) issue.status = pickStatus(flags.status)
            else if (progress != null) issue.status = statusForProgress(progress, issue.status)
            if (flags.status != null || progress != null) {
              issue.progress = normalizeProgress(issue.status, progress != null ? progress : issue.progress)
            }
            issue.updated = stamp()
            // 变更记录：写清哪条从什么变成什么，详情页直接展示
            const diffs = Object.keys(before)
              .filter(k => k !== 'updated' && JSON.stringify(before[k]) !== JSON.stringify(issue[k]))
              .map(k => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(issue[k])}`)
            if (diffs.length) logChange(d, issue.id, 'issue.set', diffs.join('; '))
            syncProject(d, projectId)
            changed.push({ id: issue.id, projectId, groupId: group.id, ...issue })
          }
          return changed
        })
        const { text } = await readData()
        return out({ ok: true, issues: r, ...(await afterWrite(text)) })
      }
      if (sub === 'move') {
        const id = need(rest[0] || flags.id, 'id')
        const to = need(flags.to, 'to')
        const r = await mutate((d) => {
          const { projectId, group, issue } = findIssue(d, id)
          let targetProject = null
          let targetGroup = null
          for (const [pid, groups] of Object.entries(d.groups)) {
            const g = groups.find(x => x.id === to)
            if (g) { targetProject = pid; targetGroup = g; break }
          }
          if (!targetGroup) throw fail('not_found', `找不到目标子类 ${to}`)
          group.issues = group.issues.filter(x => x.id !== id)
          targetGroup.issues.push(issue)
          syncProject(d, projectId)
          if (targetProject !== projectId) syncProject(d, targetProject)
          logChange(d, id, 'issue.move', `${group.name} → ${targetGroup.name}`)
          return { id, from: group.id, to: targetGroup.id }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }
      if (sub === 'rm') {
        const ids = String(need(rest[0] || flags.ids, 'id')).split(',').map(s => s.trim()).filter(Boolean)
        const hard = !!flags.hard
        const r = await mutate((d) => {
          const archived = []
          const removed = []
          for (const id of ids) {
            const { projectId, group, issue } = findIssue(d, id)
            if (hard) {
              group.issues = group.issues.filter(x => x.id !== id)
              delete d.changes[id]
              removed.push(issue)
            } else {
              // 默认只归档：条目留在原位，历史、图片、变更记录全都还在
              if (!isArchived(issue)) {
                issue.archived = true
                issue.archivedAt = stamp()
                issue.archivedFrom = { projectId, groupId: group.id, groupName: group.name }
                logChange(d, id, 'issue.archive', `归档到「${group.name}」，不参与统计`)
              }
              archived.push({ id, title: issue.title, groupId: group.id, groupName: group.name })
            }
            syncProject(d, projectId)
          }
          if (hard) return { removed }
          return { archived, note: '只是归档，条目还在本机文件里；要真删加 --hard' }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }

      if (sub === 'restore') {
        const ids = String(need(rest[0] || flags.ids, 'id')).split(',').map(s => s.trim()).filter(Boolean)
        const r = await mutate((d) => {
          const restored = []
          for (const id of ids) {
            const { projectId, issue } = findIssue(d, id)
            if (!isArchived(issue)) throw fail('validation_failed', `条目 ${id} 不在归档里`)
            delete issue.archived
            delete issue.archivedAt
            delete issue.archivedFrom
            issue.updated = stamp()
            logChange(d, id, 'issue.restore', '从归档恢复，重新计入统计')
            syncProject(d, projectId)
            restored.push({ id, title: issue.title })
          }
          return { restored }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }

      // 停机自查：不依赖 agent 记得，只按时间算。agent 应该在做计划前先跑一次。
      if (sub === 'stalled') {
        const days = Number(flags.days == null ? STALL_DAYS : flags.days)
        if (!Number.isFinite(days) || days < 0) throw fail('validation_failed', '--days 必须是非负整数')
        const { data } = await readData()
        const rows = []
        for (const p of data.projects) {
          if (flags.project && flags.project !== p.id) continue
          for (const g of groupsOf(data, p.id)) {
            for (const i of g.issues) {
              if (isArchived(i) || i.status === 'done') continue
              const idle = daysSince(i.updated)
              if (idle == null || idle < days) continue
              rows.push({
                id: i.id,
                title: i.title,
                status: i.status,
                progress: i.progress,
                priority: i.priority,
                projectId: p.id,
                projectName: p.name,
                groupId: g.id,
                groupName: g.name,
                updated: i.updated,
                idleDays: idle
              })
            }
          }
        }
        rows.sort((a, b) => b.idleDays - a.idleDays)
        return out({
          ok: true,
          days,
          count: rows.length,
          issues: rows,
          ...(rows.length ? {} : { note: `没有超过 ${days} 天没动的条目` })
        })
      }

      throw fail('bad_command', 'issue 子命令：list / add / set / move / rm / restore / stalled')
    }

    // ---------- 使用说明 ----------
    case 'guide': {
      if (sub !== 'set') throw fail('bad_command', 'guide 只有 set')
      const file = need(flags.file, 'file')
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const guide = { ...parsed, updatedAt: stamp() }
      const r = await mutate((d) => {
        d.guide = guide
        return { title: guide.title, sections: (guide.sections || []).length }
      })
      const { text } = await readData()
      return out({ ok: true, guide: r, ...(await afterWrite(text)) })
    }

    // ---------- 图片 ----------
    case 'img': {
      const issueId = need(rest[0] || flags.issue, 'issue')
      if (sub === 'add') {
        const file = need(flags.file, 'file')
        // 先确认条目存在，再去拿签名、传 OSS；否则条目 ID 写错时会留下一个没人引用的孤儿对象。
        findIssue((await readData()).data, issueId)
        const image = await uploadImage(file, cfg)
        const r = await mutate((d) => {
          const { projectId, issue } = findIssue(d, issueId)
          issue.images = issue.images || []
          issue.images.push(image)
          issue.updated = stamp()
          logChange(d, issueId, 'img.add', image.filename)
          syncProject(d, projectId)
          return image
        })
        const { text } = await readData()
        return out({ ok: true, image: r, ...(await afterWrite(text)) })
      }
      if (sub === 'rm') {
        // 只删除快照里的引用，不在页面/快照里保存 OSS 删除令牌。
        // 原对象由 image-relay 的轮转清扫回收，不会永久留在桶里。
        const objectKey = need(flags.key || rest[1], 'key')
        const r = await mutate((d) => {
          const { projectId, issue } = findIssue(d, issueId)
          const images = issue.images || []
          const target = images.find(img => img.objectKey === objectKey)
          if (!target) throw fail('not_found', `条目 ${issueId} 没有图片 ${objectKey}`)
          issue.images = images.filter(img => img.objectKey !== objectKey)
          issue.updated = stamp()
          logChange(d, issueId, 'img.rm', target.filename || objectKey)
          syncProject(d, projectId)
          return { issueId, removed: target, oss: '原图由中转轮转清扫自动回收' }
        })
        const { text } = await readData()
        return out({ ok: true, ...r, ...(await afterWrite(text)) })
      }
      throw fail('bad_command', 'img 子命令：add / rm')
    }

    default:
      throw fail('bad_command', `未知命令「${cmd}」；执行 node scripts/ld.mjs help 查看全部命令`)
  }
}

// 备份文件写入（原子写，和 projects.json 同款做法）
async function writeDataCopy(file, text) {
  const { writeFile, rename } = await import('node:fs/promises')
  const tmp = `${file}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

run().catch((err) => {
  out({ ok: false, error: { code: err.code || 'error', message: err.message } }, 1)
})
