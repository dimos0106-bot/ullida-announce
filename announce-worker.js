/**
 * Сервер объявлений открытых миров для Ullida Launcher (Cloudflare Workers + KV).
 *
 * Хост каждые ~30 секунд отправляет POST /announce с данными мира.
 * Запись живёт 90 секунд: если хост пропал, мир сам исчезает из списка.
 * Игроки читают GET /worlds и по коду входят через GET /join/:code.
 *
 * Привязка KV-пространства: переменная WORLDS (см. wrangler.toml).
 */

const TTL_SECONDS = 90
const MAX_NAME = 64
const CODE_LEN = 6
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // без похожих символов

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  })

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN))
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/** Проверка тела объявления. Возвращает нормализованный объект или строку ошибки. */
export function validateAnnouncement(body) {
  if (!body || typeof body !== 'object') return 'нужен JSON-объект'
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > MAX_NAME) return `имя мира: от 1 до ${MAX_NAME} символов`
  const players = Number.isInteger(body.players) ? body.players : -1
  const max = Number.isInteger(body.max) ? body.max : -1
  if (players < 0 || max < 1 || players > max) return 'players и max заданы неверно'
  const version = typeof body.version === 'string' ? body.version.slice(0, 16) : ''
  const host = typeof body.host === 'string' ? body.host.slice(0, 32) : ''
  return { name, players, max, version, host }
}

async function announce(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'плохой JSON' }, 400)
  }
  const v = validateAnnouncement(body)
  if (typeof v === 'string') return json({ error: v }, 400)

  // Код приглашения привязан к хосту: повторное объявление того же хоста обновляет запись.
  const hostId = typeof body.hostId === 'string' && body.hostId.length >= 8 ? body.hostId.slice(0, 64) : null
  if (!hostId) return json({ error: 'нужен hostId (не короче 8 символов)' }, 400)

  const existing = await env.WORLDS.get(`host:${hostId}`, 'json')
  const code = existing?.code ?? makeCode()
  const record = { ...v, code, hostId, seen: Date.now() }

  await env.WORLDS.put(`world:${code}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS })
  await env.WORLDS.put(`host:${hostId}`, JSON.stringify({ code }), { expirationTtl: TTL_SECONDS * 10 })
  // hostId наружу не отдаём: в списке только код и публичные поля.
  return json({ code, ttl: TTL_SECONDS })
}

async function listWorlds(env) {
  const out = []
  let cursor
  do {
    const page = await env.WORLDS.list({ prefix: 'world:', cursor })
    for (const k of page.keys) {
      const rec = await env.WORLDS.get(k.name, 'json')
      if (rec) out.push({ code: rec.code, name: rec.name, host: rec.host, version: rec.version, players: rec.players, max: rec.max })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return json({ worlds: out.slice(0, 200) })
}

async function joinByCode(code, env) {
  const rec = await env.WORLDS.get(`world:${code.toUpperCase()}`, 'json')
  if (!rec) return json({ error: 'мир с таким кодом не открыт' }, 404)
  return json({ code: rec.code, name: rec.name, host: rec.host, version: rec.version, players: rec.players, max: rec.max })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return json({}, 204)
    if (request.method === 'POST' && url.pathname === '/announce') return announce(request, env)
    if (request.method === 'GET' && url.pathname === '/worlds') return listWorlds(env)
    const m = url.pathname.match(/^\/join\/([A-Za-z0-9]{4,12})$/)
    if (request.method === 'GET' && m) return joinByCode(m[1], env)
    return json({ error: 'не найдено' }, 404)
  },
}
