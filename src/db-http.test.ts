/**
 * قواعد kind:"http" (SQLite خلف مسار قراءة في التطبيق — تحضير سراج): نفس الحارس والحجب وحد الصفوف هنا،
 * ثم SQL للتطبيق. لا كتابة. والتوكن من متغير البوت فقط ولا يظهر في الأخطاء.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseRegistry, DbAccessError, MASK, MAX_READ_ROWS, assertSqliteSelect, parseDbConnections, safeError, sensitiveColumnRef,
  withoutLiterals,
} from './clients/databases.js'
import { buildCiScopes, CiGateway, ciToken } from './ci-gateway.js'
import { TEST_CI_SCOPES } from './test-profile.js'
import { sqlUserPrompt, SQLITE_DIALECT_NOTE } from './ai/dbsql.js'

const TOKEN = 'tok_' + 'x'.repeat(40)
const SCHEMA = {
  tables: [
    { table: 'students', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }, { name: 'national_id', type: 'TEXT' }] },
    { table: 'users', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'email', type: 'TEXT' }, { name: 'password_hash', type: 'TEXT' }, { name: 'session_id', type: 'TEXT' }] },
    { table: 'wa_sessions', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'blob', type: 'TEXT' }] },
  ],
}
const conn = (over: Record<string, unknown> = {}) => ({
  key: 'hudoor', name_ar: 'تحضير سراج', aliases: ['تحضير'], project: 'hudoor-attendance', kind: 'http',
  url: 'https://app.example.com/api/internal/', token_env: 'HUDOOR_READ_TOKEN', deny_tables: ['wa_sessions'], ...over,
})

interface Call { url: string; method: string; auth: string | null; body: any; redirect?: string }
function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = []
  const f = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null, redirect: init.redirect }
    calls.push(c)
    const r = respond(c)
    return new Response(r.json === undefined ? 'nope' : JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { f, calls }
}
const appOk = (rows: Record<string, unknown>[], columns?: string[]) => (c: Call) =>
  c.url.endsWith('/schema') || c.url.includes('/schema?') ? { json: SCHEMA } : { json: { columns: columns ?? Object.keys(rows[0] ?? {}), rows, truncated: false } }

const reg = (respond: (c: Call) => { status?: number; json?: unknown }, over: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = { HUDOOR_READ_TOKEN: TOKEN }) => {
  const { f, calls } = fakeFetch(respond)
  const r = new DatabaseRegistry(parseDbConnections(JSON.stringify([conn(over)])), undefined, undefined, { fetch: f, env })
  return { r, calls }
}

test('DB_CONNECTIONS: http يتطلب https و token_env — والقديم (postgres) بلا تغيير', () => {
  assert.equal(parseDbConnections(JSON.stringify([conn()]))[0].kind, 'http')
  assert.equal(parseDbConnections(JSON.stringify([conn({ url: 'http://app.example.com/api/internal' })])).length, 0)
  assert.equal(parseDbConnections(JSON.stringify([conn({ token_env: undefined })])).length, 0)
  assert.equal(parseDbConnections(JSON.stringify([conn({ target: '../x' })])).length, 0)
  const pg = parseDbConnections(JSON.stringify([{ key: 'falak', name_ar: 'نبراس', url: 'postgres://u:p@h/db' }]))[0]
  assert.equal(pg.kind, 'postgres')
  const { r } = reg(appOk([]))
  assert.deepEqual(r.list()[0], { key: 'hudoor', name_ar: 'تحضير سراج', project: 'hudoor-attendance', aliases: ['تحضير'], kind: 'http', dialect: 'sqlite' })
})

test('حارس SQLite: يرفض ATTACH/PRAGMA/load_extension/التعليقات والكتابة وتسلسل الجمل', () => {
  for (const bad of [
    "ATTACH DATABASE '/tmp/x' AS x", 'SELECT 1; ATTACH x', 'SELECT * FROM students WHERE pragma = 1', 'PRAGMA query_only=0',
    "SELECT load_extension('x')", 'SELECT 1 -- c', 'SELECT 1 /* c */', 'DELETE FROM students', 'WITH d AS (SELECT 1) DELETE FROM students',
    'SELECT 1; SELECT 2', 'SELECT * FROM wa_sessions',
  ]) assert.throws(() => assertSqliteSelect(bad, ['wa_sessions']), DbAccessError, bad)
  assert.ok(assertSqliteSelect("SELECT name FROM students WHERE lower(name) LIKE '%attach; pragma%'"))
  assert.ok(assertSqliteSelect("SELECT name FROM pragma_table_info('students')"))
})

test('الأعمدة الحساسة: ذكرها مرفوض (حتى مقتبسة أو بين []) — المعرّفات …_id مسموحة', () => {
  const t = SCHEMA.tables
  assert.equal(sensitiveColumnRef(withoutLiterals('SELECT password_hash AS x FROM users'), t), 'password_hash')
  assert.equal(sensitiveColumnRef(withoutLiterals('SELECT "password_hash" FROM users'), t), 'password_hash')
  assert.equal(sensitiveColumnRef(withoutLiterals('SELECT [password_hash] FROM users'), t), 'password_hash')
  assert.equal(sensitiveColumnRef(withoutLiterals('SELECT substr(password_hash,1,9) FROM users'), t), 'password_hash')
  assert.equal(sensitiveColumnRef(withoutLiterals("SELECT email FROM users WHERE email = 'password_hash'"), t), null)
  assert.equal(sensitiveColumnRef(withoutLiterals('SELECT session_id FROM users'), t), null)
})

test('قراءة: الحارس ← التطبيق بتوكن token_env، الاستعلام ملفوف بحد ٥١، حجب بالاسم، حد ٥٠، بلا تحويلات', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, name: `طالب ${i + 1}`, api_token: 'SECRET' }))
  const { r, calls } = reg(appOk(many), { target: 'hudoor' })
  const res = await r.query('hudoor', 'SELECT * FROM students;')
  const post = calls.find((c) => c.method === 'POST')!
  assert.equal(post.url, 'https://app.example.com/api/internal/readonly-sql')
  assert.equal(post.auth, `Bearer ${TOKEN}`)
  assert.equal(post.redirect, 'error')
  assert.equal(post.body.db, 'hudoor')
  assert.match(post.body.sql, /^SELECT \* FROM \(\nSELECT \* FROM students\n\) AS _meem_q LIMIT 51$/)
  assert.ok(calls.some((c) => c.url === 'https://app.example.com/api/internal/schema?db=hudoor' && c.auth === `Bearer ${TOKEN}`))
  assert.equal(res.rowCount, MAX_READ_ROWS)
  assert.equal(res.truncated, true)
  assert.deepEqual(res.masked, ['api_token'])
  assert.equal(res.rows[0].api_token, MASK)
  assert.equal(res.sql, 'SELECT * FROM students')
})

test('قراءة: عمود حساس أو جدول محظور ← رفض قبل أي إرسال للتطبيق', async () => {
  const { r, calls } = reg(appOk([]))
  await assert.rejects(r.query('hudoor', 'SELECT password_hash AS p FROM users'), /حساس/)
  await assert.rejects(r.query('hudoor', 'SELECT * FROM wa_sessions'), /محظور/)
  await assert.rejects(r.query('hudoor', "ATTACH '/x' AS y"), DbAccessError)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
})

test('المخطط: من /schema بلا الجداول المحظورة، مخزّن ١٠ دقائق', async () => {
  const { r, calls } = reg(appOk([]))
  const text = await r.schema('hudoor')
  assert.match(text, /students\(id INTEGER, name TEXT, national_id TEXT\)/)
  assert.doesNotMatch(text, /wa_sessions/)
  assert.deepEqual((await r.schemaTables('hudoor')).map((t) => t.table), ['students', 'users'])
  assert.equal(calls.length, 1)
})

test('لا كتابة على http أبداً', async () => {
  const { r, calls } = reg(appOk([]))
  await assert.rejects(r.previewWrite('hudoor', "UPDATE students SET name = 'x' WHERE id = 1"), /للقراءة فقط/)
  await assert.rejects(r.executeWrite('hudoor', 'DELETE FROM students WHERE id = 1', 1), /للقراءة فقط/)
  assert.equal(calls.length, 0)
})

test('الأخطاء: توكن ناقص، 404 (المسار معطّل)، 401، 400 بالسبب — بلا عنوان ولا توكن', async () => {
  const noTok = reg(appOk([]), {}, {})
  await assert.rejects(noTok.r.schema('hudoor'), /HUDOOR_READ_TOKEN ناقص/)
  assert.equal(noTok.calls.length, 0)
  for (const [status, re] of [[404, /غير مفعّل/], [401, /رفض توكن/], [500, /HTTP 500/]] as const) {
    const { r } = reg(() => ({ status, json: status === 500 ? undefined : { error: 'x' } }))
    await assert.rejects(r.schema('hudoor'), (e: Error) => e instanceof DbAccessError && re.test(e.message) && !e.message.includes(TOKEN) && !e.message.includes('example.com'))
  }
  const bad = reg((c) => (c.method === 'GET' ? { json: SCHEMA } : { status: 400, json: { error: 'no such column: nope' } }))
  await assert.rejects(bad.r.query('hudoor', 'SELECT nope FROM students'), /no such column: nope/)
  const down = new DatabaseRegistry(parseDbConnections(JSON.stringify([conn()])), undefined, undefined, {
    env: { HUDOOR_READ_TOKEN: TOKEN }, fetch: (async () => { throw new Error('connect ECONNREFUSED https://app.example.com/api/internal/schema') }) as typeof fetch,
  })
  await assert.rejects(down.schema('hudoor'), (e: Error) => /تعذّر الاتصال/.test(e.message) && !e.message.includes('example.com'))
  assert.equal(safeError('GET https://a.b/c?token=1 failed'), 'GET [url] failed')
})

test('بوابة CI: مستودع hudoor يقرأ قاعدة hudoor عبر نفس المسار (حارس + http) ويُسجَّل؛ والمخطط يذكر اللهجة', async () => {
  const scopes = buildCiScopes({ projects: [], dbs: [{ key: 'hudoor', project: 'hudoor-attendance' }], linked: [], explicit: TEST_CI_SCOPES })
  assert.deepEqual(scopes.get('example-user/hudoor'), ['hudoor'])
  const { r, calls } = reg(appOk([{ id: 1, name: 'نورة' }]))
  const audits: any[] = []
  const gw = new CiGateway({
    secret: 's'.repeat(40), dbs: r, projects: () => [], linked: undefined, explicitScopes: TEST_CI_SCOPES,
    store: { addDbAudit: async (a: any) => { audits.push(a) }, ciCallCounts: async () => ({ request: 0, repoWindow: 0 }) },
  } as any)
  const auth = `Bearer ${ciToken('s'.repeat(40), 'example-user/hudoor')}`
  const out = await gw.query(auth, { repo: 'example-user/hudoor', db: 'hudoor', sql: 'SELECT id, name FROM students', purpose: 'debug attendance', request_id: 'r1' })
  assert.deepEqual(out.rows, [{ id: 1, name: 'نورة' }])
  assert.equal(audits.at(-1).source, 'ci')
  assert.equal(audits.at(-1).ok, true)
  await assert.rejects(gw.query(auth, { repo: 'example-user/hudoor', db: 'hudoor', sql: 'SELECT password_hash FROM users', purpose: 'xxx', request_id: 'r1' }), /حساس/)
  assert.equal(audits.at(-1).ok, false)
  const sch = await gw.schema(auth, { repo: 'example-user/hudoor' })
  assert.equal(sch.dbs[0].dialect, 'sqlite')
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('كاتب SQL: ملاحظة SQLite تظهر لقواعد sqlite فقط', () => {
  assert.ok(sqlUserPrompt('تحضير', 'students(id INTEGER)', 'كم طالب؟', undefined, undefined, 'sqlite').startsWith(SQLITE_DIALECT_NOTE))
  assert.match(SQLITE_DIALECT_NOTE, /لا ILIKE/)
  assert.match(SQLITE_DIALECT_NOTE, /lower\(col\) LIKE/)
  assert.ok(!sqlUserPrompt('نبراس', 's(id int)', 'كم؟').includes('SQLite'))
})
