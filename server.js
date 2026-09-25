import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { issueToken, readToken, verifyPin } from './src/auth.js'
import { importCatalog } from './src/catalog.js'
import { csvFromSnapshot, filenameForLabel } from './src/csv.js'
import { getSetting, openDatabase, prepareDatabase } from './src/db.js'
import { HttpError } from './src/errors.js'
import { one } from './src/query.js'
import {
  abandonCounts,
  addBarcode,
  applyCounts,
  archiveRecord,
  changePin,
  createProduct,
  createRoom,
  exportCatalogCsv,
  finishStockTake,
  getState,
  latestReport,
  listArchives,
  removeBarcode,
  updateProduct,
  updateRoom,
} from './src/stock.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/logic.js': ['shared/logic.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
}

export function defaultDbPath() {
  return path.join(root, 'data', 'stocktake.sqlite')
}

export function starterCatalogPath() {
  return path.resolve(root, '..', 'Starter Files', 'Inventory_for_Grok_MVP.xlsx')
}

export async function startServer(options = {}) {
  const db = openDatabase(options.dbPath || defaultDbPath())
  await prepareDatabase(db)
  const lock = { fails: 0, until: 0 }
  let imported = null
  if (options.autoImport !== false) imported = await maybeAutoImport(db)

  const server = http.createServer(async (req, res) => {
    try {
      await route(db, lock, req, res)
    } catch (error) {
      const status = error.status || 500
      if (status >= 500) console.error(error)
      sendJson(res, status, { error: status >= 500 ? 'Something went wrong on this computer.' : error.message })
    }
  })

  const port = options.port ?? Number(process.env.PORT || 8787)
  const host = options.host || '127.0.0.1'
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    db,
    imported,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          try { db.close() } catch (closeError) { if (!error) error = closeError }
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

async function maybeAutoImport(db) {
  const count = Number((await one(db, 'SELECT COUNT(*) AS n FROM products')).n)
  if (count > 0) return null
  const starter = starterCatalogPath()
  if (!fs.existsSync(starter)) return null
  return importCatalog(db, {
    buffer: fs.readFileSync(starter),
    filename: path.basename(starter),
    mode: 'merge',
  })
}

export async function route(db, lock, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const { pathname } = url

  if (req.method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname]
    const body = fs.readFileSync(path.join(root, file))
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-cache',
    })
    res.end(body)
    return
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, await getState(db))
    return
  }
  if (req.method === 'POST' && pathname === '/api/pin/verify') {
    const body = await readJson(req)
    if (lock.until > Date.now()) throw new HttpError(429, 'Too many tries. Wait 30 seconds.')
    const ok = verifyPin(String(body.pin ?? '').trim(), await getSetting(db, 'pin_salt'), await getSetting(db, 'pin_hash'))
    if (!ok) {
      lock.fails += 1
      if (lock.fails >= 5) {
        lock.until = Date.now() + 30_000
        lock.fails = 0
      }
      throw new HttpError(401, 'That PIN is not right.')
    }
    lock.fails = 0
    sendJson(res, 200, { token: issueToken(await getSetting(db, 'token_secret')) })
    return
  }
  if (req.method === 'POST' && pathname === '/api/pin/change') {
    await requireManager(db, req)
    const body = await readJson(req)
    await changePin(db, body.pin, body.new_pin)
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && pathname === '/api/counts') {
    const body = await readJson(req)
    sendJson(res, 200, { results: await applyCounts(db, body.counts) })
    return
  }
  if (req.method === 'POST' && pathname === '/api/barcodes') {
    const body = await readJson(req)
    sendJson(res, 200, { product: await addBarcode(db, body.code, Number(body.product_id)) })
    return
  }
  if (req.method === 'DELETE' && pathname === '/api/barcodes') {
    await requireManager(db, req)
    await removeBarcode(db, url.searchParams.get('code'))
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && pathname === '/api/products') {
    await requireManager(db, req)
    const body = await readJson(req)
    sendJson(res, 200, { product: await createProduct(db, body) })
    return
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/products/')) {
    await requireManager(db, req)
    const id = Number(pathname.slice('/api/products/'.length))
    const body = await readJson(req)
    sendJson(res, 200, { product: await updateProduct(db, id, body) })
    return
  }
  if (req.method === 'POST' && pathname === '/api/rooms') {
    await requireManager(db, req)
    const body = await readJson(req)
    sendJson(res, 200, { room: await createRoom(db, body) })
    return
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/rooms/')) {
    await requireManager(db, req)
    const id = Number(pathname.slice('/api/rooms/'.length))
    const body = await readJson(req)
    sendJson(res, 200, { room: await updateRoom(db, id, body) })
    return
  }
  if (req.method === 'POST' && pathname === '/api/import') {
    await requireManager(db, req)
    const buffer = await readBody(req, 30_000_000)
    const filename = decodeURIComponent(req.headers['x-filename'] || 'catalog.xlsx')
    const report = await importCatalog(db, {
      buffer,
      filename,
      mode: url.searchParams.get('mode') || 'merge',
      confirm: url.searchParams.get('confirm'),
      abandon: url.searchParams.get('abandon') === '1',
    })
    sendJson(res, 200, { report })
    return
  }
  if (req.method === 'GET' && pathname === '/api/import/latest') {
    await requireManager(db, req)
    sendJson(res, 200, { report: await latestReport(db) })
    return
  }
  if (req.method === 'GET' && pathname === '/api/catalog.csv') {
    await requireManager(db, req)
    sendText(res, 200, await exportCatalogCsv(db), 'text/csv; charset=utf-8', {
      'content-disposition': 'attachment; filename="Dragon-Dining-catalog.csv"',
    })
    return
  }
  if (req.method === 'POST' && pathname === '/api/stocktake/abandon') {
    await requireManager(db, req)
    await abandonCounts(db)
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && pathname === '/api/stocktake/finish') {
    await requireManager(db, req)
    const body = await readJson(req)
    sendJson(res, 200, await finishStockTake(db, body.label))
    return
  }
  if (req.method === 'GET' && pathname === '/api/archives') {
    await requireManager(db, req)
    sendJson(res, 200, { archives: await listArchives(db) })
    return
  }
  const archiveMatch = pathname.match(/^\/api\/archives\/([^/]+)\.csv$/)
  if (req.method === 'GET' && archiveMatch) {
    await requireManager(db, req)
    const row = await archiveRecord(db, decodeURIComponent(archiveMatch[1]))
    sendText(res, 200, csvFromSnapshot(row.snapshot_json), 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="${filenameForLabel(row.label)}"`,
    })
    return
  }

  sendJson(res, 404, { error: 'That page is not here.' })
}

async function requireManager(db, req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const session = readToken(await getSetting(db, 'token_secret'), token)
  if (!session) throw new HttpError(401, 'Manager PIN required.')
  return session
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'That file is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const buffer = await readBody(req, 2_000_000)
  if (!buffer.length) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, 'That request could not be read.')
  }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', payload.length)
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function sendText(res, status, body, type, extra = {}) {
  const payload = Buffer.from(body)
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('content-length', payload.length)
  res.setHeader('cache-control', 'no-store')
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value)
  res.end(payload)
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
if (isMain) {
  const running = await startServer()
  const products = Number((await one(running.db, 'SELECT COUNT(*) AS n FROM products')).n)
  console.log('Dragon Dining Stock Take')
  console.log(`Open ${running.url}`)
  console.log('This address is only on this computer. Other devices on the Wi-Fi cannot open it.')
  console.log(`Database: ${defaultDbPath()}`)
  console.log(products ? `Catalog loaded (${products} items).` : 'No catalog yet. A manager can import the spreadsheet.')
  if (running.imported) {
    console.log(`Imported ${running.imported.products_inserted} items from ${running.imported.filename}.`)
  }
  console.log('Manager PIN starts as 1234. Change it from the manager screen.')
}
