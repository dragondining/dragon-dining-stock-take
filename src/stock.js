import { randomUUID } from 'node:crypto'
import { getSetting, setSetting, withTransaction } from './db.js'
import { many, one, run } from './query.js'
import { hashPin, pinLooksValid, verifyPin } from './auth.js'
import { isPlaceholderBarcode } from './catalog.js'
import { csvFromSnapshot, filenameForLabel, catalogCsv } from './csv.js'
import { defaultLabel, lineValue } from '../shared/logic.js'
import { HttpError } from './errors.js'

function bool(value) {
  return value === true || value === 1
}

function productShape(row, barcodes) {
  return {
    id: row.id,
    external_id: row.external_id,
    import_fingerprint: row.import_fingerprint,
    room_id: row.room_id,
    source: row.source,
    name: row.name,
    stock_unit: row.stock_unit,
    pack_qty: row.pack_qty,
    pack_qty_note: row.pack_qty_note,
    item_size: row.item_size,
    uom: row.uom,
    unit_cost_yen: row.unit_cost_yen == null ? null : Number(row.unit_cost_yen),
    unit_price_yen: row.unit_price_yen == null ? null : Number(row.unit_price_yen),
    note: row.note,
    active: bool(row.active),
    barcodes: barcodes.get(row.id) || [],
  }
}

export async function getState(db) {
  const rooms = (await many(db, 'SELECT id, name, sort_order, active FROM rooms ORDER BY sort_order, lower(name)')).map((room) => ({ ...room, active: bool(room.active) }))
  const barcodeRows = await many(db, 'SELECT code, product_id FROM barcodes ORDER BY code')
  const barcodes = new Map()
  for (const row of barcodeRows) {
    if (!barcodes.has(row.product_id)) barcodes.set(row.product_id, [])
    barcodes.get(row.product_id).push(row.code)
  }
  const products = (await many(db, 'SELECT * FROM products ORDER BY lower(name), id')).map((row) => productShape(row, barcodes))
  const counts = (await many(db, `
    SELECT product_id, counted_room_id, qty, is_exception, updated_at, device_id
    FROM counts
  `)).map((count) => ({ ...count, is_exception: bool(count.is_exception), qty: Number(count.qty) }))
  return { rooms, products, counts, server_time: new Date().toISOString() }
}

function yenOrNull(value, label) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const cleaned = String(value).trim().replace(/[¥￥,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new HttpError(400, `${label} must be a whole number of yen.`)
  return Math.round(Number(cleaned))
}

function cleanCode(code) {
  const text = String(code ?? '').trim()
  if (!text || isPlaceholderBarcode(text)) throw new HttpError(400, 'That is not a barcode.')
  return text
}

export async function addBarcode(db, code, productId) {
  const clean = cleanCode(code)
  const product = await one(db, 'SELECT id, active FROM products WHERE id = ?', [productId])
  if (!product || !product.active) throw new HttpError(404, 'That item is not in the catalog.')
  const owner = await one(db, 'SELECT product_id FROM barcodes WHERE lower(code) = lower(?)', [clean])
  if (owner && owner.product_id !== product.id) throw new HttpError(409, 'That barcode is already on another item.')
  if (!owner) await run(db, 'INSERT INTO barcodes (code, product_id) VALUES (?, ?)', [clean, product.id])
  return getProduct(db, product.id)
}

export async function removeBarcode(db, code) {
  const clean = String(code ?? '').trim()
  const info = await run(db, 'DELETE FROM barcodes WHERE lower(code) = lower(?)', [clean])
  if (!info.changes) throw new HttpError(404, 'That barcode is not on an item.')
}

export async function getProduct(db, id) {
  const row = await one(db, 'SELECT * FROM products WHERE id = ?', [id])
  if (!row) throw new HttpError(404, 'That item is not in the catalog.')
  const codes = (await many(db, 'SELECT code FROM barcodes WHERE product_id = ? ORDER BY code', [row.id])).map((barcode) => barcode.code)
  return productShape(row, new Map([[row.id, codes]]))
}

export async function createProduct(db, input) {
  const name = String(input.name ?? '').trim()
  if (!name) throw new HttpError(400, 'An item needs a name.')
  const room = await one(db, 'SELECT id FROM rooms WHERE id = ? AND active = 1', [Number(input.room_id)])
  if (!room) throw new HttpError(400, 'Choose a room for this item.')
  return withTransaction(db, (tx) => insertProduct(tx, input, name, room.id))
}

async function insertProduct(db, input, name, roomId) {
  const now = new Date().toISOString()
  const info = await run(db, `
    INSERT INTO products (
      external_id, import_fingerprint, room_id, source, name, stock_unit,
      pack_qty, pack_qty_note, item_size, uom, unit_cost_yen, unit_price_yen,
      note, active, created_at, updated_at
    ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    RETURNING id
  `, [
    roomId,
    textOrNull(input.source),
    name,
    textOrNull(input.stock_unit),
    numberOrNull(input.pack_qty),
    textOrNull(input.pack_qty_note),
    textOrNull(input.item_size),
    textOrNull(input.uom),
    yenOrNull(input.unit_cost_yen, 'Cost'),
    yenOrNull(input.unit_price_yen, 'Price'),
    textOrNull(input.note),
    now,
    now,
  ])
  const id = info.id
  if (input.barcode) await addBarcode(db, input.barcode, id)
  return getProduct(db, id)
}

export async function updateProduct(db, id, input) {
  const current = await one(db, 'SELECT * FROM products WHERE id = ?', [id])
  if (!current) throw new HttpError(404, 'That item is not in the catalog.')
  const name = input.name == null ? current.name : String(input.name).trim()
  if (!name) throw new HttpError(400, 'An item needs a name.')
  let roomId = current.room_id
  if (input.room_id != null) {
    const room = await one(db, 'SELECT id FROM rooms WHERE id = ?', [Number(input.room_id)])
    if (!room) throw new HttpError(400, 'Choose a room for this item.')
    roomId = room.id
  }
  const active = input.active == null ? current.active : (input.active ? 1 : 0)
  await run(db, `
    UPDATE products SET
      room_id = ?,
      source = ?,
      name = ?,
      stock_unit = ?,
      pack_qty = ?,
      pack_qty_note = ?,
      item_size = ?,
      uom = ?,
      unit_cost_yen = ?,
      unit_price_yen = ?,
      note = ?,
      active = ?,
      updated_at = ?
    WHERE id = ?
  `, [
    roomId,
    input.source === undefined ? current.source : textOrNull(input.source),
    name,
    input.stock_unit === undefined ? current.stock_unit : textOrNull(input.stock_unit),
    input.pack_qty === undefined ? current.pack_qty : numberOrNull(input.pack_qty),
    input.pack_qty_note === undefined ? current.pack_qty_note : textOrNull(input.pack_qty_note),
    input.item_size === undefined ? current.item_size : textOrNull(input.item_size),
    input.uom === undefined ? current.uom : textOrNull(input.uom),
    input.unit_cost_yen === undefined ? current.unit_cost_yen : yenOrNull(input.unit_cost_yen, 'Cost'),
    input.unit_price_yen === undefined ? current.unit_price_yen : yenOrNull(input.unit_price_yen, 'Price'),
    input.note === undefined ? current.note : textOrNull(input.note),
    active,
    new Date().toISOString(),
    id,
  ])
  return getProduct(db, id)
}

function textOrNull(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new HttpError(400, 'Pack quantity must be a number.')
  return number
}

export async function createRoom(db, input) {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw new HttpError(400, 'A room needs a name.')
  const existing = await one(db, 'SELECT id FROM rooms WHERE lower(name) = lower(?)', [name])
  if (existing) throw new HttpError(409, 'A room with that name already exists.')
  const max = await one(db, 'SELECT COALESCE(MAX(sort_order), 0) AS n FROM rooms')
  const info = await run(db, 'INSERT INTO rooms (name, sort_order, active) VALUES (?, ?, 1) RETURNING id', [name, Number(max.n) + 1])
  return one(db, 'SELECT id, name, sort_order, active FROM rooms WHERE id = ?', [info.id])
}

export async function updateRoom(db, id, input) {
  const room = await one(db, 'SELECT * FROM rooms WHERE id = ?', [id])
  if (!room) throw new HttpError(404, 'That room does not exist.')
  let name = room.name
  if (input.name != null) {
    name = String(input.name).trim().replace(/\s+/g, ' ')
    if (!name) throw new HttpError(400, 'A room needs a name.')
    const other = await one(db, 'SELECT id FROM rooms WHERE lower(name) = lower(?) AND id <> ?', [name, id])
    if (other) throw new HttpError(409, 'A room with that name already exists.')
  }
  let active = room.active
  if (input.active != null) {
    active = input.active ? 1 : 0
    if (!active) {
      const items = (await one(db, 'SELECT COUNT(*) AS n FROM products WHERE room_id = ? AND active = 1', [id])).n
      if (Number(items) > 0) throw new HttpError(400, 'Move the items to another room first.')
    }
  }
  await run(db, 'UPDATE rooms SET name = ?, active = ? WHERE id = ?', [name, active, id])
  return one(db, 'SELECT id, name, sort_order, active FROM rooms WHERE id = ?', [id])
}

export async function applyCounts(db, counts) {
  if (!Array.isArray(counts) || !counts.length) throw new HttpError(400, 'No counts to save.')
  return withTransaction(db, async (tx) => {
    const results = []
    for (const count of counts) results.push(await applyOne(tx, count))
    return results
  })
}

async function applyOne(db, count) {
  const productId = Number(count.product_id)
  const product = await one(db, 'SELECT id, room_id, active FROM products WHERE id = ?', [productId])
  if (!product) return { product_id: productId, status: 'missing' }
  if (!count.updated_at) throw new HttpError(400, 'A count needs a time.')
  const existing = await one(db, 'SELECT * FROM counts WHERE product_id = ?', [product.id])
  if (existing && existing.updated_at > count.updated_at) {
    return { product_id: product.id, status: 'stale', count: shapeCount(existing) }
  }
  if (count.qty == null) {
    await run(db, 'DELETE FROM counts WHERE product_id = ?', [product.id])
    return { product_id: product.id, status: 'cleared', count: null }
  }
  const qty = Number(count.qty)
  if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, 'Quantity cannot be negative.')
  const countedRoom = Number(count.counted_room_id) || product.room_id
  const room = await one(db, 'SELECT id FROM rooms WHERE id = ?', [countedRoom])
  if (!room) throw new HttpError(400, 'That room does not exist.')
  const exception = count.is_exception ? 1 : 0
  await run(db, `
    INSERT INTO counts (product_id, counted_room_id, qty, is_exception, updated_at, device_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      counted_room_id = excluded.counted_room_id,
      qty = excluded.qty,
      is_exception = excluded.is_exception,
      updated_at = excluded.updated_at,
      device_id = excluded.device_id
  `, [product.id, room.id, qty, exception, count.updated_at, count.device_id || null])
  const saved = await one(db, 'SELECT * FROM counts WHERE product_id = ?', [product.id])
  return { product_id: product.id, status: 'saved', count: shapeCount(saved) }
}

function shapeCount(count) {
  return { ...count, is_exception: bool(count.is_exception) }
}

export async function abandonCounts(db) {
  await run(db, 'DELETE FROM counts')
}

export async function finishStockTake(db, label) {
  const cleanLabel = String(label ?? '').trim() || defaultLabel()
  return withTransaction(db, async (tx) => {
    const state = await getState(tx)
    const counts = new Map(state.counts.map((count) => [count.product_id, count]))
    const rooms = new Map(state.rooms.map((room) => [room.id, room.name]))
    let total = 0
    let countedN = 0
    const products = state.products.filter((product) => product.active).map((product) => {
      const count = counts.get(product.id)
      const counted = Boolean(count)
      const qty = counted ? count.qty : null
      const line = counted ? lineValue(qty, product.unit_cost_yen) : null
      if (counted) {
        countedN += 1
        if (line != null) total += line
      }
      return {
        product_id: product.id,
        room: rooms.get(product.room_id) || '',
        counted_room: counted ? (rooms.get(count.counted_room_id) || '') : '',
        source: product.source,
        name: product.name,
        stock_unit: product.stock_unit,
        pack_qty: product.pack_qty,
        pack_qty_note: product.pack_qty_note,
        item_size: product.item_size,
        uom: product.uom,
        qty,
        unit_cost_yen: product.unit_cost_yen,
        unit_price_yen: product.unit_price_yen,
        line_value: line,
        barcodes: (product.barcodes || []).join('; '),
        note: product.note,
        is_exception: counted ? Boolean(count.is_exception) : false,
        counted,
      }
    })
    const closedAt = new Date().toISOString()
    const snapshot = {
      version: 1,
      label: cleanLabel,
      closed_at: closedAt,
      total_value: total,
      counted_n: countedN,
      product_n: products.length,
      products,
    }
    const id = randomUUID()
    await run(tx, `
      INSERT INTO archives (id, label, closed_at, total_value, counted_n, product_n, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, cleanLabel, closedAt, total, countedN, products.length, JSON.stringify(snapshot)])
    await run(tx, 'DELETE FROM counts')
    return {
      archive: {
        id,
        label: cleanLabel,
        closed_at: closedAt,
        total_value: total,
        counted_n: countedN,
        product_n: products.length,
      },
      csv: csvFromSnapshot(snapshot),
      filename: filenameForLabel(cleanLabel),
    }
  })
}

export async function listArchives(db) {
  return many(db, `
    SELECT id, label, closed_at, total_value, counted_n, product_n
    FROM archives
    ORDER BY closed_at DESC
  `)
}

export async function archiveRecord(db, id) {
  const row = await one(db, 'SELECT * FROM archives WHERE id = ?', [id])
  if (!row) throw new HttpError(404, 'That archive does not exist.')
  return row
}

export async function latestReport(db) {
  const row = await one(db, 'SELECT id, created_at, mode, filename, report_json FROM import_reports ORDER BY id DESC LIMIT 1')
  if (!row) return null
  return { id: row.id, created_at: row.created_at, mode: row.mode, filename: row.filename, report: JSON.parse(row.report_json) }
}

export async function exportCatalogCsv(db) {
  const state = await getState(db)
  const rooms = new Map(state.rooms.map((room) => [room.id, room.name]))
  return catalogCsv(state.products, rooms)
}

export async function changePin(db, currentPin, nextPin) {
  const salt = await getSetting(db, 'pin_salt')
  const hash = await getSetting(db, 'pin_hash')
  if (!verifyPin(String(currentPin ?? '').trim(), salt, hash)) throw new HttpError(401, 'That PIN is not right.')
  const next = String(nextPin ?? '').trim()
  if (!pinLooksValid(next)) throw new HttpError(400, 'The new PIN must be 4 to 8 digits.')
  await setSetting(db, 'pin_hash', hashPin(next, salt))
}
