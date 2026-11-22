import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './config.mjs'

const nowStamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const nowIso = () => new Date().toISOString()
const uid = (prefix) => `${prefix}_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-4)}`

export const newId = (prefix) => uid(prefix)

export const emptyData = () => ({
  schemaVersion: 1,
  channel: '',
  revision: 0,
  lastWrite: '',
  plans: [],
  reviews: []
})

function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((ev) => {
      if (!ev || typeof ev !== 'object') return null
      if (ev.kind === 'text') return { kind: 'text', text: String(ev.text || '').slice(0, 5000) }
      if (ev.kind === 'link') {
        const url = String(ev.url || '')
        return /^https?:\/\//i.test(url)
          ? { kind: 'link', url, label: String(ev.label || url).slice(0, 200) }
          : null
      }
      if (ev.kind === 'image' && ev.objectKey) {
        return {
          kind: 'image',
          objectKey: String(ev.objectKey),
          filename: String(ev.filename || ''),
          mime: String(ev.mime || ''),
          size: Number(ev.size) || 0,
          sha256: String(ev.sha256 || '')
        }
      }
      return null
    })
    .filter(Boolean)
}

function normalizeItem(raw, prefix = 'i') {
  const item = raw && typeof raw === 'object' ? raw : {}
  return {
    id: item.id || uid(prefix),
    priority: ['P0', 'P1', 'P2'].includes(item.priority) ? item.priority : '',
    title: String(item.title || '').slice(0, 500),
    steps: Array.isArray(item.steps) ? item.steps.map((s) => String(s)).filter(Boolean).slice(0, 20) : [],
    expected: String(item.expected || '').slice(0, 8000),
    note: String(item.note || '').slice(0, 8000),
    evidence: normalizeEvidence(item.evidence),
    fixLog: Array.isArray(item.fixLog)
      ? item.fixLog.map((row) => ({
          time: String(row?.time || ''),
          version: String(row?.version || ''),
          text: String(row?.text || '')
        })).slice(-80)
      : [],
    updated: String(item.updated || '')
  }
}

function normalizeSection(raw) {
  const section = raw && typeof raw === 'object' ? raw : {}
  return {
    id: section.id || uid('s'),
    no: String(section.no || ''),
    title: String(section.title || '').slice(0, 300),
    desc: String(section.desc || '').slice(0, 3000),
    items: Array.isArray(section.items) ? section.items.map((item) => normalizeItem(item)) : []
  }
}

export function normalizePlan(raw) {
  const plan = raw && typeof raw === 'object' ? raw : {}
  return {
    id: plan.id || uid('a'),
    title: String(plan.title || '').slice(0, 300),
    sourceTask: String(plan.sourceTask || '').slice(0, 300),
    agent: String(plan.agent || '').slice(0, 120),
    environment: String(plan.environment || '').slice(0, 500),
    summary: String(plan.summary || '').slice(0, 8000),
    status: plan.status === 'closed' ? 'closed' : 'active',
    version: Math.max(1, Math.floor(Number(plan.version) || 1)),
    createdAt: String(plan.createdAt || nowStamp()),
    updatedAt: String(plan.updatedAt || nowStamp()),
    sections: Array.isArray(plan.sections) ? plan.sections.map(normalizeSection) : []
  }
}

export async function ensureHome() {
  await mkdir(paths.dir, { recursive: true })
}

export async function readData() {
  await ensureHome()
  if (!existsSync(paths.data)) return emptyData()
  try {
    const parsed = JSON.parse(await readFile(paths.data, 'utf8'))
    return {
      ...emptyData(),
      ...parsed,
      plans: Array.isArray(parsed.plans) ? parsed.plans.map(normalizePlan) : [],
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : []
    }
  } catch (err) {
    throw new Error(`plans.json 解析失败：${err.message}`)
  }
}

export async function writeData(data) {
  await ensureHome()
  const tmp = join(paths.dir, `plans.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, paths.data)
  return data
}

export function markChanged(data) {
  data.revision = Math.max(0, Number(data.revision) || 0) + 1
  data.lastWrite = nowStamp()
  return data
}

export function bumpPlan(plan) {
  plan.version = Math.max(1, Number(plan.version) || 1) + 1
  plan.updatedAt = nowStamp()
  return plan
}

export function planOf(data, planId) {
  const plan = data.plans.find((p) => p.id === planId)
  if (!plan) throw new Error(`找不到验收单：${planId}`)
  return plan
}

export function sectionOf(plan, sectionId) {
  const section = plan.sections.find((s) => s.id === sectionId)
  if (!section) throw new Error(`验收单 ${plan.id} 找不到章节：${sectionId}`)
  return section
}

export function itemOf(data, itemId) {
  for (const plan of data.plans) {
    for (const section of plan.sections || []) {
      const item = (section.items || []).find((row) => row.id === itemId)
      if (item) return { plan, section, item }
    }
  }
  throw new Error(`找不到验收项：${itemId}`)
}

export function nextSectionNo(plan) {
  const nums = plan.sections
    .map((s) => Number(s.no))
    .filter((n) => Number.isFinite(n))
  const next = nums.length ? Math.max(...nums) + 1 : 0
  return String(next).padStart(2, '0')
}

// 人工结论只有四档：待验 / 通过 / 不通过 / 暂缓。
// 旧数据里的 untested / retest / block / skip 在这里归并，历史结论不丢。
export const STATUS_TEXT = {
  pending: '待验',
  pass: '通过',
  fail: '不通过',
  hold: '暂缓'
}
export const STATUS_KEYS = Object.keys(STATUS_TEXT)
const LEGACY_STATUS = { untested: 'pending', retest: 'pending', block: 'hold', skip: 'hold' }
export const canonicalStatus = (raw) =>
  STATUS_KEYS.includes(raw) ? raw : LEGACY_STATUS[raw] || 'pending'
export const statusText = (raw) => STATUS_TEXT[canonicalStatus(raw)]

export function statsOfPlan(plan, review) {
  const items = (plan.sections || []).flatMap((s) => s.items || [])
  const stats = { total: items.length, tested: 0, pass: 0, fail: 0, hold: 0, pending: items.length, clean: false, pct: 0 }
  for (const item of items) {
    const status = canonicalStatus(review?.items?.[item.id]?.status)
    if (status !== 'pending') {
      stats.tested++
      stats.pending--
    }
    if (status === 'pass') stats.pass++
    else if (status === 'fail') stats.fail++
    else if (status === 'hold') stats.hold++
  }
  stats.pct = stats.total ? Math.round((stats.tested / stats.total) * 100) : 0
  stats.clean = stats.total > 0 && stats.pending === 0 && stats.fail === 0
  return stats
}

export function mergeReview(data, review) {
  if (!review || !review.planId || !review.submittedAt) return false
  const index = data.reviews.findIndex((row) => row.planId === review.planId)
  if (index >= 0) {
    const old = data.reviews[index]
    if (String(old.submittedAt || '') >= String(review.submittedAt || '')) return false
    data.reviews[index] = review
  } else {
    data.reviews.push(review)
  }
  return true
}

export { nowStamp, nowIso }
