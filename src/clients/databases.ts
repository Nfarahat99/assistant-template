import pg from 'pg'
import { z } from 'zod'
import { skeleton } from './project-db.js'
import { bestMatches } from '../lib/arabic.js'
import { logger } from '../logger.js'
import { arabicSearchSql } from '../lib/sql-arabic.js'

/**
 * الوصول لقواعد بيانات مشاريع المالك (Postgres على Railway عبر عدة مشاريع).
 * المصدر: DB_CONNECTIONS = JSON [{key, name_ar, aliases, project, url, deny_tables}]
 * عنوان واحد بحساب المالك (لا دور قراءة فقط) ← الحماية كلها في الكود:
 *  - القراءة: حارس جملة SELECT واحدة + BEGIN TRANSACTION READ ONLY + مهلة ١٠ث + ROLLBACK دائماً
 *  - الكتابة: INSERT/UPDATE/DELETE فقط، تجربة ثم ROLLBACK للمعاينة، والتنفيذ بعد "نعم N" صريحة
 *  - deny_tables: جداول لا تُقرأ ولا تُكتب ولا تظهر في المخطط (مفاتيح وجلسات بوابة واتساب مثلاً)
 * لا تُطبع عناوين الاتصال أبداً (لا في السجلات ولا في رسائل الخطأ).
 */
export const MAX_READ_ROWS = 50
export const PREVIEW_ROWS = 5
export const MAX_WRITE_ROWS = 500
export const STATEMENT_TIMEOUT = '10s'
const SCHEMA_TTL_MS = 10 * 60_000
/** أسماء أنواع أقصر لتقليل حجم المخطط بدل اقتطاعه */
const TYPE_ABBR: Record<string, string> = {
  'character varying': 'varchar', 'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  'time without time zone': 'time', 'time with time zone': 'timetz', 'double precision': 'float8',
}
const MAX_SQL_CHARS = 4000
export const MASK = '•••'

/** أعمدة حساسة: قيمها لا تظهر للمالك ولا للنموذج */
export const SENSITIVE_COL = /pass|hash|token|secret|otp|key|cred|session/i

/**
 * دوال وكتالوجات خطرة بحساب superuser (بعضها يعمل حتى داخل READ ONLY): تغيير إعدادات، large objects،
 * اتصال خارجي، SQL ديناميكي داخل نص (…_to_xml)، عيّنات بيانات الأعمدة (pg_stats)، وكلمات المرور.
 * دوال pg_…( كلها مرفوضة إلا قائمة السماح أدناه (pg_read_file، pg_terminate_backend، pg_sleep…).
 */
const DANGEROUS = String.raw`set_config|current_setting|lo_\w+|dblink\w*|\w+_to_xml\w*|pg_stats\w*|pg_shadow|pg_authid|pg_user_mappings?|pg_hba_file_rules|pg_file_settings|nextval|setval`
/** القراءة: جملة SELECT واحدة — أي كلمة كتابة أو قفل أو دالة ذات أثر = رفض */
const READ_FORBIDDEN = new RegExp(String.raw`\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|copy|call|into|lock|share|vacuum|analyze|reindex|cluster|refresh|listen|notify|prepare|execute|${DANGEROUS})\b`, 'i')
/** الكتابة: INSERT/UPDATE/DELETE فقط — لا DDL ولا صلاحيات ولا CTE (تمنع DML متعدد) */
const WRITE_FORBIDDEN = new RegExp(String.raw`\b(drop|alter|create|grant|revoke|truncate|copy|call|execute|prepare|vacuum|analyze|reindex|cluster|refresh|lock|listen|notify|with|${DANGEROUS})\b`, 'i')
/** دوال pg_* المسموحة (أحجام وأنواع فقط) */
const PG_FN_ALLOWED = new Set(['pg_size_pretty', 'pg_total_relation_size', 'pg_relation_size', 'pg_table_size', 'pg_indexes_size', 'pg_database_size', 'pg_typeof'])

export class DbAccessError extends Error {}

const ConnSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name_ar: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  project: z.string().trim().default(''),
  /**
   * postgres: اتصال مباشر (url = postgres://…).
   * http: قاعدة بلا منفذ خارجي (SQLite على قرص التطبيق مثلاً) — url = https://<app>/api/internal،
   * والتطبيق يكشف POST /readonly-sql و GET /schema بتوكن من متغير البوت token_env.
   * الحارس والحجب وحد الصفوف والسجل هنا كما هي، ثم يُمرَّر SQL للتطبيق (طبقة قراءة فقط ثانية هناك).
   */
  kind: z.enum(['postgres', 'http']).default('postgres'),
  url: z.string().trim().min(1),
  token_env: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,60}$/).optional(),
  /** http: أي قاعدة داخل التطبيق (platform أو اسم مدرسة مثلاً) — بلا قيمة = الافتراضية */
  target: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,60}$/).optional(),
  /** لهجة SQL للنموذج — http افتراضياً sqlite */
  dialect: z.enum(['postgres', 'sqlite']).optional(),
  deny_tables: z.array(z.string().trim().min(1)).default([]),
}).superRefine((c, ctx) => {
  if (c.kind !== 'http') return
  if (!/^https:\/\/[^\s/]+/i.test(c.url)) ctx.addIssue({ code: 'custom', message: 'http: url لازم https://' })
  if (!c.token_env) ctx.addIssue({ code: 'custom', message: 'http: token_env مطلوب' })
})
export type DbConn = z.infer<typeof ConnSchema>
export type SqlDialect = 'postgres' | 'sqlite'
/** ما يُعرض خارج هذه الوحدة — بلا عناوين */
export interface DbInfo { key: string; name_ar: string; project: string; aliases: string[]; kind?: 'postgres' | 'http'; dialect?: SqlDialect }

export const HTTP_TIMEOUT_MS = 15_000
const dialectOf = (c: DbConn): SqlDialect => c.dialect ?? (c.kind === 'http' ? 'sqlite' : 'postgres')

interface QueryRes { rows: any[]; fields?: { name: string; tableID?: number; columnID?: number }[] }
export interface PoolLike {
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<QueryRes>; release(): void }>
  end(): Promise<void>
}
export type PoolFactory = (url: string) => PoolLike

const defaultFactory: PoolFactory = (url) => new pg.Pool({
  connectionString: url, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8000,
  ssl: { rejectUnauthorized: false },
}) as unknown as PoolLike

/** يقرأ DB_CONNECTIONS — المدخل التالف يُتجاهل مع تحذير بلا قيم */
export function parseDbConnections(raw: string | undefined): DbConn[] {
  if (!raw?.trim()) return []
  let arr: unknown
  try { arr = JSON.parse(raw) } catch { logger.warn('DB_CONNECTIONS ليس JSON صالحاً — تجاهل'); return [] }
  if (!Array.isArray(arr)) { logger.warn('DB_CONNECTIONS لازم يكون مصفوفة — تجاهل'); return [] }
  const out: DbConn[] = []
  for (const [i, x] of arr.entries()) {
    const r = ConnSchema.safeParse(x)
    if (r.success && !out.some((c) => c.key === r.data.key)) out.push(r.data)
    else logger.warn({ index: i, key: (x as any)?.key }, 'مدخل غير صالح أو مكرر في DB_CONNECTIONS — تجاهل')
  }
  return out
}

// ═════════════ الحراسة ═════════════

function prep(sql: string): { raw: string; s: string } {
  const raw = sql.trim().replace(/;+\s*$/, '').trim()
  if (!raw) throw new DbAccessError('الاستعلام فاضي.')
  if (raw.length > MAX_SQL_CHARS) throw new DbAccessError(`الاستعلام أطول من ${MAX_SQL_CHARS} حرف.`)
  const s = skeleton(raw)
  if (s.includes(';')) throw new DbAccessError('مسموح جملة وحدة بس (بدون ; تسلسل جمل).')
  if (/\/\*|\*\//.test(s) || /\$[A-Za-z_]*\$/.test(s) || /'/.test(s.replace(/''/g, ''))) throw new DbAccessError('فيه تعليق أو نص غير مغلق.')
  return { raw, s }
}

const firstWord = (s: string) => s.trim().match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase()

/** أول دالة pg_…( خارج قائمة السماح */
function dangerousPgFn(s: string): string | null {
  for (const m of s.matchAll(/\b(pg_\w+)\s*\(/gi)) if (!PG_FN_ALLOWED.has(m[1].toLowerCase())) return m[1]
  return null
}

/**
 * جدول محظور مذكور في أي مكان — يُفحص النص الخام لا الهيكل،
 * فـ "auth_creds" (معرّف مقتبس) و'auth_creds' (نص لدالة ديناميكية) مرفوضان كلاهما.
 */
export function deniedTableIn(sql: string, deny: string[]): string | null {
  for (const t of deny) {
    const name = t.split('.').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i').test(sql)) return t
  }
  return null
}

/** الفحوص المشتركة بعد تحديد نوع الجملة */
function assertCommon(raw: string, s: string, forbidden: RegExp, deny: string[], what: string) {
  const bad = s.match(forbidden)
  if (bad) throw new DbAccessError(`كلمة ممنوعة في ${what}: ${bad[1].toUpperCase()}.`)
  const fn = dangerousPgFn(s)
  if (fn) throw new DbAccessError(`دالة ممنوعة: ${fn}.`)
  const denied = deniedTableIn(raw, deny)
  if (denied) throw new DbAccessError(`الجدول ${denied} محظور — ما ألمسه.`)
}

/** قراءة فقط: SELECT أو WITH…SELECT بجملة واحدة — يرجع النص بعد تطبيع الأرقام */
/** SQLite: ATTACH/PRAGMA/load_extension… خارج حارس Postgres — تُرفض هنا قبل الإرسال */
const SQLITE_FORBIDDEN = /\b(attach|detach|pragma|load_extension|savepoint|release|begin|commit|rollback)\b/i
export function assertSqliteSelect(sql: string, deny: string[] = []): string {
  const safe = assertSelectOnly(sql, deny)
  const bad = skeleton(safe).match(SQLITE_FORBIDDEN)
  if (bad) throw new DbAccessError(`كلمة ممنوعة في القراءة: ${bad[1].toUpperCase()}.`)
  if (/--|\/\*/.test(withoutLiterals(safe))) throw new DbAccessError('التعليقات غير مسموحة هنا.')
  return safe
}

/** النص بلا القيم الحرفية '…' فقط — المعرّفات "…" و[…] و`…` تبقى (هي أسماء أعمدة في SQLite) */
export const withoutLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''")

/**
 * عمود حساس (غير المعرّفات …_id) يذكره الاستعلام. عبر HTTP لا نعرف اسم العمود الأصلي بعد AS،
 * فالحجب بالاسم وحده يُلتف عليه — لذا مجرد ذكر العمود الحساس مرفوض.
 */
export function sensitiveColumnRef(sql: string, tables: SchemaTable[]): string | null {
  for (const t of tables) for (const c of t.columns) {
    if (!SENSITIVE_COL.test(c.name) || /(^|_)id$/i.test(c.name)) continue
    const name = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i').test(sql)) return c.name
  }
  return null
}

export function assertSelectOnly(sql: string, deny: string[] = []): string {
  const { raw, s } = prep(normalizeSqlDigits(sql))
  const first = firstWord(s)
  if (first !== 'select' && first !== 'with') throw new DbAccessError('مسموح بس SELECT (أو WITH … SELECT) في القراءة.')
  assertCommon(raw, s, READ_FORBIDDEN, deny, 'القراءة')
  return raw
}

export interface WriteSql { sql: string; verb: 'insert' | 'update' | 'delete'; hasWhere: boolean; returning: boolean }

/** كتابة: INSERT/UPDATE/DELETE بجملة واحدة — لا DROP/TRUNCATE/ALTER/CREATE/GRANT ولا CTE */
export function assertWriteSql(sql: string, deny: string[] = []): WriteSql {
  const { raw, s } = prep(normalizeSqlDigits(sql))
  const verb = firstWord(s)
  if (verb !== 'insert' && verb !== 'update' && verb !== 'delete') throw new DbAccessError('التعديل مسموح بس INSERT أو UPDATE أو DELETE.')
  assertCommon(raw, s, WRITE_FORBIDDEN, deny, 'التعديل')
  return { sql: raw, verb, hasWhere: verb === 'insert' || /\bwhere\b/i.test(s), returning: /\breturning\b/i.test(s) }
}

/**
 * الأرقام العربية داخل النصوص الحرفية ← لاتينية ('١٢٣' ← '123').
 * خريطة translate('٠١٢٣٤٥٦٧٨٩') بالضبط تبقى كما هي لأنها مقصودة للمقارنة.
 */
export function normalizeSqlDigits(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (lit) => {
    if (lit === "'٠١٢٣٤٥٦٧٨٩'" || lit === "'۰۱۲۳۴۵۶۷۸۹'") return lit
    return lit.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
  })
}

// ═════════════ الحجب والعرض ═════════════

/** الأعمدة المحجوبة: بالاسم الظاهر أو باسم العمود الأصلي (يغلق الالتفاف بـ AS) */
export function maskedColumns(columns: string[], sourceNames: Record<string, string> = {}): string[] {
  return columns.filter((c) => SENSITIVE_COL.test(c) || SENSITIVE_COL.test(sourceNames[c] ?? ''))
}

export function maskRows(rows: Record<string, unknown>[], masked: string[]): Record<string, unknown>[] {
  if (!masked.length) return rows
  return rows.map((r) => {
    const o = { ...r }
    for (const c of masked) if (c in o) o[c] = MASK
    return o
  })
}

export function cellText(v: unknown, max = 40): string {
  let s: string
  if (v == null) s = '—'
  else if (v instanceof Date) s = v.toISOString().replace('T', ' ').slice(0, 16)
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** جدول مختصر يناسب تيليجرام/واتساب (نص عادي) */
export function formatTable(columns: string[], rows: Record<string, unknown>[], maxRows = 15): string {
  if (!rows.length) return '(ما فيه نتائج)'
  // صف واحد بأعمدة كثيرة ← عرض عمودي أوضح
  if (rows.length === 1 && columns.length > 3) {
    return columns.slice(0, 20).map((c) => `• ${c}: ${cellText(rows[0][c], 60)}`).join('\n')
  }
  const cols = columns.slice(0, 6)
  const lines = [cols.join(' | ')]
  for (const r of rows.slice(0, maxRows)) lines.push(cols.map((c) => cellText(r[c], 28)).join(' | '))
  if (rows.length > maxRows) lines.push(`… و${rows.length - maxRows} صف ثاني`)
  if (columns.length > cols.length) lines.push(`(+${columns.length - cols.length} عمود ما عرضته)`)
  return lines.join('\n')
}

/** رسالة خطأ مختصرة بلا عنوان اتصال */
export function safeError(e: unknown): string {
  return String((e as any)?.message ?? e).split('\n')[0].replace(/(postgres(ql)?|https?):\/\/\S+/gi, '[url]').slice(0, 200)
}

// ═════════════ السجل ═════════════

export interface ReadResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; masked: string[]; sql: string }
export interface WritePreview { count: number; columns: string[]; rows: Record<string, unknown>[]; masked: string[]; sql: string; hasWhere: boolean }

export interface SchemaTable { table: string; columns: { name: string; type: string }[] }

export class DatabaseRegistry {
  private pools = new Map<string, PoolLike>()
  private schemaCache = new Map<string, { at: number; text: string; tables: SchemaTable[] }>()

  private fetchImpl: typeof fetch
  private env: NodeJS.ProcessEnv

  constructor(private conns: DbConn[], private factory: PoolFactory = defaultFactory, private clock: () => number = Date.now,
    http: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
    this.fetchImpl = http.fetch ?? ((input, init) => fetch(input, init))
    this.env = http.env ?? process.env
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, factory?: PoolFactory): DatabaseRegistry {
    return new DatabaseRegistry(parseDbConnections(env.DB_CONNECTIONS), factory, undefined, { env })
  }

  list(): DbInfo[] {
    return this.conns.map((c) => ({ key: c.key, name_ar: c.name_ar, project: c.project, aliases: c.aliases, kind: c.kind, dialect: dialectOf(c) }))
  }

  info(key: string): DbInfo | null { return this.list().find((d) => d.key === key) ?? null }

  /** بالمفتاح أو الاسم العربي أو الأسماء البديلة أو اسم مشروع Railway — أكثر من نتيجة = اسأل */
  resolve(query: string | undefined): DbInfo[] {
    const all = this.list()
    if (!query?.trim()) return all.length === 1 ? all : []
    const exact = all.filter((d) => d.key.toLowerCase() === query.trim().toLowerCase())
    if (exact.length) return exact
    return bestMatches(query, all.map((d) => ({ d, names: [d.key, d.name_ar, d.project, ...d.aliases].filter(Boolean) }))).map((x) => x.d)
  }

  private conn(key: string): DbConn {
    const c = this.conns.find((x) => x.key === key)
    if (!c) throw new DbAccessError(`القاعدة «${key}» غير معرّفة.`)
    return c
  }

  private pool(key: string): PoolLike {
    const c = this.conn(key)
    let p = this.pools.get(key)
    if (!p) { p = this.factory(c.url); this.pools.set(key, p) }
    return p
  }

  private deny(key: string): string[] { return this.conn(key).deny_tables }

  /**
   * يشغّل fn داخل معاملة بمهلة — ROLLBACK افتراضياً ما لم تُرجع fn commit=true.
   * ro: BEGIN TRANSACTION READ ONLY — Postgres نفسه يرفض أي كتابة ولا يُسمح بـ commit.
   */
  private async tx<T>(key: string, mode: 'ro' | 'rw', fn: (q: (sql: string, params?: unknown[]) => Promise<QueryRes>) => Promise<{ value: T; commit?: boolean }>): Promise<T> {
    const pool = this.pool(key)
    let client: Awaited<ReturnType<PoolLike['connect']>> | undefined
    let done = false
    try {
      client = await pool.connect()
      const cl = client
      await cl.query(mode === 'ro' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
      await cl.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      const r = await fn((sql, params) => cl.query(sql, params))
      if (r.commit && mode === 'rw') { await cl.query('COMMIT'); done = true }
      return r.value
    } catch (e) {
      if (e instanceof DbAccessError) throw e
      throw new DbAccessError(safeError(e))
    } finally {
      if (client) {
        if (!done) { try { await client.query('ROLLBACK') } catch { /* ignore */ } }
        client.release()
      }
    }
  }

  /** الجداول والأعمدة (بلا بيانات) للنموذج — مخزّنة ١٠ دقائق */
  async schema(key: string): Promise<string> {
    return (await this.schemaEntry(key)).text
  }

  /** نفس المخطط منظّماً (بوابة CI): [{table, columns:[{name,type}]}] — بلا الجداول المحظورة */
  async schemaTables(key: string): Promise<SchemaTable[]> {
    return (await this.schemaEntry(key)).tables
  }

  private async schemaEntry(key: string): Promise<{ at: number; text: string; tables: SchemaTable[] }> {
    const hit = this.schemaCache.get(key)
    if (hit && this.clock() - hit.at < SCHEMA_TTL_MS) return hit
    if (this.conn(key).kind === 'http') return this.httpSchemaEntry(key)
    const rows = await this.tx(key, 'ro', async (q) => ({
      value: (await q(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg\\_%'
        ORDER BY table_schema, table_name, ordinal_position`)).rows,
    }))
    const tables = new Map<string, { name: string; type: string }[]>()
    const deny = this.deny(key).map((d) => d.toLowerCase())
    for (const r of rows) {
      // الجداول المحظورة لا تظهر للنموذج إطلاقاً
      if (deny.includes(String(r.table_name).toLowerCase()) || deny.includes(`${r.table_schema}.${r.table_name}`.toLowerCase())) continue
      const t = r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`
      tables.set(t, [...(tables.get(t) ?? []), { name: r.column_name, type: TYPE_ABBR[r.data_type] ?? r.data_type }])
    }
    // المخطط كاملاً بلا اقتطاع — الدقة في كتابة SQL أهم من الحجم
    const text = [...tables.entries()].map(([t, cols]) => `${t}(${cols.map((c) => `${c.name} ${c.type}`).join(', ')})`).join('\n')
    const entry = { at: this.clock(), text, tables: [...tables.entries()].map(([table, columns]) => ({ table, columns })) }
    this.schemaCache.set(key, entry)
    return entry
  }

  /** أسماء الأعمدة الأصلية للحقول القادمة من جداول (tableID/columnID) — لكشف الالتفاف بـ AS */
  private async sourceNames(q: (sql: string, params?: unknown[]) => Promise<QueryRes>, fields: QueryRes['fields']): Promise<Record<string, string>> {
    const withSrc = (fields ?? []).filter((f) => f.tableID && f.columnID)
    if (!withSrc.length) return {}
    try {
      const res = await q('SELECT attrelid::bigint AS t, attnum::int AS c, attname FROM pg_attribute WHERE attrelid = ANY($1::oid[])',
        [[...new Set(withSrc.map((f) => f.tableID))]])
      const out: Record<string, string> = {}
      for (const f of withSrc) {
        const a = res.rows.find((r) => Number(r.t) === f.tableID && Number(r.c) === f.columnID)
        if (a) out[f.name] = a.attname
      }
      return out
    } catch { return {} }
  }

  /** قراءة: حارس SELECT ← معاملة READ ONLY، مهلة ١٠ث، حد ٥٠ صفاً، وحجب الحساس */
  async query(key: string, sql: string): Promise<ReadResult> {
    if (this.conn(key).kind === 'http') return this.httpQuery(key, sql)
    const safe = assertSelectOnly(sql, this.deny(key))
    // سطر جديد قبل القوس: تعليق "--" في آخر الاستعلام لا يبلع الإغلاق
    const wrap = (s: string) => `SELECT * FROM (\n${s}\n) AS _meem_q LIMIT ${MAX_READ_ROWS + 1}`
    // بحث النصوص العربية: الطرفان يُطبَّعان في الكود (ة/ه، ى/ي، الهمزات، التشكيل، المسافات) — وإن فشلت الصياغة نرجع للأصل
    const norm = arabicSearchSql(safe)
    if (norm !== safe) {
      try { return await this.readTx(key, wrap(assertSelectOnly(norm, this.deny(key))), norm) } catch { /* الأصل أدناه */ }
    }
    return this.readTx(key, wrap(safe), safe)
  }

  /**
   * الطبقة الثانية (بلا حارس نصي): معاملة READ ONLY ترفض أي كتابة حتى لو فات شيء من الحارس،
   * والنهاية ROLLBACK دائماً. لا تُستدعى إلا من query() — والاختبار يستدعيها مباشرة ليثبت ذلك.
   */
  private readTx(key: string, runSql: string, shownSql: string): Promise<ReadResult> {
    return this.tx(key, 'ro', async (q) => {
      const res = await q(runSql)
      const columns = (res.fields ?? []).map((f) => f.name)
      const cols = columns.length ? columns : Object.keys(res.rows[0] ?? {})
      const masked = maskedColumns(cols, await this.sourceNames(q, res.fields))
      const all = res.rows ?? []
      const rows = maskRows(all.slice(0, MAX_READ_ROWS), masked)
      return { value: { columns: cols, rows, rowCount: rows.length, truncated: all.length > MAX_READ_ROWS, masked, sql: shownSql } }
    })
  }

  private static withReturning(w: WriteSql): string {
    return w.returning ? w.sql : `${w.sql}\nRETURNING *`
  }

  /** تجربة داخل معاملة ثم ROLLBACK دائماً: عدد الصفوف المتأثرة + أول ٥ منها (محجوبة) */
  async previewWrite(key: string, sql: string): Promise<WritePreview> {
    this.assertWritable(key)
    const w = assertWriteSql(sql, this.deny(key))
    return this.tx(key, 'rw', async (q) => {
      const res = await q(DatabaseRegistry.withReturning(w))
      const columns = (res.fields ?? []).map((f) => f.name)
      const cols = columns.length ? columns : Object.keys(res.rows[0] ?? {})
      const masked = maskedColumns(cols, await this.sourceNames(q, res.fields))
      return { value: { count: res.rows.length, columns: cols, rows: maskRows(res.rows.slice(0, PREVIEW_ROWS), masked), masked, sql: w.sql, hasWhere: w.hasWhere }, commit: false }
    })
  }

  /** التنفيذ بعد الموافقة: لو تغيّر العدد عن المعاينة ← ROLLBACK ولا شيء يتغير */
  async executeWrite(key: string, sql: string, expected: number): Promise<{ applied: boolean; count: number }> {
    this.assertWritable(key)
    const w = assertWriteSql(sql, this.deny(key))
    return this.tx<{ applied: boolean; count: number }>(key, 'rw', async (q) => {
      const res = await q(DatabaseRegistry.withReturning(w))
      const count = res.rows.length
      const applied = count === expected
      return { value: { applied, count }, commit: applied }
    })
  }

  // ═════════════ http: قاعدة خلف مسار قراءة في التطبيق ═════════════

  private assertWritable(key: string) {
    const c = this.conn(key)
    if (c.kind === 'http') throw new DbAccessError(`قاعدة ${c.name_ar} للقراءة فقط (عبر مسار التطبيق) — التعديل غير متاح.`)
  }

  /** طلب للتطبيق بتوكن token_env — بلا تحويلات، بمهلة، والأخطاء بلا عناوين ولا توكن */
  private async http(key: string, path: 'schema' | 'readonly-sql', body?: Record<string, unknown>): Promise<any> {
    const c = this.conn(key)
    const token = c.token_env ? this.env[c.token_env]?.trim() : ''
    if (!token) throw new DbAccessError(`متغير ${c.token_env ?? 'token_env'} ناقص في البوت — ما أقدر أوصل لقاعدة ${c.name_ar}.`)
    const base = c.url.replace(/\/+$/, '')
    const url = path === 'schema' ? `${base}/schema${c.target ? `?db=${encodeURIComponent(c.target)}` : ''}` : `${base}/readonly-sql`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) { throw new DbAccessError(`تعذّر الاتصال بقاعدة ${c.name_ar}: ${safeError(e)}`) }
    let j: any = null
    try { j = await res.json() } catch { /* ليس JSON */ }
    if (!res.ok) {
      const why = res.status === 404 ? 'مسار القراءة غير مفعّل في التطبيق (توكن القراءة غير مضبوط هناك أو النسخة قديمة)'
        : res.status === 401 ? 'التطبيق رفض توكن القراءة'
          : typeof j?.error === 'string' ? j.error : `HTTP ${res.status}`
      throw new DbAccessError(safeError(why))
    }
    if (!j || typeof j !== 'object') throw new DbAccessError(`رد غير صالح من قاعدة ${c.name_ar}.`)
    return j
  }

  private async httpSchemaEntry(key: string): Promise<{ at: number; text: string; tables: SchemaTable[] }> {
    const j = await this.http(key, 'schema')
    const deny = this.deny(key).map((d) => d.toLowerCase())
    const tables: SchemaTable[] = (Array.isArray(j.tables) ? j.tables : [])
      .filter((t: any) => typeof t?.table === 'string' && !deny.includes(t.table.toLowerCase()))
      .map((t: any) => ({ table: t.table, columns: (Array.isArray(t.columns) ? t.columns : []).map((x: any) => ({ name: String(x?.name), type: String(x?.type ?? '') })) }))
    const text = tables.map((t) => `${t.table}(${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')})`).join('\n')
    const entry = { at: this.clock(), text, tables }
    this.schemaCache.set(key, entry)
    return entry
  }

  /** نفس الحارس + حارس SQLite + منع ذكر الأعمدة الحساسة ← التطبيق ← حد ٥٠ وحجب بالاسم */
  private async httpQuery(key: string, sql: string): Promise<ReadResult> {
    const c = this.conn(key)
    const safe = assertSqliteSelect(sql, c.deny_tables)
    const hit = sensitiveColumnRef(withoutLiterals(safe), await this.schemaTables(key))
    if (hit) throw new DbAccessError(`العمود ${hit} حساس — ما أقرأه.`)
    const j = await this.http(key, 'readonly-sql', { sql: `SELECT * FROM (\n${safe}\n) AS _meem_q LIMIT ${MAX_READ_ROWS + 1}`, ...(c.target ? { db: c.target } : {}) })
    const all: Record<string, unknown>[] = Array.isArray(j.rows) ? j.rows.filter((r: unknown) => r && typeof r === 'object') : []
    const cols: string[] = Array.isArray(j.columns) ? j.columns.map(String) : Object.keys(all[0] ?? {})
    const masked = maskedColumns(cols)
    const rows = maskRows(all.slice(0, MAX_READ_ROWS), masked)
    return { columns: cols, rows, rowCount: rows.length, truncated: all.length > MAX_READ_ROWS || j.truncated === true, masked, sql: safe }
  }

  async close() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => {})))
    this.pools.clear()
  }
}
