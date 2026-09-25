function pgSql(sql) {
  let index = 0
  return sql.replace(/COLLATE NOCASE/gi, '').replace(/\?/g, () => {
    index += 1
    return `$${index}`
  })
}

export function isPg(db) {
  return db?.kind === 'pg'
}

export async function many(db, sql, params = []) {
  if (isPg(db)) return db.sql.unsafe(pgSql(sql), params)
  return db.prepare(sql).all(...params)
}

export async function one(db, sql, params = []) {
  if (isPg(db)) {
    const rows = await many(db, sql, params)
    return rows[0] ?? null
  }
  return db.prepare(sql).get(...params) ?? null
}

export async function run(db, sql, params = []) {
  if (isPg(db)) {
    const rows = await db.sql.unsafe(pgSql(sql), params)
    const id = rows[0]?.id
    return { changes: Number(rows.count ?? 0), id: id == null ? 0 : Number(id) }
  }
  if (/returning/i.test(sql)) {
    const row = db.prepare(sql).get(...params)
    return { changes: row ? 1 : 0, id: row?.id == null ? 0 : Number(row.id) }
  }
  const info = db.prepare(sql).run(...params)
  return { changes: Number(info.changes || 0), id: Number(info.lastInsertRowid || 0) }
}

export async function transaction(db, fn) {
  if (isPg(db)) return db.sql.begin(async (tx) => fn({ kind: 'pg', sql: tx }))
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = await fn(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already closed */ }
    throw error
  }
}
