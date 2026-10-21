import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Db } from './index.js'
import { logger } from '../logger.js'

const here = dirname(fileURLToPath(import.meta.url))

/** الجداول idempotent — تُنفّذ عند كل إقلاع بلا ضرر */
export async function migrate(db: Db) {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8')
  await db.exec(sql)
  logger.debug('تمت تهيئة الجداول')
}

if (process.argv[1]?.includes('migrate')) {
  const { loadConfig } = await import('../config.js')
  const { createDb } = await import('./index.js')
  const cfg = loadConfig()
  const db = await createDb(cfg)
  await migrate(db)
  logger.info('تمت تهيئة الجداول')
  await db.close()
  process.exit(0)
}
