import {
  classifyScan,
  defaultLabel,
  enqueueCount,
  formatQty,
  formatYen,
  roomStats,
  syncLabel,
  tallyQty,
  viewCounts,
} from '/logic.js'

const state = { rooms: [], products: [], counts: [], pending: [], online: true, loaded: false, syncing: false }
const ui = {
  tally: true,
  roomQuery: '',
  itemQuery: '',
  tab: 'todo',
  overlay: null,
  strip: null,
  token: '',
  flash: '',
  productPage: 0,
  productRoom: '',
}
const PAGE_SIZE = 40
let mounted = ''
let cameraStream = null

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function deviceId() {
  let id = localStorage.getItem('dd.device')
  if (!id) {
    id = Math.random().toString(36).slice(2, 8)
    localStorage.setItem('dd.device', id)
  }
  return id
}

function parseHash() {
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean)
  if (parts[0] === 'room' && parts[1]) return { name: 'room', roomId: Number(parts[1]) }
  if (parts[0] === 'manage') return { name: 'manage', section: parts[1] || 'home', id: parts[2] ? Number(parts[2]) : null }
  return { name: 'home' }
}

function routeKey(route) {
  return `${route.name}:${route.roomId || ''}:${route.section || ''}:${route.id || ''}`
}

function countsNow() {
  return viewCounts(state.counts, state.pending)
}

function currentCount(productId) {
  return countsNow().find((count) => count.product_id === productId) || null
}

function roomById(id) {
  return state.rooms.find((room) => room.id === id) || null
}

function productById(id) {
  return state.products.find((product) => product.id === id) || null
}

function authHeaders(json) {
  const headers = {}
  if (json) headers['content-type'] = 'application/json'
  if (ui.token) headers.authorization = `Bearer ${ui.token}`
  return headers
}

function clearToken() {
  ui.token = ''
  sessionStorage.removeItem('dd.token')
}

function flash(message) {
  ui.flash = message
  const el = document.getElementById('flash')
  if (!el) return
  el.hidden = !message
  el.textContent = message || ''
  clearTimeout(flash.timer)
  if (message) flash.timer = setTimeout(() => flash(''), 2800)
}

function statusText() {
  if (state.pending.length > 0 || !state.online) return 'Waiting to sync'
  return syncLabel(0)
}

function paintStatus() {
  for (const el of document.querySelectorAll('[data-sync]')) {
    el.textContent = statusText()
    el.classList.toggle('waiting', statusText() === 'Waiting to sync')
  }
}

function idb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dragon-dining', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbGet(key) {
  try {
    const db = await idb()
    return await new Promise((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  }
}

async function idbSet(key, value) {
  try {
    const db = await idb()
    await new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch { /* the on-screen count still stands for this session */ }
}

function savePending() {
  idbSet('pending', state.pending)
}

function render() {
  const route = parseHash()
  const key = routeKey(route)
  if (mounted !== key) {
    stopCamera()
    mounted = key
    mount(route)
  }
  paint(route)
}

function mount(route) {
  if (route.name !== 'manage' && ui.overlay?.then?.type === 'manage') ui.overlay = null
  const app = document.getElementById('app')
  if (route.name === 'home') app.innerHTML = homeHtml()
  else if (route.name === 'room') app.innerHTML = roomHtml(route)
  else app.innerHTML = manageHtml(route)
  bind(route)
}

function paint(route) {
  paintNav(route)
  paintStatus()
  if (route.name === 'home') paintHome()
  else if (route.name === 'room') paintRoom(route)
  else paintManage()
}

function paintNav(route) {
  document.getElementById('nav-home')?.classList.toggle('on', route.name === 'home')
  document.getElementById('nav-manager')?.classList.toggle('on', route.name === 'manage')
  const back = document.getElementById('nav-back')
  if (!back) return
  if (route.name === 'room') back.setAttribute('href', '#/')
  else if (route.name === 'manage' && route.section && route.section !== 'home') back.setAttribute('href', '#/manage')
  else back.setAttribute('href', '#/')
  back.classList.toggle('off', route.name === 'home')
}

function unknownJobs() {
  return state.pending.filter((job) => job.type === 'unknown')
}

function bannerHtml() {
  const jobs = unknownJobs()
  if (!jobs.length) return ''
  const label = jobs.length === 1 ? '1 barcode needs a name.' : `${jobs.length} barcodes need a name.`
  return `<button class="banner" id="open-unknown" type="button">${esc(label)}</button>`
}

function homeHtml() {
  return `
    <div class="wrap">
      <div class="top">
        <div>
          <div class="brand">Dragon Dining</div>
          <div class="sub">Stock take</div>
        </div>
        <div class="sync" data-sync aria-live="polite"></div>
      </div>
      <div id="banner-slot"></div>
      <h1>Rooms</h1>
      <p class="summary" id="home-summary"></p>
      <label class="field" for="room-search">Find a room</label>
      <input id="room-search" type="search" placeholder="Find a room" autocomplete="off">
      <div class="rooms" id="room-list" style="margin-top:12px"></div>
    </div>`
}

function roomHtml(route) {
  const room = roomById(route.roomId)
  return `
    <div class="wrap room-page">
      <div class="top">
        <div class="brand">${esc(room ? room.name : 'Room')}</div>
        <div class="sync" data-sync aria-live="polite"></div>
      </div>
      <div id="banner-slot"></div>
      <p class="summary" id="room-summary"></p>
      <div class="stick">
        <label class="field" for="scan">Scan barcode</label>
        <div class="scan-row">
          <input id="scan" type="text" placeholder="Scan barcode" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="none">
          <button id="tally" class="tally" type="button"></button>
        </div>
        <div class="tabs">
          <button type="button" data-tab="todo">Still to count</button>
          <button type="button" data-tab="done">Counted</button>
        </div>
        <label class="field" for="item-search" style="margin-top:8px">Find an item</label>
        <input id="item-search" type="search" placeholder="Find an item" autocomplete="off">
        <button id="camera-btn" class="ghost" type="button">Use camera</button>
      </div>
      <div id="list" class="list"></div>
    </div>
    <div id="strip" class="strip" hidden></div>
    <div id="overlay" class="overlay" hidden tabindex="-1"></div>
    <video id="camera" class="camera" hidden autoplay playsinline></video>`
}

function manageHtml(route) {
  const sync = `<div class="sync" data-sync aria-live="polite"></div>`
  const top = `<div class="wrap"><div class="top"><div class="brand">Manager</div>${sync}</div>`
  if (!ui.token) return `${top}<h1>Manager</h1><p class="help">Enter the manager PIN.</p><div id="pin-mount"></div></div>`
  if (route.section === 'products' || route.section === 'product') {
    const roomOptions = state.rooms.map((room) => `<option value="${room.id}">${esc(room.name)}</option>`).join('')
    return `<div class="wrap wide"><div class="top"><div class="brand">Manager</div>${sync}</div>
      <h1>Items</h1>
      <p class="help">Edit a row, then Save. Stock value uses cost. Price is kept separate.</p>
      <div class="row">
        <input id="manage-search" type="search" placeholder="Find an item" autocomplete="off">
        <select id="manage-room"><option value="">All rooms</option>${roomOptions}</select>
      </div>
      <div class="pager">
        <button id="page-prev" class="ghost" type="button">Previous page</button>
        <span id="page-label"></span>
        <button id="page-next" class="ghost" type="button">Next page</button>
      </div>
      <div class="table-wrap">
        <table class="sheet">
          <thead><tr>
            <th>Name</th><th>Room</th><th>Supplier</th><th>Unit</th><th>Pack</th><th>Pack note</th>
            <th>Size</th><th>UoM</th><th>Cost</th><th>Price</th><th>Barcodes</th><th>Note</th><th>Hide</th><th></th>
          </tr></thead>
          <tbody id="manage-list"></tbody>
        </table>
      </div>
    </div>`
  }
  if (route.section === 'rooms') return `${top}<h1>Rooms</h1><div id="room-admin"></div></div>`
  if (route.section === 'import') return `${top}<h1>Import catalog</h1><div id="import-admin"></div><div id="report" class="report"></div></div>`
  if (route.section === 'finish') return `${top}<h1>Finish stock take</h1><p id="live-total" class="summary"></p><div id="finish-admin"></div></div>`
  if (route.section === 'archives') return `${top}<h1>Past stock takes</h1><div id="archive-list" class="stack"></div></div>`
  if (route.section === 'pin') return `${top}<h1>Change PIN</h1><div id="pin-change"></div></div>`
  return `${top}
    <h1>Manager</h1>
    <div class="menu">
      <a href="#/manage/products">Items and barcodes</a>
      <a href="#/manage/rooms">Rooms</a>
      <a href="#/manage/import">Import catalog</a>
      <a href="#/manage/finish">Finish stock take</a>
      <a href="#/manage/archives">Past stock takes</a>
      <a href="#/manage/pin">Change PIN</a>
      <button id="logout" class="ghost" type="button">Lock manager</button>
    </div></div>`
}

function bind(route) {
  document.getElementById('room-search')?.addEventListener('input', (event) => {
    ui.roomQuery = event.target.value
    paintHome()
  })
  document.getElementById('open-unknown')?.addEventListener('click', openNextUnknown)
  const scan = document.getElementById('scan')
  if (scan) {
    scan.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Tab') return
      event.preventDefault()
      const value = scan.value
      scan.value = ''
      handleScan(value)
    })
    scan.focus()
  }
  document.getElementById('tally')?.addEventListener('click', () => {
    ui.tally = !ui.tally
    localStorage.setItem('dd.tally', ui.tally ? '1' : '0')
    paintRoom(parseHash())
    focusScan()
  })
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      ui.tab = button.dataset.tab
      paintRoom(parseHash())
      focusScan()
    })
  })
  document.getElementById('item-search')?.addEventListener('input', (event) => {
    ui.itemQuery = event.target.value
    paintRoom(parseHash())
  })
  document.getElementById('list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]')
    if (!button) return
    const product = productById(Number(button.dataset.id))
    if (product) openKeypad(product, { qty: currentCount(product.id) ? formatQty(currentCount(product.id).qty) : '', fresh: true })
  })
  document.getElementById('strip')?.addEventListener('click', onStripClick)
  document.getElementById('overlay')?.addEventListener('click', onOverlayClick)
  document.getElementById('overlay')?.addEventListener('input', onOverlayInput)
  document.getElementById('camera-btn')?.addEventListener('click', toggleCamera)
  document.getElementById('logout')?.addEventListener('click', () => {
    clearToken()
    mounted = ''
    render()
  })
  if (route.name === 'manage') bindManage(route)
}

function bindManage(route) {
  if (!ui.token) {
    ui.overlay = { type: 'pin', pin: '', then: { type: 'manage' } }
    const mountPoint = document.getElementById('pin-mount')
    if (mountPoint) {
      mountPoint.innerHTML = pinHtml()
      mountPoint.addEventListener('click', onOverlayClick)
    }
    return
  }
  const manageSearch = document.getElementById('manage-search')
  if (manageSearch) {
    manageSearch.value = ui.itemQuery
    manageSearch.addEventListener('input', (event) => {
      ui.itemQuery = event.target.value
      ui.productPage = 0
      paintProductAdmin()
    })
  }
  const manageRoom = document.getElementById('manage-room')
  if (manageRoom) {
    manageRoom.value = ui.productRoom
    manageRoom.addEventListener('change', (event) => {
      ui.productRoom = event.target.value
      ui.productPage = 0
      paintProductAdmin()
    })
  }
  document.getElementById('page-prev')?.addEventListener('click', () => {
    ui.productPage = Math.max(0, ui.productPage - 1)
    paintProductAdmin()
  })
  document.getElementById('page-next')?.addEventListener('click', () => {
    ui.productPage += 1
    paintProductAdmin()
  })
  document.getElementById('manage-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-save]')
    if (button) saveTableRow(button.closest('tr'))
  })
  if (route.section === 'products' || route.section === 'product') paintProductAdmin()
  if (route.section === 'rooms') fillRooms()
  if (route.section === 'import') fillImport()
  if (route.section === 'finish') fillFinish()
  if (route.section === 'archives') fillArchives()
  if (route.section === 'pin') fillPinChange()
}

function paintHome() {
  const slot = document.getElementById('banner-slot')
  if (slot) slot.innerHTML = bannerHtml()
  document.getElementById('open-unknown')?.addEventListener('click', openNextUnknown)
  const stats = roomStats(state.rooms, state.products, countsNow())
  const query = ui.roomQuery.trim().toLowerCase()
  const visible = stats.filter((room) => room.name.toLowerCase().includes(query))
  const counted = stats.reduce((sum, room) => sum + room.counted, 0)
  const total = stats.reduce((sum, room) => sum + room.total, 0)
  const summary = document.getElementById('home-summary')
  if (summary) {
    summary.textContent = state.loaded
      ? `${counted} of ${total} counted`
      : 'Open this page once while the kitchen computer is running.'
  }
  const list = document.getElementById('room-list')
  if (!list) return
  if (!state.loaded) {
    list.innerHTML = '<p class="empty">The catalog is not on this device yet.</p>'
    return
  }
  list.innerHTML = visible.map((room) => {
    const width = room.total ? Math.round((room.counted / room.total) * 100) : 0
    return `<a class="card" href="#/room/${room.id}">
      <strong>${esc(room.name)}</strong>
      <div class="meta">${room.counted} of ${room.total} counted</div>
      <div class="bar"><span style="width:${width}%"></span></div>
    </a>`
  }).join('') || '<p class="empty">No room matches.</p>'
}

function itemButton(product, count) {
  const bits = [product.stock_unit, [product.item_size, product.uom].filter(Boolean).join(' '), product.pack_qty_note, product.source].filter(Boolean)
  const pulse = ui.strip?.pulse && ui.strip.productId === product.id ? ' pulse' : ''
  return `<button class="item${pulse}" type="button" data-id="${product.id}">
    <span><span class="item-name">${esc(product.name)}</span><span class="meta">${esc(bits.join(' · '))}</span></span>
    <span class="item-qty">${count ? esc(formatQty(count.qty)) : ''}</span>
  </button>`
}

function paintRoom(route) {
  const room = roomById(route.roomId)
  const summary = document.getElementById('room-summary')
  const stats = roomStats(state.rooms, state.products, countsNow()).find((row) => row.id === route.roomId)
  if (summary) summary.textContent = stats ? `${stats.counted} of ${stats.total} counted` : ''
  const tally = document.getElementById('tally')
  if (tally) {
    tally.textContent = ui.tally ? 'Tally on' : 'Tally off'
    tally.classList.toggle('on', ui.tally)
    tally.setAttribute('aria-pressed', ui.tally ? 'true' : 'false')
  }
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.setAttribute('aria-selected', button.dataset.tab === ui.tab ? 'true' : 'false')
  })
  const slot = document.getElementById('banner-slot')
  if (slot && slot.innerHTML !== bannerHtml()) {
    slot.innerHTML = bannerHtml()
    document.getElementById('open-unknown')?.addEventListener('click', openNextUnknown)
  }
  const query = ui.itemQuery.trim().toLowerCase()
  const counts = countsNow()
  const inRoom = state.products.filter((product) => product.active && product.room_id === route.roomId)
  const match = (product) => !query || [product.name, product.source, product.stock_unit, ...(product.barcodes || [])].join(' ').toLowerCase().includes(query)
  const rows = inRoom.filter(match).filter((product) => {
    const count = counts.find((entry) => entry.product_id === product.id)
    return ui.tab === 'done' ? Boolean(count) : !count
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  const list = document.getElementById('list')
  if (list) {
    list.innerHTML = rows.map((product) => itemButton(product, counts.find((entry) => entry.product_id === product.id))).join('')
      || `<p class="empty">${ui.tab === 'done' ? 'Nothing counted yet.' : 'Nothing left to count in this room.'}</p>`
  }
  paintStrip(room)
  paintOverlay()
  if (!room) {
    const title = document.querySelector('.brand')
    if (title) title.textContent = 'That room is not on this device.'
  }
}

function paintStrip(room) {
  const strip = document.getElementById('strip')
  if (!strip) return
  const product = ui.strip ? productById(ui.strip.productId) : null
  const count = product ? currentCount(product.id) : null
  if (!product || !count) {
    strip.hidden = true
    return
  }
  const where = roomById(product.room_id)
  const sig = `${product.id}:${count.qty}:${count.updated_at}`
  if (strip.dataset.sig !== sig) {
    strip.dataset.sig = sig
    strip.innerHTML = `
      <div style="flex:1">
        <div class="strip-name">${esc(product.name)}</div>
        <div class="meta">${esc(where ? where.name : room?.name || '')}</div>
      </div>
      <button class="step" type="button" data-delta="-1" aria-label="Minus">−</button>
      <button type="button" class="strip-qty" data-edit="1" aria-label="Edit quantity">${esc(formatQty(count.qty))}</button>
      <button class="step" type="button" data-delta="1" aria-label="Plus">+</button>`
  }
  strip.hidden = false
  if (ui.strip.pulse) {
    strip.classList.remove('pulse')
    void strip.offsetWidth
    strip.classList.add('pulse')
    ui.strip.pulse = false
  }
}

function paintOverlay() {
  const overlay = document.getElementById('overlay')
  if (!overlay) return
  if (!ui.overlay || (ui.overlay.type === 'pin' && document.getElementById('pin-mount'))) {
    overlay.hidden = true
    overlay.innerHTML = ''
    delete overlay.dataset.sig
    return
  }
  const signature = JSON.stringify(ui.overlay)
  if (overlay.dataset.sig === signature && !overlay.hidden) return
  overlay.dataset.sig = signature
  overlay.hidden = false
  overlay.innerHTML = `<div class="dialog">${overlayBody(ui.overlay)}</div>`
  if (ui.overlay.type === 'keypad') focusScan()
  else overlay.focus()
}

function overlayBody(overlay) {
  if (overlay.type === 'unknown') return unknownHtml(overlay)
  if (overlay.type === 'create') return createHtml(overlay)
  if (overlay.type === 'keypad') return keypadHtml(overlay)
  if (overlay.type === 'pin') return pinHtml()
  return ''
}

function unknownHtml(overlay) {
  return `
    <h2>Unknown barcode</h2>
    <p>No item uses <strong>${esc(overlay.code)}</strong>.</p>
    <label class="field" for="link-search">Find an item to link</label>
    <input id="link-search" type="search" value="${esc(overlay.query || '')}" placeholder="Type the item name" autocomplete="off">
    <div id="link-results" class="list">${linkResultsHtml(overlay.query || '')}</div>
    <button class="primary" type="button" data-act="create">Create a new item</button>
    <button class="ghost" type="button" data-act="close">Skip for now</button>
    <button class="danger" type="button" data-act="forget">Forget this barcode</button>`
}

function linkResultsHtml(query) {
  const q = query.trim().toLowerCase()
  if (!q) return '<p class="empty">Type a name to link this barcode.</p>'
  const rows = state.products.filter((product) => product.active && product.name.toLowerCase().includes(q)).slice(0, 12)
  if (!rows.length) return '<p class="empty">No item matches.</p>'
  return rows.map((product) => {
    const room = roomById(product.room_id)
    return `<button class="item" type="button" data-link="${product.id}"><span class="item-name">${esc(product.name)}</span><span class="meta">${esc(room ? room.name : '')}</span></button>`
  }).join('')
}

function createHtml(overlay) {
  const rooms = state.rooms.filter((room) => room.active)
  return `
    <h2>New item</h2>
    <p>Barcode <strong>${esc(overlay.code)}</strong></p>
    ${ui.token ? '' : '<label class="field" for="create-pin">Manager PIN</label><input id="create-pin" type="password" inputmode="numeric" autocomplete="one-time-code">'}
    <div class="form-grid">
      <label class="field" for="create-name">Name</label>
      <input id="create-name" type="text" autocomplete="off">
      <label class="field" for="create-room">Room</label>
      <select id="create-room">${rooms.map((room) => `<option value="${room.id}" ${room.id === overlay.roomId ? 'selected' : ''}>${esc(room.name)}</option>`).join('')}</select>
      <label class="field" for="create-cost">Cost in yen</label>
      <input id="create-cost" type="text" inputmode="numeric" placeholder="Optional">
    </div>
    <button class="primary" type="button" data-act="save-create">Save and count</button>
    <button class="ghost" type="button" data-act="back-unknown">Back</button>`
}

function keypadHtml(overlay) {
  const product = productById(overlay.productId)
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']
  return `
    <h2>${esc(product ? product.name : 'Quantity')}</h2>
    <div class="qty-display">${esc(overlay.qty || ' ')}</div>
    <div class="keys">${keys.map((key) => `<button type="button" data-key="${esc(key)}">${esc(key)}</button>`).join('')}</div>
    <button class="primary" type="button" data-act="save-qty">Save</button>
    <button class="danger" type="button" data-act="clear-count">Clear count</button>
    <button class="ghost" type="button" data-act="close">Cancel</button>`
}

function pinHtml() {
  const pin = ui.overlay?.pin || ''
  return `
    <div class="pin-dots" id="pin-dots">${pin ? '●'.repeat(pin.length) : 'PIN'}</div>
    <div class="keys">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((key) => key ? `<button type="button" data-pin="${esc(key)}">${esc(key)}</button>` : '<span></span>').join('')}</div>
    <button class="primary" type="button" data-act="unlock">Unlock</button>`
}

function focusScan() {
  if (ui.overlay) return
  document.getElementById('scan')?.focus()
}

function handleScan(raw) {
  const code = String(raw || '').trim()
  if (!code) return
  if (ui.overlay && ui.overlay.type !== 'keypad') {
    flash('Finish this question first.')
    return
  }
  const route = parseHash()
  if (route.name !== 'room') return
  ui.overlay = null
  const result = classifyScan(state.products, route.roomId, code)
  if (result.status === 'unknown') {
    rememberUnknown(code, route.roomId)
    ui.overlay = { type: 'unknown', code, query: '', roomId: route.roomId }
    paintRoom(route)
    return
  }
  if (result.status === 'hidden') {
    flash('This item is hidden. A manager can turn it back on.')
    focusScan()
    return
  }
  commitScan(result.product)
}

function commitScan(product) {
  if (ui.tally) {
    const qty = tallyQty(currentCount(product.id)?.qty ?? null)
    setCount(product, qty)
    ui.overlay = null
    paintRoom(parseHash())
    focusScan()
    return
  }
  openKeypad(product, { qty: '1', fresh: true })
}

function openKeypad(product, { qty, fresh }) {
  ui.overlay = { type: 'keypad', productId: product.id, qty, fresh }
  paintOverlay()
}

function setCount(product, qty) {
  const item = {
    type: 'count',
    product_id: product.id,
    counted_room_id: product.room_id,
    qty,
    is_exception: 0,
    updated_at: new Date().toISOString(),
    device_id: deviceId(),
  }
  state.pending = enqueueCount(state.pending, item)
  savePending()
  ui.strip = { productId: product.id, pulse: true }
  flushQueue()
}

function rememberUnknown(code, roomId) {
  const exists = state.pending.some((job) => job.type === 'unknown' && job.code.toUpperCase() === code.toUpperCase())
  if (exists) return
  state.pending = [...state.pending, { type: 'unknown', code, room_id: roomId, updated_at: new Date().toISOString() }]
  savePending()
}

function openNextUnknown() {
  const job = unknownJobs()[0]
  if (!job) return
  if (!location.hash.startsWith('#/room/')) location.hash = `#/room/${job.room_id}`
  ui.overlay = { type: 'unknown', code: job.code, query: '', roomId: job.room_id }
  paintRoom(parseHash())
}

function onStripClick(event) {
  const product = ui.strip ? productById(ui.strip.productId) : null
  if (!product) return
  const count = currentCount(product.id)
  if (event.target.dataset.delta) {
    const qty = Math.max(0, (count ? Number(count.qty) : 0) + Number(event.target.dataset.delta))
    const rounded = Math.round(qty * 1000) / 1000
    setCount(product, rounded)
    paintRoom(parseHash())
    focusScan()
  }
  if (event.target.dataset.edit) {
    openKeypad(product, { qty: count ? formatQty(count.qty) : '', fresh: true })
  }
}

function onOverlayInput(event) {
  if (event.target.id !== 'link-search' || !ui.overlay) return
  ui.overlay.query = event.target.value
  const results = document.getElementById('link-results')
  if (results) results.innerHTML = linkResultsHtml(ui.overlay.query)
}

function onOverlayClick(event) {
  const pinKey = event.target.dataset?.pin
  if (pinKey) return pressPin(pinKey)
  const key = event.target.dataset?.key
  if (key && ui.overlay?.type === 'keypad') return pressKey(key)
  const link = event.target.closest('[data-link]')
  if (link) return linkBarcode(Number(link.dataset.link))
  const act = event.target.dataset?.act
  if (!act) return
  if (act === 'close') return closeOverlay()
  if (act === 'forget') return forgetUnknown()
  if (act === 'create') {
    ui.overlay = { type: 'create', code: ui.overlay.code, roomId: ui.overlay.roomId || parseHash().roomId }
    paintOverlay()
    return
  }
  if (act === 'back-unknown') {
    ui.overlay = { type: 'unknown', code: ui.overlay.code, query: '', roomId: ui.overlay.roomId }
    paintOverlay()
    return
  }
  if (act === 'save-create') return saveCreate()
  if (act === 'save-qty') return saveQty()
  if (act === 'clear-count') return clearCount()
  if (act === 'unlock') return unlock()
}

function closeOverlay() {
  ui.overlay = null
  paintOverlay()
  paintRoom(parseHash())
  focusScan()
}

function forgetUnknown() {
  const code = ui.overlay?.code
  state.pending = state.pending.filter((job) => !(job.type === 'unknown' && job.code === code))
  savePending()
  closeOverlay()
}

function pressKey(key) {
  const overlay = ui.overlay
  if (!overlay) return
  if (key === '⌫') overlay.qty = overlay.qty.slice(0, -1)
  else if (key === '.' && overlay.qty.includes('.')) return
  else if (overlay.fresh && key !== '.') overlay.qty = key
  else if (overlay.qty.length < 8) overlay.qty += key
  overlay.fresh = false
  const display = document.querySelector('.qty-display')
  if (display) display.textContent = overlay.qty || ' '
}

function pressPin(key) {
  if (!ui.overlay) ui.overlay = { type: 'pin', pin: '', then: { type: 'manage' } }
  if (key === '⌫') ui.overlay.pin = ui.overlay.pin.slice(0, -1)
  else if (ui.overlay.pin.length < 8) ui.overlay.pin += key
  const dots = document.getElementById('pin-dots')
  if (dots) dots.textContent = ui.overlay.pin ? '●'.repeat(ui.overlay.pin.length) : 'PIN'
}

async function unlock() {
  const pin = ui.overlay?.pin || ''
  try {
    const response = await fetch('/api/pin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) })
    const data = await response.json()
    if (!response.ok) {
      flash(data.error || 'That PIN is not right.')
      return
    }
    ui.token = data.token
    sessionStorage.setItem('dd.token', data.token)
    ui.overlay = null
    flushQueue()
    mounted = ''
    if (!location.hash.startsWith('#/manage')) location.hash = '#/manage'
    else render()
  } catch {
    flash('Waiting to sync. The PIN check needs the kitchen computer.')
  }
}

async function linkBarcode(productId) {
  const overlay = ui.overlay
  const product = productById(productId)
  if (!product || !overlay) return
  if (!product.barcodes.some((code) => code.toUpperCase() === overlay.code.toUpperCase())) product.barcodes = [...product.barcodes, overlay.code]
  state.pending = state.pending.filter((job) => !(job.type === 'unknown' && job.code.toUpperCase() === overlay.code.toUpperCase()))
  state.pending = [...state.pending, { type: 'link', code: overlay.code, product_id: productId }]
  savePending()
  ui.overlay = null
  commitScan(product)
  paintRoom(parseHash())
  flushQueue()
}

async function saveCreate() {
  const overlay = ui.overlay
  const name = document.getElementById('create-name')?.value.trim()
  const roomId = Number(document.getElementById('create-room')?.value)
  const costText = document.getElementById('create-cost')?.value.trim()
  const pin = document.getElementById('create-pin')?.value.trim()
  if (!name) return flash('An item needs a name.')
  if (!ui.token && pin) {
    const logged = await fetch('/api/pin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) })
    const data = await logged.json()
    if (!logged.ok) return flash(data.error || 'That PIN is not right.')
    ui.token = data.token
    sessionStorage.setItem('dd.token', data.token)
  }
  if (!ui.token) return flash('A manager PIN is required to add an item.')
  const body = { name, room_id: roomId, unit_cost_yen: costText || null, barcode: overlay.code }
  const tempId = -Date.now()
  const temp = {
    id: tempId, room_id: roomId, name, source: null, stock_unit: null, pack_qty: null, pack_qty_note: null,
    item_size: null, uom: null, unit_cost_yen: costText ? Math.round(Number(costText.replace(/[¥,\s]/g, ''))) : null,
    unit_price_yen: null, note: null, active: true, barcodes: [overlay.code],
  }
  state.products.push(temp)
  state.pending = state.pending.filter((job) => !(job.type === 'unknown' && job.code === overlay.code))
  state.pending = [...state.pending, { type: 'create', temp_id: tempId, body }]
  savePending()
  ui.overlay = null
  commitScan(temp)
  paintRoom(parseHash())
  flushQueue()
}

function saveQty() {
  const overlay = ui.overlay
  const product = productById(overlay.productId)
  if (!product) return closeOverlay()
  if (overlay.qty === '' || overlay.qty === '.') return flash('Enter a quantity. Use 0 if there are none.')
  const qty = Number(overlay.qty)
  if (!Number.isFinite(qty) || qty < 0) return flash('Enter a quantity. Use 0 if there are none.')
  setCount(product, qty)
  ui.overlay = null
  paintRoom(parseHash())
  focusScan()
}

function clearCount() {
  const overlay = ui.overlay
  const product = productById(overlay.productId)
  if (!product) return closeOverlay()
  setCount(product, null)
  ui.overlay = null
  if (ui.strip?.productId === product.id) ui.strip = null
  paintRoom(parseHash())
  focusScan()
}

async function flushQueue() {
  if (state.syncing) return
  const work = state.pending.filter((job) => job.type !== 'unknown')
  if (!work.length) {
    paintStatus()
    return
  }
  state.syncing = true
  paintStatus()
  try {
    await flushCreates()
    await flushLinks()
    await flushMoves()
    await flushCounts()
    state.online = true
    savePending()
    await idbSet('catalog', { rooms: state.rooms, products: state.products, counts: state.counts })
  } catch (error) {
    if (error.message !== 'pin') state.online = false
  } finally {
    state.syncing = false
    paintStatus()
  }
}

async function flushCreates() {
  for (const job of state.pending.filter((item) => item.type === 'create')) {
    const response = await fetch('/api/products', { method: 'POST', headers: authHeaders(true), body: JSON.stringify(job.body) })
    const data = await response.json().catch(() => ({}))
    if (response.status === 401) {
      clearToken()
      throw new Error('pin')
    }
    if (!response.ok) {
      state.products = state.products.filter((product) => product.id !== job.temp_id)
      state.pending = state.pending.filter((item) => item !== job && item.product_id !== job.temp_id)
      flash(data.error || 'The new item was not saved.')
      continue
    }
    state.products = state.products.filter((product) => product.id !== job.temp_id)
    if (!state.products.some((product) => product.id === data.product.id)) state.products.push(data.product)
    state.pending = state.pending.map((item) => item.product_id === job.temp_id ? { ...item, product_id: data.product.id } : item)
    state.pending = state.pending.filter((item) => item !== job)
    if (ui.strip?.productId === job.temp_id) ui.strip.productId = data.product.id
  }
}

async function flushLinks() {
  for (const job of [...state.pending.filter((item) => item.type === 'link')]) {
    const response = await fetch('/api/barcodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: job.code, product_id: job.product_id }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok && response.status !== 409) throw new Error('wait')
    if (response.ok) replaceProduct(data.product)
    if (response.status === 409) {
      const product = productById(job.product_id)
      if (product) product.barcodes = product.barcodes.filter((code) => code.toUpperCase() !== job.code.toUpperCase())
      flash(data.error || 'That barcode is already on another item.')
    }
    state.pending = state.pending.filter((item) => item !== job)
  }
}

async function flushMoves() {
  for (const job of [...state.pending.filter((item) => item.type === 'move' && item.product_id > 0)]) {
    const response = await fetch(`/api/products/${job.product_id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ room_id: job.room_id }) })
    if (response.status === 401) {
      clearToken()
      throw new Error('pin')
    }
    if (!response.ok) throw new Error('wait')
    const data = await response.json()
    replaceProduct(data.product)
    state.pending = state.pending.filter((item) => item !== job)
  }
}

async function flushCounts() {
  const counts = state.pending.filter((item) => item.type === 'count' && item.product_id > 0)
  if (!counts.length) return
  const sent = new Map(counts.map((count) => [count.product_id, count.updated_at]))
  const response = await fetch('/api/counts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ counts }) })
  if (!response.ok) throw new Error('wait')
  const data = await response.json()
  for (const result of data.results || []) {
    const stamp = sent.get(result.product_id)
    state.pending = state.pending.filter((item) => !(item.type === 'count' && item.product_id === result.product_id && item.updated_at === stamp))
    if (result.status === 'cleared') state.counts = state.counts.filter((count) => count.product_id !== result.product_id)
    else if (result.count) upsertServerCount(result.count)
  }
}

function replaceProduct(product) {
  const index = state.products.findIndex((item) => item.id === product.id)
  if (index >= 0) state.products[index] = product
  else state.products.push(product)
}

function upsertServerCount(count) {
  const index = state.counts.findIndex((item) => item.product_id === count.product_id)
  if (index >= 0) state.counts[index] = count
  else state.counts.push(count)
}

function paintManage() {
  const el = document.getElementById('live-total')
  if (!el) return
  const stats = roomStats(state.rooms, state.products, countsNow())
  const counted = stats.reduce((sum, room) => sum + room.counted, 0)
  const total = stats.reduce((sum, room) => sum + room.total, 0)
  const value = stats.reduce((sum, room) => sum + (room.value || 0), 0)
  el.textContent = `${counted} of ${total} counted · ${formatYen(counted ? value : null)}`
}

function filteredProducts() {
  const query = ui.itemQuery.trim().toLowerCase()
  const roomId = ui.productRoom ? Number(ui.productRoom) : null
  return state.products
    .filter((product) => !roomId || product.room_id === roomId)
    .filter((product) => !query || [product.name, product.source, ...(product.barcodes || [])].join(' ').toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
}

function paintProductAdmin() {
  const list = document.getElementById('manage-list')
  if (!list) return
  const rows = filteredProducts()
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  if (ui.productPage > pages - 1) ui.productPage = pages - 1
  const start = ui.productPage * PAGE_SIZE
  const slice = rows.slice(start, start + PAGE_SIZE)
  const label = document.getElementById('page-label')
  if (label) label.textContent = `Page ${ui.productPage + 1} of ${pages}`
  const prev = document.getElementById('page-prev')
  const next = document.getElementById('page-next')
  if (prev) prev.disabled = ui.productPage === 0
  if (next) next.disabled = ui.productPage >= pages - 1
  const rooms = state.rooms.map((room) => `<option value="${room.id}">${esc(room.name)}</option>`).join('')
  list.innerHTML = slice.map((product) => `
    <tr data-id="${product.id}">
      <td><input data-field="name" type="text" value="${esc(product.name)}"></td>
      <td><select data-field="room_id">${rooms.replace(`value="${product.room_id}"`, `value="${product.room_id}" selected`)}</select></td>
      <td><input data-field="source" type="text" value="${esc(product.source || '')}"></td>
      <td><input data-field="unit" type="text" value="${esc(product.stock_unit || '')}"></td>
      <td><input data-field="pack_qty" type="text" value="${esc(product.pack_qty ?? '')}"></td>
      <td><input data-field="pack_qty_note" type="text" value="${esc(product.pack_qty_note || '')}"></td>
      <td><input data-field="item_size" type="text" value="${esc(product.item_size || '')}"></td>
      <td><input data-field="uom" type="text" value="${esc(product.uom || '')}"></td>
      <td><input data-field="cost" type="text" inputmode="numeric" value="${esc(product.unit_cost_yen ?? '')}"></td>
      <td><input data-field="price" type="text" inputmode="numeric" value="${esc(product.unit_price_yen ?? '')}"></td>
      <td><input data-field="barcodes" type="text" value="${esc((product.barcodes || []).join('; '))}"></td>
      <td><input data-field="note" type="text" value="${esc(product.note || '')}"></td>
      <td><input data-field="hidden" type="checkbox" ${product.active ? '' : 'checked'}></td>
      <td><button class="primary row-save" type="button" data-save="${product.id}">Save</button></td>
    </tr>`).join('') || '<tr><td colspan="14">No item matches.</td></tr>'
}

async function saveTableRow(row) {
  if (!row) return
  const id = Number(row.dataset.id)
  const product = productById(id)
  if (!product) return
  const field = (name) => row.querySelector(`[data-field="${name}"]`).value
  const button = row.querySelector('[data-save]')
  if (button) button.disabled = true
  const body = {
    name: field('name'),
    room_id: Number(field('room_id')),
    source: field('source'),
    stock_unit: field('unit'),
    pack_qty: field('pack_qty'),
    pack_qty_note: field('pack_qty_note'),
    item_size: field('item_size'),
    uom: field('uom'),
    unit_cost_yen: field('cost'),
    unit_price_yen: field('price'),
    note: field('note'),
    active: !row.querySelector('[data-field="hidden"]').checked,
  }
  const response = await fetch(`/api/products/${id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify(body) })
  const data = await response.json()
  if (response.status === 401) return loseManager()
  if (!response.ok) {
    if (button) button.disabled = false
    return flash(data.error || 'The item was not saved.')
  }
  const wanted = field('barcodes').split(/[;,]/).map((code) => code.trim()).filter(Boolean)
  const had = product.barcodes || []
  let latest = data.product
  for (const code of had) {
    if (wanted.some((value) => value.toUpperCase() === code.toUpperCase())) continue
    const removed = await fetch(`/api/barcodes?code=${encodeURIComponent(code)}`, { method: 'DELETE', headers: authHeaders() })
    if (!removed.ok) {
      const removedBody = await removed.json().catch(() => ({}))
      flash(removedBody.error || 'A barcode was not removed.')
    }
  }
  for (const code of wanted) {
    if (had.some((value) => value.toUpperCase() === code.toUpperCase())) continue
    const linked = await fetch('/api/barcodes', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ code, product_id: id }),
    })
    const linkedBody = await linked.json().catch(() => ({}))
    if (!linked.ok) flash(linkedBody.error || 'A barcode was not added.')
    else latest = linkedBody.product
  }
  latest = { ...latest, barcodes: wanted, room_id: body.room_id, active: body.active }
  replaceProduct(latest)
  if (button) button.disabled = false
  flash('Saved.')
}

function loseManager() {
  clearToken()
  flash('Manager PIN required.')
  location.hash = '#/manage'
  mounted = ''
  render()
}

function fillRooms() {
  const root = document.getElementById('room-admin')
  root.innerHTML = `
    <div class="stack">${state.rooms.map((room) => `<div class="card"><strong>${esc(room.name)}</strong>${room.active ? '' : '<div class="meta">Hidden</div>'}
      <div class="row" style="margin-top:8px"><input data-room-name="${room.id}" type="text" value="${esc(room.name)}"><button type="button" data-rename="${room.id}">Rename</button></div>
      <button class="ghost" type="button" data-room-active="${room.id}" data-next="${room.active ? '0' : '1'}">${room.active ? 'Hide room' : 'Show room'}</button>
    </div>`).join('')}</div>
    <h2>Add a room</h2>
    <div class="row"><input id="new-room" type="text" placeholder="Room name"><button id="add-room" class="primary" type="button">Add</button></div>`
  root.querySelector('#add-room').addEventListener('click', addRoom)
  root.querySelectorAll('[data-rename]').forEach((button) => button.addEventListener('click', () => renameRoom(Number(button.dataset.rename))))
  root.querySelectorAll('[data-room-active]').forEach((button) => button.addEventListener('click', () => setRoomActive(Number(button.dataset.roomActive), button.dataset.next === '1')))
}

async function addRoom() {
  const name = document.getElementById('new-room').value
  const response = await fetch('/api/rooms', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name }) })
  const data = await response.json()
  if (!response.ok) return flash(data.error || 'The room was not added.')
  state.rooms.push({ ...data.room, active: true })
  mounted = ''
  render()
}

async function renameRoom(id) {
  const name = document.querySelector(`[data-room-name="${id}"]`).value
  const response = await fetch(`/api/rooms/${id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ name }) })
  const data = await response.json()
  if (!response.ok) return flash(data.error || 'The room was not renamed.')
  const room = roomById(id)
  if (room) room.name = data.room.name
  flash('Saved.')
}

async function setRoomActive(id, active) {
  const response = await fetch(`/api/rooms/${id}`, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ active }) })
  const data = await response.json()
  if (!response.ok) return flash(data.error || 'The room was not changed.')
  const room = roomById(id)
  if (room) room.active = Boolean(data.room.active)
  mounted = ''
  render()
}

function fillImport() {
  const root = document.getElementById('import-admin')
  root.innerHTML = `
    <p class="help">Merge adds and updates items. Replace starts the catalog again from the file. Type REPLACE to replace. A count in progress must be abandoned first.</p>
    <input id="import-file" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
    <button id="do-merge" class="primary" type="button">Merge</button>
    <label class="field" for="replace-word">Type REPLACE</label>
    <input id="replace-word" type="text" autocomplete="off">
    <label class="check"><input id="abandon-box" type="checkbox"> Abandon the open count</label>
    <button id="do-replace" class="danger" type="button">Replace catalog</button>
    <button id="download-catalog" class="ghost" type="button">Download catalog</button>`
  root.querySelector('#do-merge').addEventListener('click', () => runImport('merge'))
  root.querySelector('#do-replace').addEventListener('click', () => runImport('replace'))
  root.querySelector('#download-catalog').addEventListener('click', downloadCatalog)
  loadReport()
}

async function runImport(mode) {
  const file = document.getElementById('import-file').files?.[0]
  if (!file) return flash('Choose a file first.')
  if (mode === 'replace' && document.getElementById('replace-word').value !== 'REPLACE') {
    return flash('Type REPLACE to replace the catalog.')
  }
  const abandon = document.getElementById('abandon-box').checked ? '1' : '0'
  const confirm = mode === 'replace' ? '&confirm=REPLACE' : ''
  const response = await fetch(`/api/import?mode=${mode}${confirm}&abandon=${abandon}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
    body: await file.arrayBuffer(),
  })
  const data = await response.json()
  if (response.status === 401) return loseManager()
  if (!response.ok) return flash(data.error || 'The import did not finish.')
  flash('Import finished.')
  await refresh()
  const box = document.getElementById('report')
  if (box) box.innerHTML = reportHtml(data.report)
}

async function loadReport() {
  const response = await fetch('/api/import/latest', { headers: authHeaders() })
  if (!response.ok) return
  const data = await response.json()
  const box = document.getElementById('report')
  if (box && data.report) box.innerHTML = reportHtml(data.report.report)
}

function reportHtml(report) {
  if (!report) return ''
  const lines = [
    ['Items in the catalog', report.product_count],
    ['Barcodes kept', report.barcode_count],
    ['Missing costs', report.costs_missing],
    ['Sheet ids kept', report.external_ids_kept],
    ['Counts seeded', report.counts_seeded?.length || 0],
    ['Archives added', report.archives_imported],
  ]
  const blocks = [
    ['Duplicate sheet ids, kept as separate items', (report.external_ids_dropped_duplicate || []).map((row) => `${row.sheet_id}: ${row.names.join(' / ')}`)],
    ['Barcode on more than one item', (report.barcodes_conflict || []).map((row) => `${row.code}: ${(row.names || []).join(' / ')}`)],
    ['Placeholder barcodes dropped', (report.barcodes_dropped_placeholder || []).map((row) => `${row.value} · ${row.name}`)],
    ['Location names folded', (report.locations_folded || []).map((row) => `${row.from} → ${row.to} (${row.count})`)],
    ['Supplier spellings left as written', (report.supplier_spellings || []).map((row) => row.join(' / '))],
    ['Pack text', (report.pack_qty_text || []).map((row) => `${row.name}: ${row.text}`)],
    ['Odd units', (report.odd_rows || []).map((row) => `${row.name}: ${row.issue}`)],
    ['Extra notes', (report.extra_cells || []).map((row) => `Row ${row.row}: ${row.text}`)],
  ]
  return `<div class="stack">${lines.map(([label, value]) => `<div class="card"><strong>${esc(label)}</strong><div class="value">${esc(value)}</div></div>`).join('')}</div>
    ${blocks.map(([title, rows]) => `<details><summary>${esc(title)} (${rows.length})</summary>${rows.slice(0, 12).map((row) => `<div class="meta">${esc(row)}</div>`).join('') || '<div class="meta">None</div>'}${rows.length > 12 ? `<div class="meta">and ${rows.length - 12} more</div>` : ''}</details>`).join('')}`
}

function fillFinish() {
  const root = document.getElementById('finish-admin')
  root.innerHTML = `
    <label class="field" for="finish-label">Name this stock take</label>
    <input id="finish-label" type="text" value="${esc(defaultLabel())}">
    <p class="help">This freezes the values, downloads a CSV, and clears the quantities. Items stay in the catalog.</p>
    <button id="ask-finish" class="primary" type="button">Finish stock take</button>
    <div id="finish-confirm" hidden>
      <p><strong>Finish now?</strong> Quantities go back to uncounted. The archive keeps today's costs.</p>
      <button id="do-finish" class="danger" type="button">Yes, finish</button>
    </div>`
  root.querySelector('#ask-finish').addEventListener('click', () => { document.getElementById('finish-confirm').hidden = false })
  root.querySelector('#do-finish').addEventListener('click', finishTake)
}

async function finishTake() {
  const label = document.getElementById('finish-label').value
  const response = await fetch('/api/stocktake/finish', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ label }) })
  const data = await response.json()
  if (response.status === 401) return loseManager()
  if (!response.ok) return flash(data.error || 'The stock take was not finished.')
  state.counts = []
  downloadText(data.filename, data.csv)
  flash('Stock take finished. The CSV downloaded.')
  await refresh()
  location.hash = '#/manage/archives'
}

async function fillArchives() {
  const response = await fetch('/api/archives', { headers: authHeaders() })
  const data = await response.json()
  const list = document.getElementById('archive-list')
  if (!response.ok) {
    list.innerHTML = `<p class="empty">${esc(data.error || 'The archives could not be loaded.')}</p>`
    return
  }
  list.innerHTML = data.archives.map((archive) => `<div class="card"><strong>${esc(archive.label)}</strong><div class="meta">${esc(archive.closed_at.slice(0, 10))} · ${archive.counted_n} counted</div><div class="value">${formatYen(archive.total_value)}</div><button type="button" data-archive="${esc(archive.id)}" data-label="${esc(archive.label)}">Download CSV</button></div>`).join('')
    || '<p class="empty">No stock take has been finished yet.</p>'
  list.querySelectorAll('[data-archive]').forEach((button) => {
    button.addEventListener('click', () => downloadArchive(button.dataset.archive, button.dataset.label))
  })
}

async function downloadArchive(id, label) {
  const response = await fetch(`/api/archives/${encodeURIComponent(id)}.csv`, { headers: authHeaders() })
  if (response.status === 401) return loseManager()
  if (!response.ok) return flash('The CSV could not be downloaded.')
  downloadText(`Dragon-Dining-${label}.csv`, await response.text())
}

async function downloadCatalog() {
  const response = await fetch('/api/catalog.csv', { headers: authHeaders() })
  if (response.status === 401) return loseManager()
  if (!response.ok) return flash('The catalog could not be downloaded.')
  downloadText('Dragon-Dining-catalog.csv', await response.text())
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function fillPinChange() {
  const root = document.getElementById('pin-change')
  root.innerHTML = `
    <div class="form-grid">
      <label class="field">Current PIN<input id="pin-old" type="password" inputmode="numeric"></label>
      <label class="field">New PIN<input id="pin-new" type="password" inputmode="numeric"></label>
    </div>
    <p class="help">Use 4 to 8 digits.</p>
    <button id="save-pin" class="primary" type="button">Change PIN</button>`
  root.querySelector('#save-pin').addEventListener('click', async () => {
    const response = await fetch('/api/pin/change', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ pin: document.getElementById('pin-old').value, new_pin: document.getElementById('pin-new').value }),
    })
    const data = await response.json()
    if (!response.ok) return flash(data.error || 'The PIN was not changed.')
    flash('PIN changed.')
  })
}

async function toggleCamera() {
  if (cameraStream) return stopCamera()
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
    flash('This browser has no camera barcode reader. The scanner still works.')
    return
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    flash('Camera permission was blocked. The scanner still works.')
    return
  }
  const video = document.getElementById('camera')
  video.hidden = false
  video.srcObject = cameraStream
  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'itf'] })
  const loop = async () => {
    if (!cameraStream) return
    try {
      const codes = await detector.detect(video)
      if (codes[0]?.rawValue) {
        const value = codes[0].rawValue
        stopCamera()
        handleScan(value)
        return
      }
    } catch { /* keep the scanner path working */ }
    requestAnimationFrame(loop)
  }
  loop()
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop())
  cameraStream = null
  const video = document.getElementById('camera')
  if (video) {
    video.hidden = true
    video.srcObject = null
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/state')
    if (!response.ok) throw new Error('status')
    const data = await response.json()
    state.rooms = data.rooms
    state.products = data.products
    state.counts = data.counts
    state.online = true
    state.loaded = true
    await idbSet('catalog', { rooms: state.rooms, products: state.products, counts: state.counts })
    await flushQueue()
  } catch {
    state.online = false
  }
  render()
}

async function boot() {
  ui.tally = localStorage.getItem('dd.tally') !== '0'
  ui.token = sessionStorage.getItem('dd.token') || ''
  const cached = await idbGet('catalog')
  const pending = await idbGet('pending')
  if (cached?.products) {
    state.rooms = cached.rooms || []
    state.products = cached.products || []
    state.counts = cached.counts || []
    state.loaded = true
  }
  if (Array.isArray(pending)) state.pending = pending
  render()
  window.addEventListener('hashchange', () => render())
  window.addEventListener('online', () => refresh())
  window.addEventListener('offline', () => {
    state.online = false
    paintStatus()
  })
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  await refresh()
}

boot()
