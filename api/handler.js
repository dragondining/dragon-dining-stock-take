import { route } from '../server.js'
import { prepareDatabase } from '../src/db.js'
import { openPostgres } from '../src/pg.js'

export const config = {
  api: { bodyParser: false },
}

const lock = { fails: 0, until: 0 }

function publicError(error) {
  const message = String(error?.message || 'Something went wrong on this computer.')
  if (/postgres(ql)?:\/\//i.test(message) || /password/i.test(message)) {
    return 'The database connection was refused. Check SUPABASE_DB_URL, then redeploy.'
  }
  return message
}

export default async function handler(req, res) {
  try {
    if (!req.url) req.url = '/'
    const db = openPostgres()
    if (!globalThis.__dragonDiningReady) {
      await prepareDatabase(db)
      globalThis.__dragonDiningReady = true
    }
    await route(db, lock, req, res)
  } catch (error) {
    const status = error.status || 500
    console.error(error)
    const body = JSON.stringify({ error: publicError(error) })
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
  }
}
