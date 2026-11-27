// 新设备自助领频道：POST /api/listdeck/claim，服务器发一个随机频道 key 和这个频道的专属写令牌。
// 领到就写进本机 config.json，之后 push / connect 都照常用，不需要任何人手工传令牌。
import { readConfig, writeConfig, pageUrl } from './config.mjs'

const TIMEOUT_MS = 8000

export async function claimDevice({ name = '' } = {}) {
  const cfg = await readConfig()
  if (!cfg.syncUrl) return { ok: false, error: { code: 'no_sync_url', message: '没有配置 syncUrl，无法领取频道' } }
  let res
  try {
    res = await fetch(`${cfg.syncUrl}/api/listdeck/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: String(name || '').slice(0, 40) }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    return {
      ok: false,
      error: { code: err.name === 'TimeoutError' ? 'timeout' : 'network', message: err.message }
    }
  }
  const body = await res.json().catch(() => null)
  if (res.status === 404) {
    return {
      ok: false,
      error: { code: 'claim_not_supported', message: '服务器还没开自助领取（/api/listdeck/claim 不存在），先让维护者升级中转服务' }
    }
  }
  if (!res.ok || !body?.ok || !body?.data?.channel || !body?.data?.syncToken) {
    return {
      ok: false,
      status: res.status,
      error: body?.error || { code: 'claim_failed', message: `HTTP ${res.status}` }
    }
  }

  cfg.channel = String(body.data.channel).trim().toLowerCase()
  cfg.syncToken = String(body.data.syncToken).trim()
  await writeConfig(cfg)
  return { ok: true, channel: cfg.channel, syncToken: cfg.syncToken, pageUrl: pageUrl(cfg) }
}
