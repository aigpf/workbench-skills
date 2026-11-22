// 快照上下行：POST /api/listdeck/push 推、GET /api/listdeck/snapshot 拉。
// 同一个 key 就是同一个抽屉：谁后推谁覆盖，服务器不做冲突判定（同步由 agent 负责）。
// pull 只在服务器那份更新时覆盖本地，避免拿着旧文件在另一台设备上瞎改。
import { readConfig } from './config.mjs'
import { readData, writeData } from './data.mjs'

const TIMEOUT_MS = 6000

export async function pushSnapshot(text, { quiet = false } = {}) {
  const cfg = await readConfig()
  if (!cfg.syncUrl) {
    if (!quiet) console.error('未配置 syncUrl，跳过推送（数据只在本地）')
    return { ok: false, skipped: true }
  }
  const url = `${cfg.syncUrl}/api/listdeck/push?k=${encodeURIComponent(cfg.channel)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.syncToken ? { 'x-sync-token': cfg.syncToken } : {})
      },
      body: text,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) {
      const why = await res.text().catch(() => '')
      if (!quiet) console.error(`推送失败：HTTP ${res.status} ${why.slice(0, 200)}`)
      return { ok: false, status: res.status, detail: why.slice(0, 200) }
    }
    const body = await res.json().catch(() => null)
    if (!quiet) console.error(`已推送到频道 ${cfg.channel}（${body?.data?.projects ?? '?'} 个项目）`)
    return { ok: true, data: body?.data }
  } catch (err) {
    if (!quiet) console.error(`推送失败：${err.name === 'TimeoutError' ? `超过 ${TIMEOUT_MS}ms` : err.message}`)
    return { ok: false, error: err.message, code: err.name === 'TimeoutError' ? 'timeout' : 'network' }
  }
}

// 拉最新：服务器上的 lastWrite 比本地新才覆盖本地（谁新用谁）
export async function pullSnapshot({ quiet = false } = {}) {
  const cfg = await readConfig()
  if (!cfg.syncUrl) return { ok: false, skipped: true }
  const url = `${cfg.syncUrl}/api/listdeck/snapshot?k=${encodeURIComponent(cfg.channel)}`
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 503) return { ok: true, pulled: false, empty: true }
    if (!res.ok) {
      if (!quiet) console.error(`拉取失败：HTTP ${res.status}`)
      return { ok: false, status: res.status }
    }
    const remote = await res.json()
    const local = (await readData()).data
    if (!remote || !Array.isArray(remote.projects)) return { ok: false, error: '快照格式不对' }
    // 有 revision 就以它为准：lastWrite 只有分钟精度，同一分钟内的串行写入也必须能拉下来。
    // 两边都还是旧格式（没有 revision）时，才退回 lastWrite 比较。
    const remoteRev = Number(remote.revision) || 0
    const localRev = Number(local.revision) || 0
    const isNewer = (remoteRev > 0 || localRev > 0)
      ? remoteRev > localRev
      : String(remote.lastWrite || '') > String(local.lastWrite || '')
    if (!isNewer) return { ok: true, pulled: false, lastWrite: local.lastWrite || '', revision: localRev }

    await writeData(remote)
    if (!quiet) console.error(`已拉取频道 ${cfg.channel} 的最新快照（${remote.projects.length} 个项目，${remote.lastWrite}）`)
    return { ok: true, pulled: true, lastWrite: remote.lastWrite || '', revision: remoteRev, projects: remote.projects.length }
  } catch (err) {
    if (!quiet) console.error(`拉取失败：${err.name === 'TimeoutError' ? `超过 ${TIMEOUT_MS}ms` : err.message}`)
    return { ok: false, error: err.message }
  }
}
