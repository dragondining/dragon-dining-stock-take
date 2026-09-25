import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const TOKEN_MS = 12 * 60 * 60 * 1000

export function hashPin(pin, saltHex) {
  const salt = Buffer.from(saltHex, 'hex')
  return scryptSync(String(pin), salt, 32).toString('hex')
}

export function verifyPin(pin, saltHex, hashHex) {
  const actual = Buffer.from(hashPin(pin, saltHex), 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function newSecret() {
  return randomBytes(32).toString('hex')
}

export function newSalt() {
  return randomBytes(16).toString('hex')
}

export function issueToken(secret) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_MS })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readToken(secret, token) {
  if (!token || !secret) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const actualBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!payload?.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function pinLooksValid(pin) {
  return typeof pin === 'string' && /^[0-9]{4,8}$/.test(pin.trim())
}
