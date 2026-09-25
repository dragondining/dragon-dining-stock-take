import { createHash } from 'node:crypto'
import XLSX from 'xlsx'
import { HttpError } from './errors.js'
import { withTransaction } from './db.js'
import { many, one, run } from './query.js'

const ROOM_ORDER = [
  'Cafe',
  'Dry Storage',
  'Kitchen',
  'Outside Chemical Shed',
  'Outside Dry Stock Shed',
  'Shop',
  'Walk-in Fridge',
  'Walk-in Freezer',
  'Unassigned',
]

const ROOM_ALIASES = new Map([
  ['storefront', 'Shop'],
  ['shop', 'Shop'],
  ['cafe', 'Cafe'],
  ['café', 'Cafe'],
  ['drystorage', 'Dry Storage'],
  ['kitchen', 'Kitchen'],
  ['outsidechemicalshed', 'Outside Chemical Shed'],
  ['outsidedrystockshed', 'Outside Dry Stock Shed'],
  ['walkinfridge', 'Walk-in Fridge'],
  ['walkinfreezer', 'Walk-in Freezer'],
  ['unassigned', 'Unassigned'],
])

const NORMAL_UOM = new Set(['g', 'kg', 'ml', 'l', 'pcs'])
const PLACEHOLDER = /^(no barcode|a{2,}|none|n\/?a|barcode)$/i

const HEADER_MAP = {
  id: 'id',
  location: 'location',
  source: 'source',
  name: 'name',
  'item name': 'name',
  'stock unit': 'stock_unit',
  unit: 'stock_unit',
  'pack qty': 'pack_qty',
  'item size': 'item_size',
  uom: 'uom',
  'cost yen': 'cost',
  cost: 'cost',
  barcode: 'barcode',
  note: 'note',
  description: 'description',
  fingerprint: 'fingerprint',
}

export function canonicalRoom(raw) {
  if (raw == null) return 'Unassigned'
  const text = String(raw).trim().replace(/\s+/g, ' ')
  if (!text) return 'Unassigned'
  const key = text.toLowerCase().replace(/[\s_-]+/g, '')
  return ROOM_ALIASES.get(key) || text
}

export function parseCost(value) {
  if (value == null || value === '') return { cost: null, fromText: false }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { cost: null, fromText: false }
    return { cost: Math.round(value), fromText: false }
  }
  const text = String(value).trim()
  if (!text) return { cost: null, fromText: false }
  const cleaned = text.replace(/[¥￥,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { cost: null, fromText: true, invalid: text }
  return { cost: Math.round(Number(cleaned)), fromText: true }
}

export function parsePack(value) {
  if (value == null || value === '') return { pack_qty: null, pack_qty_note: null }
  if (typeof value === 'number' && Number.isFinite(value)) return { pack_qty: value, pack_qty_note: null }
  const text = String(value).trim()
  if (!text) return { pack_qty: null, pack_qty_note: null }
  if (/^-?\d+(\.\d+)?$/.test(text)) return { pack_qty: Number(text), pack_qty_note: null }
  const match = text.match(/-?\d+(\.\d+)?/)
  return { pack_qty: match ? Number(match[0]) : null, pack_qty_note: text }
}

export function barcodeTokens(value) {
  const dropped = []
  if (value == null || value === '') return { tokens: [], dropped }
  let raw
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    raw = Number.isSafeInteger(rounded) && Math.abs(value - rounded) < 1e-6 ? String(rounded) : String(value)
  } else {
    raw = String(value).trim()
  }
  if (!raw) return { tokens: [], dropped }
  const tokens = []
  const seen = new Set()
  for (let part of raw.split(/[;,]/)) {
    part = part.trim()
    if (!part) continue
    if (/^\d+\.0$/.test(part)) part = part.slice(0, -2)
    if (PLACEHOLDER.test(part)) {
      dropped.push(part)
      continue
    }
    const key = part.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(part)
  }
  return { tokens, dropped }
}

function sheetId(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+\.0$/.test(text)) return text.slice(0, -2)
  return text
}

function asText(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value)
    return String(value)
  }
  const text = String(value).trim()
  return text || null
}

function normHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function hashKey(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function contentKey(product) {
  return JSON.stringify([
    product.room,
    product.source || '',
    product.name,
    product.stock_unit || '',
    product.pack_qty,
    product.pack_qty_note || '',
    product.item_size || '',
    product.uom || '',
    product.unit_cost_yen,
    product.note || '',
  ])
}

function mapHeaders(headerRow) {
  const map = {}
  headerRow.forEach((cell, index) => {
    const key = HEADER_MAP[normHeader(cell)]
    if (key && map[key] == null) map[key] = index
  })
  if (map.id == null && map.location != null) {
    const first = headerRow[0]
    const firstHeader = normHeader(first)
    if (typeof first === 'number' || firstHeader === '' || firstHeader === '0') map.id = 0
  }
  return map
}

function findHeaderIndex(rows) {
  const limit = Math.min(rows.length, 15)
  for (let index = 0; index < limit; index += 1) {
    const cells = (rows[index] || []).map(normHeader)
    if (cells.includes('location') && (cells.includes('name') || cells.includes('item name'))) return index
  }
  return -1
}

function sheetByName(workbook, name) {
  const found = workbook.SheetNames.find((sheet) => sheet.trim().toLowerCase() === name.toLowerCase())
  return found ? workbook.Sheets[found] : null
}

function rowsFromSheet(sheet) {
  if (!sheet) return []
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true })
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function looksLikeZip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

function readTables(buffer, filename) {
  const name = filename || ''
  const csvName = name.toLowerCase().endsWith('.csv')
  if (!csvName && looksLikeZip(buffer)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
    return {
      products: rowsFromSheet(sheetByName(workbook, 'Products') || workbook.Sheets[workbook.SheetNames[0]]),
      counts: rowsFromSheet(sheetByName(workbook, 'Counts')),
      archives: rowsFromSheet(sheetByName(workbook, 'Archives')),
    }
  }
  const text = buffer.toString('utf8')
  return { products: parseCsv(text), counts: [], archives: [] }
}

function cell(row, map, key) {
  const index = map[key]
  if (index == null) return null
  const value = row[index]
  return value == null || value === '' ? null : value
}

function assignFingerprints(products) {
  const idCounts = new Map()
  for (const product of products) {
    if (!product.sheet_id) continue
    idCounts.set(product.sheet_id, (idCounts.get(product.sheet_id) || 0) + 1)
  }
  for (const product of products) {
    if (product.sheet_fingerprint) {
      product.external_id = product.sheet_id && idCounts.get(product.sheet_id) === 1 ? product.sheet_id : null
      product.fingerprint = product.sheet_fingerprint
      continue
    }
    if (product.sheet_id && idCounts.get(product.sheet_id) === 1) {
      product.external_id = product.sheet_id
      product.fingerprint = `ext:${product.sheet_id}`
    } else {
      product.external_id = null
    }
  }
  const seen = new Map()
  for (const product of products) {
    if (product.fingerprint) continue
    const key = contentKey(product)
    const index = seen.get(key) || 0
    product.fingerprint = `fp:${hashKey(key)}#${index}`
    seen.set(key, index + 1)
  }
}

export function parseCatalog(buffer, filename = 'catalog.xlsx') {
  const tables = readTables(buffer, filename)
  const rows = tables.products
  const headerIndex = findHeaderIndex(rows)
  if (headerIndex < 0) throw new HttpError(400, 'That file has no item header row.')
  const map = mapHeaders(rows[headerIndex] || [])
  if (map.name == null || map.location == null) throw new HttpError(400, 'That file needs item name and location columns.')

  const report = {
    filename,
    rows_read: 0,
    skipped_empty: [],
    external_ids_kept: 0,
    external_ids_dropped_duplicate: [],
    external_ids_blank: 0,
    barcodes_attached: 0,
    barcodes_dropped_placeholder: [],
    barcodes_conflict: [],
    costs_parsed_from_text: 0,
    costs_missing: 0,
    costs_invalid: [],
    pack_qty_text: [],
    locations_folded: [],
    supplier_spellings: [],
    odd_rows: [],
    extra_cells: [],
    counts_seeded: [],
    counts_skipped: [],
    counts_left: [],
    archives_imported: 0,
    archives_skipped: 0,
    products_inserted: 0,
    products_updated: 0,
  }
  const folded = new Map()
  const products = []

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] || []
    const excelRow = index + 1
    const name = asText(cell(row, map, 'name'))
    const hasAny = row.some((value) => value != null && String(value).trim() !== '')
    if (!hasAny) continue
    report.rows_read += 1
    if (!name) {
      report.skipped_empty.push({ row: excelRow, reason: 'No item name' })
      continue
    }
    const rawLocation = cell(row, map, 'location')
    const room = canonicalRoom(rawLocation)
    const rawLocationText = rawLocation == null ? '' : String(rawLocation).trim()
    if (rawLocationText !== room) {
      const key = `${rawLocationText || '(blank)'}→${room}`
      folded.set(key, (folded.get(key) || 0) + 1)
    }
    const source = asText(cell(row, map, 'source'))
    const stockOriginal = cell(row, map, 'stock_unit')
    const stockUnit = asText(stockOriginal)
    const pack = parsePack(cell(row, map, 'pack_qty'))
    if (pack.pack_qty_note) report.pack_qty_text.push({ row: excelRow, name, text: pack.pack_qty_note, pack_qty: pack.pack_qty })
    const itemSize = asText(cell(row, map, 'item_size'))
    const uom = asText(cell(row, map, 'uom'))
    const cost = parseCost(cell(row, map, 'cost'))
    if (cost.invalid) report.costs_invalid.push({ row: excelRow, name, value: cost.invalid })
    else if (cost.fromText && cost.cost != null) report.costs_parsed_from_text += 1
    if (cost.cost == null) report.costs_missing += 1
    const codes = barcodeTokens(cell(row, map, 'barcode'))
    for (const dropped of codes.dropped) {
      report.barcodes_dropped_placeholder.push({ row: excelRow, name, value: dropped })
    }
    const noteParts = [asText(cell(row, map, 'note')), asText(cell(row, map, 'description'))].filter(Boolean)
    const note = noteParts.length ? noteParts.join(' — ') : null
    const lastMapped = Math.max(...Object.values(map))
    for (let extra = lastMapped + 1; extra < row.length; extra += 1) {
      if (row[extra] != null && String(row[extra]).trim() !== '') {
        report.extra_cells.push({ row: excelRow, name, text: String(row[extra]).trim() })
      }
    }
    if (typeof stockOriginal === 'number' || (stockUnit && /\d/.test(stockUnit))) {
      report.odd_rows.push({ row: excelRow, name, issue: `Stock unit is "${stockUnit}"` })
    }
    if (uom && !NORMAL_UOM.has(uom.toLowerCase())) {
      report.odd_rows.push({ row: excelRow, name, issue: `Unit of measure is "${uom}"` })
    }
    if (itemSize && /^(g|kg|ml|l|pcs|can)$/i.test(itemSize) && !uom) {
      report.odd_rows.push({ row: excelRow, name, issue: `Item size "${itemSize}" looks like a unit of measure` })
    }
    products.push({
      excel_row: excelRow,
      sheet_id: sheetId(cell(row, map, 'id')),
      sheet_fingerprint: asText(cell(row, map, 'fingerprint')),
      room,
      source,
      name,
      stock_unit: stockUnit,
      pack_qty: pack.pack_qty,
      pack_qty_note: pack.pack_qty_note,
      item_size: itemSize,
      uom,
      unit_cost_yen: cost.cost,
      note,
      barcodes: codes.tokens,
    })
  }

  if (!products.length) throw new HttpError(400, 'That file has no items. The catalog was not changed.')

  const idGroups = new Map()
  for (const product of products) {
    if (!product.sheet_id) {
      report.external_ids_blank += 1
      continue
    }
    if (!idGroups.has(product.sheet_id)) idGroups.set(product.sheet_id, [])
    idGroups.get(product.sheet_id).push(product)
  }
  for (const [id, group] of idGroups) {
    if (group.length > 1) {
      report.external_ids_dropped_duplicate.push({
        sheet_id: id,
        rows: group.map((product) => product.excel_row),
        names: group.map((product) => product.name),
      })
    }
  }

  assignFingerprints(products)
  report.external_ids_kept = products.filter((product) => product.external_id).length

  const barcodeOwners = new Map()
  for (const product of products) {
    for (const code of product.barcodes) {
      const key = code.toUpperCase()
      if (!barcodeOwners.has(key)) barcodeOwners.set(key, [])
      barcodeOwners.get(key).push(product)
    }
  }
  for (const [key, owners] of barcodeOwners) {
    const names = new Set(owners.map((product) => product.name.toLowerCase()))
    const distinctProducts = owners
    if (distinctProducts.length > 1 || names.size > 1) {
      const code = owners[0].barcodes.find((value) => value.toUpperCase() === key) || key
      report.barcodes_conflict.push({
        code,
        names: [...new Set(owners.map((product) => product.name))],
        rows: owners.map((product) => product.excel_row),
      })
      for (const product of owners) {
        product.barcodes = product.barcodes.filter((value) => value.toUpperCase() !== key)
      }
    }
  }
  report.barcodes_attached = products.reduce((sum, product) => sum + product.barcodes.length, 0)
  report.locations_folded = [...folded.entries()].map(([key, count]) => {
    const [from, to] = key.split('→')
    return { from, to, count }
  })

  const spelling = new Map()
  for (const product of products) {
    if (!product.source) continue
    const key = product.source.toLowerCase()
    if (!spelling.has(key)) spelling.set(key, new Set())
    spelling.get(key).add(product.source)
  }
  report.supplier_spellings = [...spelling.values()]
    .filter((set) => set.size > 1)
    .map((set) => [...set])

  const counts = []
  if (tables.counts.length) {
    const countHeader = findCountHeader(tables.counts)
    if (countHeader >= 0) {
      const headers = tables.counts[countHeader].map(normHeader)
      const idAt = headers.indexOf('product_id')
      const qtyAt = headers.indexOf('qty')
      const atAt = headers.indexOf('updated_at')
      const deviceAt = headers.indexOf('device')
      for (let index = countHeader + 1; index < tables.counts.length; index += 1) {
        const row = tables.counts[index] || []
        if (row.every((value) => value == null || String(value).trim() === '')) continue
        const id = sheetId(row[idAt])
        const qty = typeof row[qtyAt] === 'number' ? row[qtyAt] : Number(String(row[qtyAt] ?? '').trim())
        if (!id || !Number.isFinite(qty)) {
          report.counts_skipped.push({ row: index + 1, reason: 'Quantity or product id was blank' })
          continue
        }
        counts.push({
          product_id: id,
          qty,
          updated_at: asText(row[atAt]) || new Date().toISOString(),
          device_id: asText(row[deviceAt]),
        })
      }
    }
  }

  const archives = []
  if (tables.archives.length) {
    const archiveHeader = tables.archives.findIndex((row) => (row || []).map(normHeader).includes('json'))
    if (archiveHeader >= 0) {
      const headers = tables.archives[archiveHeader].map(normHeader)
      const col = (name) => headers.indexOf(name)
      for (let index = archiveHeader + 1; index < tables.archives.length; index += 1) {
        const row = tables.archives[index] || []
        const id = asText(row[col('id')])
        const snapshot = row[col('json')]
        if (!id || snapshot == null || String(snapshot).trim() === '') continue
        const total = Number(row[col('total_value')])
        const counted = Number(row[col('counted_n')])
        const totalN = Number(row[col('total_n')])
        archives.push({
          id,
          label: asText(row[col('label')]) || 'Imported archive',
          closed_at: asText(row[col('date_iso')]) || new Date().toISOString(),
          total_value: Number.isFinite(total) ? Math.round(total) : 0,
          counted_n: Number.isFinite(counted) ? counted : 0,
          product_n: Number.isFinite(totalN) ? totalN : 0,
          snapshot_json: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
        })
      }
    }
  }

  return { products, counts, archives, report }
}

function findCountHeader(rows) {
  return rows.findIndex((row) => (row || []).map(normHeader).includes('product_id'))
}

function roomSort(name) {
  const index = ROOM_ORDER.indexOf(name)
  return index === -1 ? 100 : index
}

async function upsertRoom(db, name, cache) {
  if (cache.has(name)) return cache.get(name)
  const existing = await one(db, 'SELECT id FROM rooms WHERE lower(name) = lower(?)', [name])
  if (existing) {
    cache.set(name, existing.id)
    return existing.id
  }
  const info = await run(db, 'INSERT INTO rooms (name, sort_order, active) VALUES (?, ?, 1) RETURNING id', [name, roomSort(name)])
  cache.set(name, info.id)
  return info.id
}

async function loadRoomCache(db) {
  const cache = new Map()
  for (const room of await many(db, 'SELECT id, name FROM rooms')) cache.set(room.name, room.id)
  return cache
}

export async function importCatalog(db, { buffer, filename, mode = 'merge', confirm, abandon = false }) {
  if (mode !== 'merge' && mode !== 'replace') throw new HttpError(400, 'Import mode must be merge or replace.')
  if (mode === 'replace' && confirm !== 'REPLACE') {
    throw new HttpError(400, 'Type REPLACE to replace the catalog.')
  }
  const parsed = parseCatalog(buffer, filename)
  const now = new Date().toISOString()

  return withTransaction(db, async (tx) => {
    const openCounts = Number((await one(tx, 'SELECT COUNT(*) AS n FROM counts')).n)
    if (mode === 'replace' && openCounts > 0 && !abandon) {
      throw new HttpError(409, 'A count is in progress. Abandon the count before replacing the catalog.')
    }
    if (mode === 'replace') {
      await run(tx, 'DELETE FROM counts')
      await run(tx, 'DELETE FROM barcodes')
      await run(tx, 'DELETE FROM products')
    }

    const rooms = await loadRoomCache(tx)
    const report = parsed.report
    for (const product of parsed.products) {
      const roomId = await upsertRoom(tx, product.room, rooms)
      const match = mode === 'merge' ? await findMatch(tx, product) : null
      let productId
      if (match) {
        productId = match.id
        const cost = product.unit_cost_yen == null ? match.unit_cost_yen : product.unit_cost_yen
        await run(tx, `
          UPDATE products SET
            external_id = ?,
            import_fingerprint = ?,
            room_id = ?,
            source = ?,
            name = ?,
            stock_unit = ?,
            pack_qty = ?,
            pack_qty_note = ?,
            item_size = ?,
            uom = ?,
            unit_cost_yen = ?,
            note = ?,
            active = 1,
            updated_at = ?
          WHERE id = ?
        `, [
          product.external_id,
          product.fingerprint,
          roomId,
          product.source,
          product.name,
          product.stock_unit,
          product.pack_qty,
          product.pack_qty_note,
          product.item_size,
          product.uom,
          cost,
          product.note,
          now,
          productId,
        ])
        report.products_updated += 1
      } else {
        const info = await run(tx, `
          INSERT INTO products (
            external_id, import_fingerprint, room_id, source, name, stock_unit,
            pack_qty, pack_qty_note, item_size, uom, unit_cost_yen, unit_price_yen,
            note, active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
          RETURNING id
        `, [
          product.external_id,
          product.fingerprint,
          roomId,
          product.source,
          product.name,
          product.stock_unit,
          product.pack_qty,
          product.pack_qty_note,
          product.item_size,
          product.uom,
          product.unit_cost_yen,
          product.note,
          now,
          now,
        ])
        productId = info.id
        report.products_inserted += 1
      }
      for (const code of product.barcodes) {
        const owner = await one(tx, 'SELECT product_id FROM barcodes WHERE lower(code) = lower(?)', [code])
        if (owner && owner.product_id === productId) continue
        if (owner && owner.product_id !== productId) {
          report.barcodes_conflict.push({ code, names: [product.name], rows: [product.excel_row], during: 'merge' })
          continue
        }
        await run(tx, 'INSERT INTO barcodes (code, product_id) VALUES (?, ?)', [code, productId])
      }
    }

    for (const count of parsed.counts) {
      const product = await one(tx, 'SELECT id, name, room_id FROM products WHERE external_id = ?', [count.product_id])
      if (!product) {
        report.counts_skipped.push({ product_id: count.product_id, reason: 'No single item uses this sheet id' })
        continue
      }
      const existing = await one(tx, 'SELECT product_id FROM counts WHERE product_id = ?', [product.id])
      if (existing) {
        report.counts_left.push({ name: product.name, product_id: count.product_id })
        continue
      }
      await run(tx, `
        INSERT INTO counts (product_id, counted_room_id, qty, is_exception, updated_at, device_id)
        VALUES (?, ?, ?, 0, ?, ?)
      `, [product.id, product.room_id, count.qty, count.updated_at, count.device_id])
      report.counts_seeded.push({ name: product.name, external_id: count.product_id, qty: count.qty })
    }

    for (const archive of parsed.archives) {
      const existing = await one(tx, 'SELECT id FROM archives WHERE id = ?', [archive.id])
      if (existing) {
        report.archives_skipped += 1
        continue
      }
      await run(tx, `
        INSERT INTO archives (id, label, closed_at, total_value, counted_n, product_n, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [archive.id, archive.label, archive.closed_at, archive.total_value, archive.counted_n, archive.product_n, archive.snapshot_json])
      report.archives_imported += 1
    }

    report.mode = mode
    report.created_at = now
    report.product_count = Number((await one(tx, 'SELECT COUNT(*) AS n FROM products')).n)
    report.barcode_count = Number((await one(tx, 'SELECT COUNT(*) AS n FROM barcodes')).n)
    report.room_count = Number((await one(tx, 'SELECT COUNT(*) AS n FROM rooms')).n)
    await run(tx, 'INSERT INTO import_reports (created_at, mode, filename, report_json) VALUES (?, ?, ?, ?)', [
      now,
      mode,
      filename || null,
      JSON.stringify(report),
    ])
    return report
  })
}

async function findMatch(db, product) {
  if (product.external_id) {
    const byExternal = await one(db, 'SELECT * FROM products WHERE external_id = ?', [product.external_id])
    if (byExternal) return byExternal
  }
  if (product.fingerprint) {
    const byFingerprint = await one(db, 'SELECT * FROM products WHERE import_fingerprint = ?', [product.fingerprint])
    if (byFingerprint) return byFingerprint
  }
  for (const code of product.barcodes) {
    const row = await one(db, `
      SELECT p.* FROM barcodes b
      JOIN products p ON p.id = b.product_id
      WHERE lower(b.code) = lower(?)
    `, [code])
    if (row) return row
  }
  return null
}

export function isPlaceholderBarcode(value) {
  return PLACEHOLDER.test(String(value ?? '').trim())
}
