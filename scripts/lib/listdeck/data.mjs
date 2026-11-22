// 数据的唯一读写实现：改的是本机 projects.json，原子写（tmp → rename），不做服务、不开端口。
// 语义（字段、进度联动、变更记录）与页面渲染保持一致；页面永远只读。
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DATA_FILE, ensureRoot } from './config.mjs'

const EMPTY = { schemaVersion: '1.0', revision: 0, lastWrite: '', guide: null, projects: [], groups: {}, changes: {} }

export const PRIORITIES = ['P0', 'P1', 'P2', '验证', '约束']
export const STATUSES = ['todo', 'doing', 'done']
export const KINDS = ['批次', '主题']

const etagOf = (body) => `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`

export const fail = (code, message) => {
  const err = new Error(message)
  err.code = code
  return err
}

// 时间按本机时区写，跟页面顶栏一个口径
export const stamp = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ_NAME || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date())
  const pick = (t) => parts.find(p => p.type === t)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

export const dayStamp = () => stamp().slice(5, 10)

export const newId = (prefix) =>
  `${prefix}_${createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 6)}`

// 归档不等于删除：条目留在原位，只打 archived 标记。
// 页面把它收进「已归档」，统计不再计入；要真删才用 rm --hard。
export const isArchived = (i) => !!i.archived
export const activeIssues = (issues) => (issues || []).filter(i => !i.archived)

// 「多久没动」：updated 与 stamp() 是同一种本机时间串，按自然日相减，同一天记 0。
// 这是唯一不依赖 agent 自觉的观测指标——它忘了，时间不会。
const dayNum = (text) => {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

export function daysSince(text) {
  const a = dayNum(text)
  const b = dayNum(stamp())
  if (a == null || b == null) return null
  return Math.max(0, Math.round((b - a) / 86400000))
}

// 停滞阈值：非 done 的条目超过这么多天没写入，就算「可能要忘了」
export const STALL_DAYS = 3

// 查重用的标题归一：去掉空白与常见中英文标点，再比包含关系
const normTitle = (s) =>
  String(s || '').toLowerCase().replace(/[\s\u3000·，。、；：:,.;!?！？"'“”‘’（）()【】[\]<>《》—–_-]/g, '')

// 返回 0（不像）/ 0.9（包含且够长）/ 1（完全相同）
export function similarTitle(a, b) {
  const x = normTitle(a)
  const y = normTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  if (long.includes(short) && short.length / long.length >= 0.6) return 0.9
  return 0
}

export function normalizeProgress(status, progress) {
  if (status === 'done') return 100
  if (status === 'todo') return 0
  const p = Number.isFinite(progress) ? Math.round(progress) : 40
  return Math.min(99, Math.max(1, p))
}

async function ensureFile() {
  await ensureRoot()
  if (existsSync(DATA_FILE)) return
  const seed = process.env.LD_BOOTSTRAP_FROM
  if (seed) {
    try {
      await copyFile(seed, DATA_FILE)
      return
    } catch {
      // 迁移失败就当没有，建空快照
    }
  }
  await writeFile(DATA_FILE, JSON.stringify(EMPTY, null, 2), 'utf8')
}

export async function readData() {
  await ensureFile()
  const text = await readFile(DATA_FILE, 'utf8')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw fail('data_corrupt', `${DATA_FILE} 不是合法 JSON，先备份再修`)
  }
  if (!Array.isArray(data.projects)) throw fail('data_corrupt', 'projects 不是数组')
  data.groups = data.groups || {}
  data.changes = data.changes || {}
  return { data, text, etag: etagOf(text) }
}

// 原子写：先写 tmp 再 rename，中途断电也不会留下半个文件
export async function writeData(data) {
  const body = JSON.stringify(data, null, 2)
  const tmp = `${DATA_FILE}.${process.pid}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, DATA_FILE)
  return { data, text: body, etag: etagOf(body) }
}

// 读 → 改 → 写，改完自动更新 lastWrite；mutator 抛错就不落盘。
// revision 是单调递增的写入序号：lastWrite 只精确到分钟，单靠它会把同一分钟内的
// 「另一台机器刚推的新版」误判成一样新，从而漏拉。展示仍用 lastWrite，比较用 revision。
export async function mutate(fn) {
  const { data } = await readData()
  const result = await fn(data)
  data.revision = (Number.isFinite(Number(data.revision)) ? Number(data.revision) : 0) + 1
  data.lastWrite = stamp()
  await writeData(data)
  return result
}

// ---------- 查找与派生 ----------

export const findProject = (data, id) => {
  const p = data.projects.find(x => x.id === id)
  if (!p) throw fail('not_found', `找不到项目 ${id}`)
  return p
}

export const groupsOf = (data, projectId) => {
  data.groups[projectId] = data.groups[projectId] || []
  return data.groups[projectId]
}

export const findGroup = (data, projectId, groupId) => {
  const g = groupsOf(data, projectId).find(x => x.id === groupId)
  if (!g) throw fail('not_found', `在项目 ${projectId} 里找不到子类 ${groupId}`)
  return g
}

export const findIssue = (data, issueId) => {
  for (const [projectId, groups] of Object.entries(data.groups)) {
    for (const group of groups) {
      const issue = group.issues.find(i => i.id === issueId)
      if (issue) return { projectId, group, issue }
    }
  }
  throw fail('not_found', `找不到条目 ${issueId}`)
}

// 项目总数与已完成始终从子类重算；删掉最后一个子类时也必须归零，
// 不能因为 groups 空了就直接 return，把旧的 total/done 留在卡片上。
export function syncProject(data, projectId) {
  const groups = groupsOf(data, projectId)
  const project = data.projects.find(p => p.id === projectId)
  if (!project) return
  const raw = groups.flatMap(g => g.issues)
  const all = activeIssues(raw)
  project.total = all.length
  project.done = all.filter(i => i.status === 'done').length
  project.archived = raw.length - all.length
  project.updated = dayStamp()
}

export function logChange(data, issueId, tool, change) {
  data.changes[issueId] = data.changes[issueId] || []
  data.changes[issueId].unshift({ time: stamp(), tool, change })
  data.changes[issueId] = data.changes[issueId].slice(0, 20)
}
