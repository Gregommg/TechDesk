import pg from 'pg'
import fs from 'node:fs'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
export type Q = pg.Pool | pg.PoolClient

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}
export async function migrate() {
  await pool.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
}
