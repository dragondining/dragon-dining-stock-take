// Shared by the server and the browser. No Node-only APIs.

export function lineValue(qty, unitCostYen) {
  if (qty == null || unitCostYen == null) return null
  const qtyN = Number(qty)
  const costN = Number(unitCostYen)
  if (!Number.isFinite(qtyN) || !Number.isFinite(costN)) return null
  return Math.round(qtyN * costN)
}

export function formatYen(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  const n = Math.round(Number(value))
  const sign = n < 0 ? '-' : ''
  return `${sign}¥${Math.abs(n).toLocaleString('en-US')}`
}

export function formatQty(qty) {
  if (qty == null) return ''
  const n = Math.round(Number(qty) * 1000) / 1000
  if (Object.is(n, -0)) return '0'
  return String(n)
}

export function nextQty(current, delta) {
  const base = current == null ? 0 : Number(current)
  const n = Math.round((base + Number(delta)) * 1000) / 1000
  return n < 0 ? 0 : n
}

export function tallyQty(current) {
  if (current == null) return 1
  return nextQty(current, 1)
}

export function findProductByBarcode(products, code) {
  const want = String(code ?? '').trim().toUpperCase()
  if (!want) return null
  return products.find((p) => (p.barcodes || []).some((b) => String(b).trim().toUpperCase() === want)) || null
}

export function classifyScan(products, roomId, code) {
  const product = findProductByBarcode(products, code)
  if (!product) return { status: 'unknown', code: String(code ?? '').trim() }
  if (!product.active) return { status: 'hidden', product }
  if (Number(product.room_id) !== Number(roomId)) return { status: 'wrong_room', product }
  return { status: 'known', product }
}

export function enqueueCount(queue, item) {
  const rest = (queue || []).filter((entry) => !(entry.type === 'count' && entry.product_id === item.product_id))
  return [...rest, { ...item, type: 'count' }]
}

export function viewCounts(counts, pending) {
  const map = new Map((counts || []).map((count) => [count.product_id, { ...count }]))
  for (const item of pending || []) {
    if (item.type !== 'count') continue
    if (item.qty == null) map.delete(item.product_id)
    else map.set(item.product_id, { ...item })
  }
  return [...map.values()]
}

export function syncLabel(pendingCount) {
  if (pendingCount > 0) return 'Waiting to sync'
  return 'All counts saved'
}

export function defaultLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(date)
}

export function roomStats(rooms, products, counts) {
  const countMap = new Map((counts || []).map((count) => [count.product_id, count]))
  return (rooms || [])
    .filter((room) => room.active)
    .map((room) => {
      const items = (products || []).filter((product) => product.active && product.room_id === room.id)
      let counted = 0
      let value = 0
      let anyValue = false
      for (const product of items) {
        const count = countMap.get(product.id)
        if (!count) continue
        counted += 1
        const line = lineValue(count.qty, product.unit_cost_yen)
        if (line != null) {
          value += line
          anyValue = true
        }
      }
      return {
        id: room.id,
        name: room.name,
        sort_order: room.sort_order,
        counted,
        total: items.length,
        value: anyValue ? value : (counted ? 0 : null),
      }
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
}

export function countMap(counts) {
  return new Map((counts || []).map((count) => [count.product_id, count]))
}
