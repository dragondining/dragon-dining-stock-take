import postgres from 'postgres'

export function openPostgres() {
  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    const error = new Error('SUPABASE_DB_URL is not set.')
    error.status = 500
    throw error
  }
  if (!globalThis.__dragonDiningSql) {
    globalThis.__dragonDiningSql = postgres(url, {
      ssl: 'require',
      max: 1,
      prepare: false,
    })
  }
  return { kind: 'pg', sql: globalThis.__dragonDiningSql }
}
