import { one } from './query.js'
import { HttpError } from './errors.js'

export function supabaseAuthEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}

function authBase() {
  return process.env.SUPABASE_URL.replace(/\/$/, '')
}

function authHeaders() {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
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

export async function profileFromToken(db, token) {
  if (!token) return null
  const response = await fetch(`${authBase()}/auth/v1/user`, {
    headers: { ...authHeaders(), authorization: `Bearer ${token}` },
  })
  if (!response.ok) return null
  const user = await response.json().catch(() => null)
  if (!user?.id) return null
  return one(db, 'select username, role from profiles where id = ?', [user.id])
}
