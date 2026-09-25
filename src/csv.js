function csvEscape(value) {
  if (value == null) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) lines.push(headers.map((_, index) => csvEscape(row[index])).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

const COUNT_HEADERS = [
  'room',
  'source',
  'name',
  'stock unit',
  'pack qty',
  'item size',
  'uom',
  'quantity',
  'unit cost',
  'line value',
  'barcodes',
  'note',
  'exception',
]

export function csvFromSnapshot(snapshot) {
  const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
  if (Array.isArray(data?.products)) {
    const counted = data.products.filter((product) => product.counted)
    const rows = counted.map((product) => [
      product.room,
      product.source,
      product.name,
      product.stock_unit,
      product.pack_qty_note || product.pack_qty,
      product.item_size,
      product.uom,
      product.qty,
      product.unit_cost_yen,
      product.line_value,
      product.barcodes,
      product.note,
      product.is_exception ? 'yes' : '',
    ])
    rows.push(['', '', 'TOTAL', '', '', '', '', '', '', data.total_value, '', '', ''])
    return toCsv(COUNT_HEADERS, rows)
  }
  const items = Array.isArray(data?.items) ? data.items : []
  const rows = items.map((item) => [
    item.loc,
    item.src,
    item.name,
    item.unit,
    '',
    '',
    '',
    item.qty,
    item.cost,
    item.value,
    item.barcode,
    item.note,
    '',
  ])
  rows.push(['', '', 'TOTAL', '', '', '', '', '', '', data.totalValue ?? data.total_value ?? '', '', '', ''])
  return toCsv(COUNT_HEADERS, rows)
}

export function filenameForLabel(label) {
  const slug = String(label || 'stock-take')
    .trim()
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '') || 'stock-take'
  return `Dragon-Dining-${slug}.csv`
}

const CATALOG_HEADERS = [
  'id',
  'location',
  'source',
  'name',
  'Stock Unit',
  'Pack Qty',
  'Item Size',
  'UoM',
  'cost YEN',
  'Barcode',
  'note',
  'fingerprint',
]

export function catalogCsv(products, roomsById) {
  const rows = products.filter((product) => product.active).map((product) => [
    product.external_id || '',
    roomsById.get(product.room_id) || '',
    product.source,
    product.name,
    product.stock_unit,
    product.pack_qty_note || product.pack_qty,
    product.item_size,
    product.uom,
    product.unit_cost_yen,
    (product.barcodes || []).join('; '),
    product.note,
    product.import_fingerprint || '',
  ])
  return toCsv(CATALOG_HEADERS, rows)
}
