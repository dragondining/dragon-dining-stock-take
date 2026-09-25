import { route } from '../server.js'
import { openPostgres } from '../src/pg.js'

export const config = {
  api: { bodyParser: false },
}

const lock = { fails: 0, until: 0 }

export default async function handler(req, res) {
  try {
    if (req.body != null && !req.readable) {
      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      req.on = (event, fn) => {
        if (event === 'data') fn(payload)
        if (event === 'end') fn()
        return req
      }
    }
    await route(openPostgres(), lock, req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error(error)
    const body = JSON.stringify({ error: status >= 500 ? 'Something went wrong on this computer.' : error.message })
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
  }
}
