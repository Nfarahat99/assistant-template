import { mkdirSync } from 'node:fs'
import { logger } from '../logger.js'

/**
 * طبقة تجريد رقيقة فوق Postgres — نفس نمط واتساب سراج.
 * محلياً  : PGlite (بوستجرس مدمج، بدون Docker)
 * ريلواي  : node-postgres عبر DATABASE_URL
 * الاثنان يتكلمان نفس SQL بحرفيته — لا استعلام يتغير عند النشر.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  close(): Promise<void>
  kind: 'pglite' | 'postgres'
}

/** يبني اتصالاً جديداً — الاختبارات تمرّر "memory://" لقاعدة معزولة في الذاكرة */
export async function createDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  if (opts.databaseUrl) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 5 })
    logger.info('قاعدة البيانات: Postgres (DATABASE_URL)')
    return {
      kind: 'postgres',
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await pool.query(sql, params as any[])).rows as T[],
      exec: async (sql: string) => { await pool.query(sql) },
      close: async () => { await pool.end() },
    }
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const dir = opts.pgliteDir || './.data/pg'
  if (!dir.startsWith('memory://')) mkdirSync(dir, { recursive: true })
  const pglite = await PGlite.create(dir)
  logger.info(`قاعدة البيانات: PGlite المدمج (${dir})`)
  return {
    kind: 'pglite',
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await pglite.query(sql, params as any[])).rows as T[],
    exec: async (sql: string) => { await pglite.exec(sql) },
    close: async () => { await pglite.close() },
  }
}
