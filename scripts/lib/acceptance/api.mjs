import { requireChannel } from './config.mjs'

const apiError = (message, status, code) => {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

const parseResponse = async (res) => {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw apiError(body?.error?.message || `HTTP ${res.status}`, res.status, body?.error?.code || 'http_error')
  }
  return body
}

export async function pushData(data, config) {
  const channel = requireChannel(config)
  const res = await fetch(`${config.baseUrl}/api/acceptance/push?k=${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.syncToken ? { 'x-sync-token': config.syncToken } : {})
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000)
  })
  return parseResponse(res)
}

export async function pullReview(config) {
  const channel = requireChannel(config)
  const res = await fetch(`${config.baseUrl}/api/acceptance/review?k=${encodeURIComponent(channel)}`, {
    headers: config.syncToken ? { 'x-sync-token': config.syncToken } : {},
    signal: AbortSignal.timeout(10000)
  })
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}))
    return { ok: true, empty: true, message: body?.error?.message || '还没有验收结果' }
  }
  return parseResponse(res)
}

export async function health(config) {
  const channel = requireChannel(config)
  const res = await fetch(`${config.baseUrl}/health?k=${encodeURIComponent(channel)}`, {
    signal: AbortSignal.timeout(8000)
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
