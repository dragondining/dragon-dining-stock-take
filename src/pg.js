import postgres from 'postgres'

export function openPostgres() {
  const url = String(process.env.SUPABASE_DB_URL || '').trim().replace(/^['"]|['"]$/g, '')
  if (!url) {
    const error = new Error('SUPABASE_DB_URL is not set on Vercel. Add it, then redeploy.')
    error.status = 500
    throw error
  }
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes('pooler.supabase.com')) {
      const error = new Error('SUPABASE_DB_URL must be the Session pooler string. Its host ends in pooler.supabase.com and the port is 5432.')
      error.status = 500
      throw error
    }
  } catch (error) {
    if (error.status) throw error
    const invalid = new Error('SUPABASE_DB_URL is not a valid connection string. Replace [YOUR-PASSWORD] with the database password. If the password contains @ # or &, encode that character, then redeploy.')
    invalid.status = 500
    throw invalid
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
