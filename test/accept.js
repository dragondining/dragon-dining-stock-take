import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { barcodeTokens, parseCost, parsePack } from '../src/catalog.js'
import { startServer, starterCatalogPath } from '../server.js'
import { classifyScan, enqueueCount, lineValue, syncLabel, tallyQty, viewCounts } from '../shared/logic.js'

const catalogPath = starterCatalogPath()
const catalog = fs.readFileSync(catalogPath)

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-dining-'))
  return { dir, dbPath: path.join(dir, 'test.sqlite') }
}

async function postJson(url, body, token) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await response.json()
  return { status: response.status, data }
}

test('cleanup rules', () => {
  assert.deepEqual(parseCost('¥1,309'), { cost: 1309, fromText: true })
  assert.deepEqual(parseCost(500), { cost: 500, fromText: false })
  assert.equal(parseCost('').cost, null)
  assert.deepEqual(parsePack('20 in case'), { pack_qty: 20, pack_qty_note: '20 in case' })
  assert.deepEqual(parsePack('1.8l'), { pack_qty: 1.8, pack_qty_note: '1.8l' })
  assert.deepEqual(parsePack(1), { pack_qty: 1, pack_qty_note: null })
  assert.deepEqual(barcodeTokens(4937025000257.0).tokens, ['4937025000257'])
  assert.deepEqual(barcodeTokens('No Barcode').dropped, ['No Barcode'])
  assert.deepEqual(barcodeTokens('AAAA').tokens, [])
  assert.deepEqual(barcodeTokens('217826178; 4901305405582').tokens, ['217826178', '4901305405582'])
  assert.equal(barcodeTokens('01317903').tokens[0], '01317903')
  assert.equal(lineValue(2, 500), 1000)
  assert.equal(lineValue(0, 500), 0)
  assert.equal(lineValue(4, null), null)
  assert.equal(lineValue(1.5, 10), 15)
  assert.equal(tallyQty(null), 1)
  assert.equal(tallyQty(1), 2)
  const queued = enqueueCount([], { product_id: 5, qty: 2, updated_at: 't' })
  assert.equal(syncLabel(queued.length), 'Waiting to sync')
  assert.equal(viewCounts([], queued)[0].qty, 2)
  assert.equal(syncLabel(0), 'All counts saved')
})

test('stock take acceptance', async () => {
  const { dir, dbPath } = tempDb()
  const app = await startServer({ port: 0, host: '127.0.0.1', dbPath, autoImport: false })
  try {
    const imported = await postJson(`${app.url}/api/import?mode=merge`, {}, null)
    assert.equal(imported.status, 401)

    const pin = await postJson(`${app.url}/api/pin/verify`, { pin: '1234' })
    assert.equal(pin.status, 200)
    const token = pin.data.token
    const bad = await postJson(`${app.url}/api/pin/verify`, { pin: '0000' })
    assert.equal(bad.status, 401)

    const fileHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-filename': 'Inventory_for_Grok_MVP.xlsx' }
    const first = await fetch(`${app.url}/api/import?mode=merge`, { method: 'POST', headers: fileHeaders, body: catalog })
    const firstBody = await first.json()
    assert.equal(first.status, 200, JSON.stringify(firstBody))
    const report = firstBody.report
    assert.equal(report.product_count, 498)
    assert.equal(report.products_inserted, 498)
    assert.equal(report.external_ids_kept, 339)
    assert.equal(report.external_ids_dropped_duplicate.length, 31)
    assert.equal(report.costs_missing, 86)
    assert.equal(report.barcodes_attached, 230)
    assert.equal(report.barcode_count, 230)
    assert.equal(report.counts_seeded.length, 1)
    assert.equal(report.counts_seeded[0].name, 'PG Tips')
    assert.equal(report.counts_seeded[0].qty, 3)
    assert.equal(report.archives_imported, 2)
    assert.ok(report.barcodes_conflict.some((row) => row.code === '4514603493016'))
    assert.equal(report.skipped_empty.length, 1)

    const stateRes = await fetch(`${app.url}/api/state`)
    const state = await stateRes.json()
    assert.deepEqual(
      state.rooms.map((room) => room.name).sort(),
      ['Cafe', 'Dry Storage', 'Kitchen', 'Outside Chemical Shed', 'Outside Dry Stock Shed', 'Shop', 'Unassigned', 'Walk-in Freezer', 'Walk-in Fridge'].sort(),
    )
    assert.equal(state.products.length, 498)
    assert.equal(state.products.filter((product) => product.name === 'Garam Masala').length, 4)
    assert.equal(state.products.filter((product) => product.name === 'Coconut Thread').length, 3)
    assert.ok(state.products.some((product) => product.name === 'Popcorn'))
    assert.ok(state.products.some((product) => product.name === 'Tuna Chunks'))
    assert.equal(state.products.filter((product) => product.unit_cost_yen == null).length, 86)
    const tips = state.products.find((product) => product.name === 'PG Tips')
    const cafe = state.rooms.find((room) => room.name === 'Cafe')
    const shop = state.rooms.find((room) => room.name === 'Shop')
    const unassigned = state.rooms.find((room) => room.name === 'Unassigned')
    assert.equal(tips.room_id, cafe.id)
    assert.equal(tips.unit_cost_yen, 500)
    assert.equal(tips.unit_price_yen, null)
    const tipsCount = state.counts.find((count) => count.product_id === tips.id)
    assert.equal(tipsCount.qty, 3)
    assert.equal(tipsCount.device_id, 'd089b1')
    const flakes = state.products.find((product) => product.barcodes.includes('4937025000257'))
    assert.equal(flakes.name, 'Red Pepper Flakes')
    assert.equal(state.products.some((product) => product.barcodes.includes('4514603493016')), false)
    assert.ok(state.products.some((product) => product.barcodes.includes('01317903')))
    assert.ok(state.products.some((product) => product.barcodes.includes('000000085243')))
    assert.ok(state.products.some((product) => product.barcodes.includes('X000PG7RN7')))
    const seeds = state.products.find((product) => product.barcodes.includes('X000PG7RN7'))
    assert.equal(classifyScan(state.products, shop.id, 'X000PG7RN7').status, 'wrong_room')
    assert.equal(classifyScan(state.products, seeds.room_id, 'x000pg7rn7').status, 'known')
    assert.equal(classifyScan(state.products, shop.id, 'AAAA').status, 'unknown')
    assert.equal(classifyScan(state.products, shop.id, 'No Barcode').status, 'unknown')
    const syrup = state.products.find((product) => product.name.includes('Vegetable and Fruit Mix'))
    assert.equal(syrup.room_id, unassigned.id)

    const second = await fetch(`${app.url}/api/import?mode=merge`, { method: 'POST', headers: fileHeaders, body: catalog })
    const secondBody = await second.json()
    assert.equal(second.status, 200, JSON.stringify(secondBody.error || ''))
    assert.equal(secondBody.report.product_count, 498)
    assert.equal(secondBody.report.products_inserted, 0)
    assert.equal(secondBody.report.products_updated, 498)
    assert.equal(secondBody.report.archives_imported, 0)

    const blocked = await fetch(`${app.url}/api/import?mode=replace&confirm=REPLACE`, { method: 'POST', headers: fileHeaders, body: catalog })
    assert.equal(blocked.status, 409)
    const untyped = await fetch(`${app.url}/api/import?mode=replace&confirm=replace`, { method: 'POST', headers: fileHeaders, body: catalog })
    assert.equal(untyped.status, 400)

    const abandoned = await postJson(`${app.url}/api/stocktake/abandon`, {}, token)
    assert.equal(abandoned.status, 200)
    const cleared = await (await fetch(`${app.url}/api/state`)).json()
    assert.equal(cleared.counts.length, 0)

    const noCost = cleared.products.find((product) => product.unit_cost_yen == null)
    const zeroItem = cleared.products.find((product) => product.unit_cost_yen != null && product.id !== tips.id)
    const now = new Date().toISOString()
    const saved = await postJson(`${app.url}/api/counts`, {
      counts: [
        { product_id: tips.id, counted_room_id: cafe.id, qty: 2, is_exception: 0, updated_at: now, device_id: 'test' },
        { product_id: noCost.id, counted_room_id: noCost.room_id, qty: 4, is_exception: 0, updated_at: now, device_id: 'test' },
        { product_id: zeroItem.id, counted_room_id: zeroItem.room_id, qty: 0, is_exception: 0, updated_at: now, device_id: 'test' },
      ],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    assert.ok(saved.data.results.every((row) => row.status === 'saved'))

    const noPin = await postJson(`${app.url}/api/stocktake/finish`, { label: 'September 2026' })
    assert.equal(noPin.status, 401)
    const finished = await postJson(`${app.url}/api/stocktake/finish`, { label: 'September 2026' }, token)
    assert.equal(finished.status, 200, JSON.stringify(finished.data))
    assert.equal(finished.data.archive.total_value, 1000)
    assert.equal(finished.data.archive.counted_n, 3)
    assert.equal(finished.data.archive.product_n, 498)
    assert.match(finished.data.csv, /PG Tips/)
    assert.match(finished.data.csv, /Cafe,Amazon,PG Tips,Box,1,20,pcs,2,500,1000,/)
    assert.match(finished.data.csv, /TOTAL/)
    const afterFinish = await (await fetch(`${app.url}/api/state`)).json()
    assert.equal(afterFinish.counts.length, 0)
    assert.equal(afterFinish.products.length, 498)

    const edited = await fetch(`${app.url}/api/products/${tips.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ unit_cost_yen: 1 }),
    })
    assert.equal(edited.status, 200)
    const archiveCsv = await fetch(`${app.url}/api/archives/${finished.data.archive.id}.csv`, { headers: { authorization: `Bearer ${token}` } })
    const frozen = await archiveCsv.text()
    assert.equal(archiveCsv.status, 200)
    assert.match(frozen, /Cafe,Amazon,PG Tips,Box,1,20,pcs,2,500,1000,/)
    const archives = await (await fetch(`${app.url}/api/archives`, { headers: { authorization: `Bearer ${token}` } })).json()
    assert.equal(archives.archives.length, 3)
    assert.equal(archives.archives.reduce((sum, row) => sum + (row.label === 'September 2026' ? row.total_value : 0), 0), 1000)

    const future = '2099-01-01T00:00:00.000Z'
    const past = '2000-01-01T00:00:00.000Z'
    await postJson(`${app.url}/api/counts`, { counts: [{ product_id: tips.id, counted_room_id: cafe.id, qty: 5, is_exception: 0, updated_at: future, device_id: 'test' }] })
    const stale = await postJson(`${app.url}/api/counts`, { counts: [{ product_id: tips.id, counted_room_id: cafe.id, qty: 1, is_exception: 0, updated_at: past, device_id: 'test' }] })
    assert.equal(stale.data.results[0].status, 'stale')
    const still = await (await fetch(`${app.url}/api/state`)).json()
    assert.equal(still.counts.find((count) => count.product_id === tips.id).qty, 5)

    const linked = await postJson(`${app.url}/api/barcodes`, { code: 'TEST-CODE-1', product_id: tips.id })
    assert.equal(linked.status, 200)
    assert.equal(classifyScan(linked.data.product ? [linked.data.product] : [], cafe.id, 'test-code-1').status, 'known')
    const created = await postJson(`${app.url}/api/products`, { name: 'Acceptance biscuit', room_id: cafe.id, unit_cost_yen: 120, barcode: 'BISCUIT1' }, token)
    assert.equal(created.status, 200)
    assert.equal(created.data.product.unit_price_yen, null)
    const denied = await postJson(`${app.url}/api/products`, { name: 'Nope', room_id: cafe.id })
    assert.equal(denied.status, 401)

    const replaced = await fetch(`${app.url}/api/import?mode=replace&confirm=REPLACE&abandon=1`, { method: 'POST', headers: fileHeaders, body: catalog })
    const replacedBody = await replaced.json()
    assert.equal(replaced.status, 200, JSON.stringify(replacedBody.error || replacedBody))
    assert.equal(replacedBody.report.product_count, 498)
    const finalState = await (await fetch(`${app.url}/api/state`)).json()
    assert.equal(finalState.products.some((product) => product.name === 'Acceptance biscuit'), false)
    assert.equal(finalState.counts.length, 1)
    assert.equal(finalState.counts[0].qty, 3)

    const page = await (await fetch(`${app.url}/`)).text()
    assert.match(page, /Dragon Dining Stock Take/)
    const client = await (await fetch(`${app.url}/app.js`)).text()
    assert.match(client, /Scan barcode/)
    assert.match(client, /Waiting to sync/)
    assert.match(client, /id="nav-home"|nav-home/)
    assert.match(client, /Save/)
    const css = await (await fetch(`${app.url}/styles.css`)).text()
    assert.match(css, /min-height: 56px/)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
