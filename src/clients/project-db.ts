import pg from 'pg'

/**
 * قراءة فقط من قواعد بيانات المشاريع (استعلام، فحص سجلات، مطابقة بيانات).
 * الاتصالات تُعرَّف بمتغيرات بيئة: PROJECT_DB_<الاسم>_URL — مثال PROJECT_DB_HUDOOR_URL.
 * طبقات الحماية: (١) يُنصح بدور Postgres بصلاحية SELECT فقط، (٢) الجلسة والمعاملة READ ONLY،
 * (٣) فحص نصي يرفض غير SELECT/WITH/EXPLAIN/SHOW وأكثر من جملة، (٤) مهلة وحد أقصى للصفوف،
 * (٥) حجب قيم الأعمدة الحساسة، (٦) رسائل الخطأ لا تحمل عنوان الاتصال.
 */
export const MAX_ROWS = 200
export const TIMEOUT_MS = 8000
const MAX_SQL_CHARS = 4000
const MASK = '[محجوب]'

const ENV_RE = /^PROJECT_DB_([A-Z0-9_]+)_URL$/
const SENSITIVE_COL = /pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|hash|salt|otp|cookie|session/i
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|set|reset|lock|vacuum|analyze|refresh|reindex|cluster|listen|notify|prepare|execute|merge|import|comment|security|into|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_sleep|lo_import|lo_export|dblink|set_config|pg_terminate_backend|pg_cancel_backend|nextval|setval)\b/i

export class ProjectDbError extends Error {}

export interface QueryResult { db: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; masked: string[] }
interface PoolLike {
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: any[]; fields?: { name: string }[] }>; release(): void }>
  end(): Promise<void>
}
export type PoolFactory = (url: string) => PoolLike

const defaultFactory: PoolFactory = (url) => new pg.Pool({
  connectionString: url, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5000,
  options: '-c default_transaction_read_only=on',
}) as unknown as PoolLike

/** أسماء القواعد المُعدّة (بحروف صغيرة) من البيئة — بلا قيم */
export function listProjectDbs(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => ENV_RE.test(k) && env[k]?.trim()).map((k) => k.match(ENV_RE)![1].toLowerCase()).sort()
}

/** يحذف التعليقات والنصوص الحرفية والمعرّفات المقتبسة ليُفحص هيكل الاستعلام فقط */
export function skeleton(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
}

/** يرفع ProjectDbError إن لم يكن الاستعلام قراءة بحتة بجملة واحدة */
export function assertReadOnlySql(sql: string): string {
  const raw = sql.trim().replace(/;+\s*$/, '')
  if (!raw) throw new ProjectDbError('الاستعلام فارغ.')
  if (raw.length > MAX_SQL_CHARS) throw new ProjectDbError(`الاستعلام أطول من ${MAX_SQL_CHARS} حرفاً.`)
  const s = skeleton(raw)
  if (s.includes(';')) throw new ProjectDbError('جملة واحدة فقط مسموحة.')
  if (/\/\*|\*\//.test(s)) throw new ProjectDbError('تعليق غير مغلق.')
  const first = s.trim().match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase()
  if (!first || !['select', 'with', 'explain', 'show', 'values', 'table'].includes(first)) throw new ProjectDbError('مسموح فقط بالاستعلامات القرائية (SELECT/WITH/EXPLAIN/SHOW).')
  const bad = s.match(FORBIDDEN)
  if (bad) throw new ProjectDbError(`كلمة غير مسموحة في وضع القراءة فقط: ${bad[1].toUpperCase()}.`)
  return raw
}

export class ProjectDbClient {
  private pools = new Map<string, PoolLike>()

  constructor(private env: NodeJS.ProcessEnv = process.env, private factory: PoolFactory = defaultFactory) {}

  list() { return listProjectDbs(this.env) }

  private pool(name: string): PoolLike {
    const key = name.toLowerCase()
    if (!/^[a-z0-9_]+$/.test(key)) throw new ProjectDbError('اسم قاعدة غير صالح.')
    const url = this.env[`PROJECT_DB_${key.toUpperCase()}_URL`]?.trim()
    if (!url) throw new ProjectDbError(`القاعدة "${key}" غير مُعدّة. المتاح: ${this.list().join('، ') || 'لا شيء'}.`)
    let p = this.pools.get(key)
    if (!p) { p = this.factory(url); this.pools.set(key, p) }
    return p
  }

  async query(name: string, sql: string, opts: { limit?: number } = {}): Promise<QueryResult> {
    const safe = assertReadOnlySql(sql)
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_ROWS, MAX_ROWS))
    const pool = this.pool(name)
    let client: Awaited<ReturnType<PoolLike['connect']>> | undefined
    try {
      client = await pool.connect()
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`)
      const res = await client.query(safe)
      const columns = (res.fields ?? []).map((f) => f.name)
      const masked = columns.filter((c) => SENSITIVE_COL.test(c))
      const all = res.rows ?? []
      const rows = all.slice(0, limit).map((r) => {
        const o: Record<string, unknown> = { ...r }
        for (const c of masked) if (o[c] != null) o[c] = MASK
        return o
      })
      return { db: name.toLowerCase(), columns, rows, rowCount: rows.length, truncated: all.length > limit, masked }
    } catch (e: any) {
      if (e instanceof ProjectDbError) throw e
      // رسالة مختصرة فقط — لا نصّ اتصال ولا أسرار
      throw new ProjectDbError(`فشل الاستعلام: ${String(e?.message ?? e).split('\n')[0].replace(/postgres(ql)?:\/\/\S+/gi, '[url]').slice(0, 200)}`)
    } finally {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ignore */ } client.release() }
    }
  }

  /** الجداول والأعمدة (بلا بيانات) — للاستكشاف قبل الاستعلام */
  schema(name: string) {
    return this.query(name, "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,ordinal_position")
  }

  async close() { await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => {}))); this.pools.clear() }
}
