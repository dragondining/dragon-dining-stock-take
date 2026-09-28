import { createPublicKey, verify } from 'node:crypto'
import { many, one, run } from './query.js'
import { HttpError } from './errors.js'

function publishableKey() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY
}

function secretKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
}

export function supabaseAuthEnabled() {
  return Boolean(process.env.SUPABASE_URL && publishableKey())
}

function authBase() {
  return process.env.SUPABASE_URL.replace(/\/$/, '')
}

function authHeaders() {
  return {
    apikey: publishableKey(),
    'content-type': 'application/json',
  }
}

export async function loginWithUsername(db, username, password) {
  const name = String(username ?? '').trim()
  const secret = String(password ?? '')
  if (!name || !secret) throw new HttpError(400, 'Enter a username and password.')
  const row = await one(db, `
    select p.username, p.role, u.email
    from profiles p
    join auth.users u on u.id = p.id
    where lower(p.username) = lower(?)
  `, [name])
  if (!row) throw new HttpError(401, 'That username or password is not right.')
  const response = await fetch(`${authBase()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email: row.email, password: secret }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) throw new HttpError(401, 'That username or password is not right.')
  return {
    token: data.access_token,
    refresh_token: data.refresh_token,
    username: row.username,
    role: row.role,
  }
}

let jwksCache = { at: 0, keys: [] }

function jsonPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

async function jwkFor(kid) {
  if (Date.now() - jwksCache.at > 60 * 60 * 1000 || !jwksCache.keys.length) {
    const response = await fetch(`${authBase()}/auth/v1/.well-known/jwks.json`)
    if (!response.ok) return null
    const body = await response.json()
    jwksCache = { at: Date.now(), keys: body.keys || [] }
  }
  return jwksCache.keys.find((key) => key.kid === kid) || null
}

export async function subjectFromToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  let header
  let payload
  try {
    header = jsonPart(parts[0])
    payload = jsonPart(parts[1])
  } catch {
    return null
  }
  if (header.alg !== 'ES256' || !payload.sub) return null
  if (payload.exp && payload.exp * 1000 < Date.now()) return null
  const issuer = `${authBase()}/auth/v1`
  if (payload.iss !== issuer) return null
  const jwk = await jwkFor(header.kid)
  if (!jwk) return null
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const valid = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  )
  return valid ? payload.sub : null
}

export async function profileFromToken(db, token) {
  const id = await subjectFromToken(token)
  if (!id) return null
  return one(db, 'select username, role from profiles where id = ?', [id])
}

const EMAIL_DOMAIN = 'dragondining.local'

function serviceKey() {
  const key = secretKey()
  if (!key) throw new HttpError(400, 'People management needs SUPABASE_SECRET_KEY on the server.')
  return key
}

function cleanUsername(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{2,32}$/.test(name)) {
    throw new HttpError(400, 'Username must be 2 to 32 letters, numbers, dots, or dashes.')
  }
  return name
}

function cleanRole(value) {
  const role = String(value ?? '').trim().toLowerCase()
  if (role !== 'staff' && role !== 'manager') throw new HttpError(400, 'Choose staff or manager.')
  return role
}

function cleanPassword(value) {
  const password = String(value ?? '')
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.')
  return password
}

export async function listPeople(db) {
  return many(db, 'select username, role from profiles order by lower(username)')
}

export async function createPerson(db, input) {
  const username = cleanUsername(input.username)
  const password = cleanPassword(input.password)
  const role = cleanRole(input.role)
  const email = `${username}@${EMAIL_DOMAIN}`
  const response = await fetch(`${authBase()}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey(),
      authorization: `Bearer ${serviceKey()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const taken = /already|registered|exists/i.test(String(data.msg || data.message || data.error_description || ''))
    throw new HttpError(taken ? 409 : 400, taken ? 'That username is already used.' : 'The account was not created.')
  }
  const id = data.id || data.user?.id
  if (!id) throw new HttpError(400, 'The account was not created.')
  const existing = await one(db, 'select id from profiles where id = ?', [id])
  if (existing) await run(db, 'update profiles set username = ?, role = ? where id = ?', [username, role, id])
  else await run(db, 'insert into profiles (id, username, role) values (?, ?, ?)', [id, username, role])
  return { username, role }
}

export async function setPersonRole(db, input) {
  const username = cleanUsername(input.username)
  const role = cleanRole(input.role)
  const current = await one(db, 'select id, role from profiles where lower(username) = lower(?)', [username])
  if (!current) throw new HttpError(404, 'That person is not on the list.')
  if (current.role === 'manager' && role === 'staff') {
    const managers = await one(db, "select count(*) as n from profiles where role = 'manager'")
    if (Number(managers.n) <= 1) throw new HttpError(400, 'Keep at least one manager.')
  }
  await run(db, 'update profiles set role = ? where id = ?', [role, current.id])
  return { username, role }
}

export async function setPersonPassword(db, input) {
  const username = cleanUsername(input.username)
  const password = cleanPassword(input.password)
  const current = await one(db, 'select id from profiles where lower(username) = lower(?)', [username])
  if (!current) throw new HttpError(404, 'That person is not on the list.')
  const response = await fetch(`${authBase()}/auth/v1/admin/users/${current.id}`, {
    method: 'PUT',
    headers: {
      apikey: serviceKey(),
      authorization: `Bearer ${serviceKey()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) throw new HttpError(400, 'The password was not changed.')
  return { username }
}
