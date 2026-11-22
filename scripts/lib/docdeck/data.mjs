import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './config.mjs'

const nowStamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export { nowStamp }

export const KIND_TEXT = { op: '操作文档', req: '需求文档', doc: '说明' }
export const KIND_KEYS = Object.keys(KIND_TEXT)
export const kindOf = (raw) => (KIND_KEYS.includes(raw) ? raw : 'doc')

// 文档挂在子项目下：进入台先看子项目，再看项目里的文档
export const DEFAULT_PROJECT = '通用'

const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{1,59}$/

export const emptyData = () => ({
  schemaVersion: 1,
  channel: '',
  revision: 0,
  lastWrite: '',
  docs: []
})

// 字数口径和服务端、页面一致：去掉所有空白
export const charsOf = (md) => String(md || '').replace(/[\s\u3000]/g, '').length

export const newDocId = (title = '') => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const rand = Math.random().toString(36).slice(2, 6)
  return slug ? `d-${stamp}-${slug}-${rand}` : `d-${stamp}-${rand}`
}

function normalizeDoc(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {}
  const md = String(doc.md || '')
  return {
    id: String(doc.id || newDocId(doc.title)),
    title: String(doc.title || '').slice(0, 120),
    kind: kindOf(doc.kind),
    summary: String(doc.summary || '').slice(0, 400),
    source: String(doc.source || '').slice(0, 120),
    project: String(doc.project || DEFAULT_PROJECT).trim().slice(0, 40) || DEFAULT_PROJECT,
    version: Math.max(1, Math.floor(Number(doc.version) || 1)),
    updatedAt: String(doc.updatedAt || nowStamp()),
    chars: Math.max(0, Math.floor(Number(doc.chars) || charsOf(md))),
    md
  }
}

export async function ensureHome() {
  await mkdir(paths.dir, { recursive: true })
}

export async function readData() {
  await ensureHome()
  if (!existsSync(paths.data)) return emptyData()
  let parsed
  try {
    parsed = JSON.parse(await readFile(paths.data, 'utf8'))
  } catch (err) {
    throw new Error(`docs.json 解析失败：${err.message}`)
  }
  return {
    ...emptyData(),
    ...parsed,
    docs: Array.isArray(parsed.docs) ? parsed.docs.map(normalizeDoc) : []
  }
}

export async function writeData(data) {
  await ensureHome()
  const tmp = join(paths.dir, `docs.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, paths.data)
  return data
}

export function markChanged(data) {
  data.revision = Math.max(0, Number(data.revision) || 0) + 1
  data.lastWrite = nowStamp()
  return data
}

export function docOf(data, id) {
  const doc = data.docs.find((row) => row.id === id)
  if (!doc) throw new Error(`找不到文档：${id}`)
  return doc
}

export function addDoc(data, input, force = false) {
  const title = String(input.title || '').trim()
  if (!title) throw new Error('文档缺少标题（--title）')
  const md = String(input.md || '')
  if (!md.trim()) throw new Error('文档正文为空（--file 或 --md）')

  // 查重只看标题：同标题再写一篇，八成是想更新而不是新开一份
  const same = data.docs.find((row) => row.title === title)
  if (same && !force) {
    const err = new Error(`已有同标题文档：${same.id}（${same.title}）`)
    err.code = 'duplicate_doc'
    err.data = { id: same.id, title: same.title, version: same.version, updatedAt: same.updatedAt }
    throw err
  }

  const id = input.id ? String(input.id) : newDocId(title)
  if (!DOC_ID_RE.test(id)) throw new Error(`文档 id 不合法：${id}`)
  if (data.docs.some((row) => row.id === id)) throw new Error(`文档 id 已存在：${id}`)

  const doc = normalizeDoc({
    id,
    title,
    kind: input.kind,
    summary: input.summary,
    source: input.source,
    project: input.project,
    version: 1,
    updatedAt: nowStamp(),
    chars: charsOf(md),
    md
  })
  data.docs.push(doc)
  return doc
}

export function setDoc(data, id, input) {
  const doc = docOf(data, id)
  const md = input.md == null ? doc.md : String(input.md)
  if (!md.trim()) throw new Error('正文不能为空')
  if (input.title) doc.title = String(input.title).slice(0, 120)
  if (input.kind) doc.kind = kindOf(input.kind)
  if (input.summary != null) doc.summary = String(input.summary).slice(0, 400)
  if (input.source != null) doc.source = String(input.source).slice(0, 120)
  if (input.project != null) doc.project = String(input.project || DEFAULT_PROJECT).trim().slice(0, 40) || DEFAULT_PROJECT
  doc.md = md
  doc.chars = charsOf(md)
  doc.version = Math.max(1, Number(doc.version) || 1) + 1
  doc.updatedAt = nowStamp()
  return doc
}

export function removeDoc(data, id) {
  const index = data.docs.findIndex((row) => row.id === id)
  if (index < 0) throw new Error(`找不到文档：${id}`)
  return data.docs.splice(index, 1)[0]
}

export function docSummary(doc) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    kindText: KIND_TEXT[doc.kind],
    summary: doc.summary,
    source: doc.source,
    project: doc.project,
    version: doc.version,
    updatedAt: doc.updatedAt,
    chars: doc.chars,
    minutes: Math.max(1, Math.round(doc.chars / 300))
  }
}
