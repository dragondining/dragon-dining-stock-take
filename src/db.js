import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashPin, newSalt, newSecret } from './auth.js'
import { one, run, transaction } from './query.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  external_id TEXT,
  import_fingerprint TEXT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  source TEXT,
  name TEXT NOT NULL,
  stock_unit TEXT,
  pack_qty REAL,
  pack_qty_note TEXT,
  item_size TEXT,
  uom TEXT,
  unit_cost_yen INTEGER,
  unit_price_yen INTEGER,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS products_external_id
  ON products(external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS products_fingerprint
  ON products(import_fingerprint) WHERE import_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS products_room ON products(room_id);

CREATE TABLE IF NOT EXISTS barcodes (
  code TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS barcodes_product ON barcodes(product_id);

CREATE TABLE IF NOT EXISTS counts (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  counted_room_id INTEGER REFERENCES rooms(id),
  qty REAL NOT NULL,
  is_exception INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  device_id TEXT
);

CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  total_value INTEGER NOT NULL,
  counted_n INTEGER NOT NULL,
  product_n INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_reports (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  filename TEXT,
  report_json TEXT NOT NULL
);
`

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

export async function prepareDatabase(db) {
  await ensurePin(db)
  return db
}

async function ensurePin(db) {
  if (!await getSetting(db, 'pin_salt')) await setSetting(db, 'pin_salt', newSalt())
  if (!await getSetting(db, 'pin_hash')) await setSetting(db, 'pin_hash', hashPin('1234', await getSetting(db, 'pin_salt')))
  if (!await getSetting(db, 'token_secret')) await setSetting(db, 'token_secret', newSecret())
}

export async function getSetting(db, key) {
  const row = await one(db, 'SELECT value FROM settings WHERE key = ?', [key])
  return row ? row.value : null
}

export async function setSetting(db, key, value) {
  await run(db, `
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, value])
}

export function withTransaction(db, fn) {
  return transaction(db, fn)
}
