import { DatabaseSync } from 'node:sqlite'
import postgres from 'postgres'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('Set SUPABASE_DB_URL to the Supabase session-pooler connection string, then run this again.')
  process.exit(1)
}

const sqlitePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'stocktake.sqlite')
const db = new DatabaseSync(sqlitePath, { readOnly: true })
const sql = postgres(url, { ssl: 'require', max: 1, prepare: false })

const rooms = db.prepare('SELECT * FROM rooms ORDER BY id').all()
const products = db.prepare('SELECT * FROM products ORDER BY id').all()
const barcodes = db.prepare('SELECT * FROM barcodes').all()
const counts = db.prepare('SELECT * FROM counts').all()
const archives = db.prepare('SELECT * FROM archives').all()
const settings = db.prepare('SELECT * FROM settings').all()

await sql.begin(async (tx) => {
  await tx`delete from counts`
  await tx`delete from barcodes`
  await tx`delete from products`
  await tx`delete from rooms`
  await tx`delete from archives`
  await tx`delete from import_reports`
  for (const room of rooms) {
    await tx`
      insert into rooms (id, name, sort_order, active)
      values (${room.id}, ${room.name}, ${room.sort_order}, ${room.active})
    `
  }
  for (const product of products) {
    await tx`
      insert into products (
        id, external_id, import_fingerprint, room_id, source, name, stock_unit,
        pack_qty, pack_qty_note, item_size, uom, unit_cost_yen, unit_price_yen,
        note, active, created_at, updated_at
      ) values (
        ${product.id}, ${product.external_id}, ${product.import_fingerprint}, ${product.room_id},
        ${product.source}, ${product.name}, ${product.stock_unit}, ${product.pack_qty},
        ${product.pack_qty_note}, ${product.item_size}, ${product.uom}, ${product.unit_cost_yen},
        ${product.unit_price_yen}, ${product.note}, ${product.active}, ${product.created_at}, ${product.updated_at}
      )
    `
  }
  for (const barcode of barcodes) {
    await tx`insert into barcodes (code, product_id) values (${barcode.code}, ${barcode.product_id})`
  }
  for (const count of counts) {
    await tx`
      insert into counts (product_id, counted_room_id, qty, is_exception, updated_at, device_id)
      values (${count.product_id}, ${count.counted_room_id}, ${count.qty}, ${count.is_exception}, ${count.updated_at}, ${count.device_id})
    `
  }
  for (const archive of archives) {
    await tx`
      insert into archives (id, label, closed_at, total_value, counted_n, product_n, snapshot_json)
      values (${archive.id}, ${archive.label}, ${archive.closed_at}, ${archive.total_value}, ${archive.counted_n}, ${archive.product_n}, ${archive.snapshot_json})
    `
  }
  for (const setting of settings) {
    await tx`
      insert into settings (key, value) values (${setting.key}, ${setting.value})
      on conflict (key) do update set value = excluded.value
    `
  }
  await tx`select setval(pg_get_serial_sequence('rooms', 'id'), (select coalesce(max(id), 1) from rooms))`
  await tx`select setval(pg_get_serial_sequence('products', 'id'), (select coalesce(max(id), 1) from products))`
})

console.log(`Copied ${products.length} items, ${barcodes.length} barcodes, ${rooms.length} rooms.`)
await sql.end()
db.close()
