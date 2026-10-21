/**
 * بوابة قواعد البيانات لـ Claude في GitHub Actions: توكن HMAC لكل مستودع، نطاق القواعد لكل مستودع،
 * التنفيذ عبر مسار القراءة الوحيد (حارس + READ ONLY + حجب + حد صفوف)، حدود الاستدعاء، والسجل.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { DatabaseRegistry, MASK, MAX_READ_ROWS } from './clients/databases.js'
import { pglitePool } from './test-fixtures.js'
import { buildServer } from './server.js'
import {
  CiGateway, type CiGatewayDeps, buildCiScopes, canonicalRepo, ciToken, verifyCiToken, parseRepoList, parseScopesEnv, DEFAULT_CI_SCOPES,
} from './ci-gateway.js'
import { TEST_CI_SCOPES } from './test-profile.js'
import { ciQueriesLine, formatCiAudit, pendingPreview } from './format.js'
import type { FastifyInstance } from 'fastify'

const SECRET = 'test-ci-gateway-secret'
const SIRAJPLUS = 'example-user/sirajplus'
const QANDEEL = 'example-user/qandeel-hub'
const COMPASS = 'example-user/compass'
const WAQTI = 'example-user/waqti'

const conns = [
  { key: 'falak', name_ar: 'نبراس', aliases: [], project: 'falak-prod', url: 'postgres://u:SECRETPW@h:1/falak', deny_tables: ['auth_creds'] },
  { key: 'qandeel', name_ar: 'قنديل', aliases: ['مثابر'], project: 'qndeel-saas', url: 'postgres://u:SECRETPW@h:1/qandeel', deny_tables: [] },
  { key: 'compass', name_ar: 'بوصلة', aliases: [], project: 'compass', url: 'postgres://u:SECRETPW@h:1/compass', deny_tables: [] },
  { key: 'waqti', name_ar: 'جداول سراج', aliases: [], project: 'waqti', url: 'postgres://u:SECRETPW@h:1/waqti', deny_tables: [] },
]
const projects = [
  { repo: SIRAJPLUS, railway_project: null },
  { repo: QANDEEL, railway_project: 'qndeel-saas' },
  { repo: COMPASS, railway_project: 'compass' },
  { repo: WAQTI, railway_project: 'waqti' },
]

let pg: PGlite, db: Db, store: Store, dbs: DatabaseRegistry, app: FastifyInstance
let clock = new Date('2026-10-06T08:00:00Z')
let deps: CiGatewayDeps

const auth = (repo: string) => ({ authorization: `Bearer ${ciToken(SECRET, repo)}` })
const q = (repo: string, body: Record<string, unknown>, headers: Record<string, string> = auth(repo)) =>
  app.inject({ method: 'POST', url: '/api/ci/db/query', headers, payload: { repo, request_id: 'ab12cd34', purpose: 'investigate a data bug', ...body } })
const ciRows = async () => (await store.recentDbAudit(500)).filter((r) => r.source === 'ci')

before(async () => {
  pg = await PGlite.create('memory://')
  await pg.exec(`
    CREATE TABLE students (id SERIAL PRIMARY KEY, name TEXT, status TEXT, password_hash TEXT);
    CREATE TABLE auth_creds (id INT, creds TEXT);
  `)
  await pg.exec(`INSERT INTO students (name, status, password_hash) SELECT 'طالب ' || g, 'active', 'HASH' || g FROM generate_series(1, 60) g`)
  db = await createDb({ pgliteDir: 'memory://' } as any)
  await migrate(db)
  store = new Store(db)
  dbs = new DatabaseRegistry(conns as any, pglitePool(pg))
  deps = { secret: SECRET, dbs, store, projects: () => projects, disabledRepos: new Set(), explicitScopes: TEST_CI_SCOPES, now: () => clock, limits: { perRequest: 60, perHour: 300 } }
  app = buildServer({ assistant: {} as any, webhookSecret: 'x', ciGateway: new CiGateway(deps) })
  await app.ready()
})
after(async () => { await app.close(); await db.close(); await pg.close() })
beforeEach(async () => {
  deps.disabledRepos = new Set()
  deps.limits = { perRequest: 60, perHour: 300 }
  clock = new Date(clock.getTime() + 2 * 3600_000)   // نافذة ساعة جديدة لكل اختبار
})

// ───────────── التوكن ─────────────

test('التوكن: HMAC-SHA256(السر، المستودع بحروف صغيرة) hex — مختلف لكل مستودع ولكل سر', () => {
  const t = ciToken(SECRET, SIRAJPLUS)
  assert.equal(t, createHmac('sha256', SECRET).update('example-user/sirajplus').digest('hex'))
  assert.match(t, /^[0-9a-f]{64}$/)
  assert.equal(ciToken(SECRET, ' EXAMPLE-USER/SirajPlus '), t, 'حالة الأحرف والمسافات لا تغيّر التوكن')
  assert.notEqual(ciToken(SECRET, QANDEEL), t)
  assert.notEqual(ciToken('rotated', SIRAJPLUS), t, 'تدوير السر يلغي كل التوكنات')
  assert.throws(() => ciToken(SECRET, 'not-a-repo'))
  assert.throws(() => ciToken('', SIRAJPLUS))
})

test('التحقق من التوكن: الصحيح فقط — توكن مستودع آخر أو مقطوع أو فاضي أو سر فاضي = رفض', () => {
  assert.equal(verifyCiToken(SECRET, SIRAJPLUS, ciToken(SECRET, SIRAJPLUS)), true)
  assert.equal(verifyCiToken(SECRET, SIRAJPLUS, ciToken(SECRET, COMPASS)), false)
  assert.equal(verifyCiToken(SECRET, SIRAJPLUS, ciToken(SECRET, SIRAJPLUS).slice(0, 63)), false)
  assert.equal(verifyCiToken(SECRET, SIRAJPLUS, ''), false)
  assert.equal(verifyCiToken(SECRET, SIRAJPLUS, undefined), false)
  assert.equal(verifyCiToken('', SIRAJPLUS, ciToken(SECRET, SIRAJPLUS)), false)
  assert.equal(canonicalRepo('../etc'), null)
})

// ───────────── النطاق ─────────────

test('النطاق: سراج بلس ↔ نبراس + قنديل (مرتبطان)، بوصلة ← بوصلة فقط، railway_project ↔ project، والمفاتيح غير الموجودة تُسقط', () => {
  const s = buildCiScopes({ projects, dbs: conns, explicit: TEST_CI_SCOPES })
  assert.deepEqual(s.get('example-user/sirajplus'), ['falak', 'qandeel'])
  assert.deepEqual(s.get('example-user/qandeel-hub'), ['falak', 'qandeel'])
  assert.deepEqual(s.get('example-user/compass'), ['compass'])
  assert.deepEqual(s.get('example-user/waqti'), ['waqti'])
  assert.equal(s.get('example-user/nuqta'), undefined, 'nuqta غير موجودة في DB_CONNECTIONS هنا')
  // الاشتقاق من السجل وحده (بلا الخريطة الصريحة)
  const derived = buildCiScopes({ projects: [{ repo: 'example-user/Bloom', railway_project: 'bloom-site' }], dbs: [{ key: 'bloom', project: 'Bloom-Site' }], explicit: {} })
  assert.deepEqual(derived.get('example-user/bloom'), ['bloom'])
  // الربط غير متعدٍّ ولا يمنح مستودعاً غير مرتبط شيئاً
  assert.equal(buildCiScopes({ projects: [], dbs: conns, explicit: {} }).size, 0)
  assert.deepEqual(DEFAULT_CI_SCOPES, {}, 'القالب بلا خريطة مالك مدمجة — CI_GATEWAY_SCOPES فقط')
  assert.equal(buildCiScopes({ projects: [], dbs: conns, linked: [] }).size, 0, 'بلا CI_GATEWAY_SCOPES ولا railway_project: لا نطاق')
  assert.deepEqual(parseScopesEnv('{"example-user/X":["a"]}'), { 'example-user/x': ['a'] })
  assert.equal(parseScopesEnv('nope'), null)
  assert.deepEqual([...parseRepoList(' example-user/A, example-user/b  bad ')], ['example-user/a', 'example-user/b'])
})

test('HTTP: سراج بلس يقرأ نبراس وقنديل (200 + حجب)، بوصلة ممنوعة من نبراس (403 برسالة واضحة)', async () => {
  for (const dbKey of ['falak', 'qandeel']) {
    const r = await q(SIRAJPLUS, { db: dbKey, sql: 'select id, name, password_hash from students order by id limit 3' })
    assert.equal(r.statusCode, 200, r.body)
    const j = r.json()
    assert.deepEqual(j.columns, ['id', 'name', 'password_hash'])
    assert.equal(j.row_count, 3)
    assert.equal(j.truncated, false)
    assert.ok(j.rows.every((x: any) => x.password_hash === MASK), 'الأعمدة الحساسة محجوبة')
    assert.deepEqual(j.masked, ['password_hash'])
  }
  const mk = await q(QANDEEL, { db: 'falak', sql: 'select count(*) as n from students' })
  assert.equal(mk.statusCode, 200)
  assert.equal(mk.json().rows[0].n, 60)

  const denied = await q(COMPASS, { db: 'falak', sql: 'select 1' })
  assert.equal(denied.statusCode, 403)
  assert.match(denied.json().error, /غير مسموح .*«falak».*المسموح: compass/)
  const unknown = await q(SIRAJPLUS, { db: 'waqti', sql: 'select 1' })
  assert.equal(unknown.statusCode, 403)
})

test('HTTP: بلا توكن / توكن مستودع آخر / repo منتحل = 401 بلا تفاصيل ولا سجل', async () => {
  const before = (await ciRows()).length
  assert.equal((await q(SIRAJPLUS, { db: 'falak', sql: 'select 1' }, {})).statusCode, 401)
  assert.equal((await q(SIRAJPLUS, { db: 'falak', sql: 'select 1' }, { authorization: 'Bearer nope' })).statusCode, 401)
  // بوصلة تستخدم توكنها لكنها تدّعي أنها سراج بلس
  const spoof = await q(SIRAJPLUS, { db: 'falak', sql: 'select 1' }, auth(COMPASS))
  assert.equal(spoof.statusCode, 401)
  assert.deepEqual(spoof.json(), { error: 'unauthorized' })
  assert.equal((await ciRows()).length, before)
})

test('الحارس: DML، تعدد الجمل، الجداول المحظورة، والكتابة المتخفية = 400 بالسبب — بلا تتبع مكدس ولا عنوان اتصال', async () => {
  const cases: [string, RegExp][] = [
    ['delete from students', /SELECT/],
    ["update students set status = 'x'", /SELECT/],
    ['select 1; drop table students', /جملة وحدة/],
    ['select * from auth_creds', /محظور/],
    ['with d as (delete from students returning *) select * from d', /DELETE/],
    ['select * from no_such_table', /no_such_table/],
  ]
  for (const [sql, re] of cases) {
    const r = await q(SIRAJPLUS, { db: 'falak', sql })
    assert.equal(r.statusCode, 400, sql)
    const err = r.json().error as string
    assert.match(err, re, sql)
    assert.doesNotMatch(r.body, /SECRETPW|postgres:\/\/|\bat\s+\S+\.(?:ts|js):\d+/, 'لا عناوين ولا مكدس')
  }
  assert.equal(Number((await pg.query<any>('select count(*)::int as n from students')).rows[0].n), 60, 'لم يُحذف شيء')
})

test('حد الصفوف: ٥٠ كحد أقصى + truncated', async () => {
  const r = await q(SIRAJPLUS, { db: 'falak', sql: 'select id from students' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().row_count, MAX_READ_ROWS)
  assert.equal(r.json().truncated, true)
})

test('الطلب ناقص (purpose / request_id) = 400', async () => {
  const r1 = await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', purpose: '' })
  assert.equal(r1.statusCode, 400)
  assert.match(r1.json().error, /purpose/)
  const r2 = await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'bad id!' })
  assert.equal(r2.statusCode, 400)
})

test('السجل: كل استدعاء موثّق يُكتب بـ source=ci والمستودع ورقم الطلب والغرض والعدد والخطأ', async () => {
  await q(SIRAJPLUS, { db: 'falak', sql: 'select id from students limit 2', request_id: 'aud00001', purpose: 'why is student 7 non-compliant' })
  await q(SIRAJPLUS, { db: 'falak', sql: 'delete from students', request_id: 'aud00001' })
  await q(COMPASS, { db: 'falak', sql: 'select 1', request_id: 'aud00002' })
  const rows = (await ciRows()).filter((r) => r.request_id === 'aud00001' || r.request_id === 'aud00002').reverse()
  assert.deepEqual(rows.map((r) => [r.repo, r.db_key, r.ok, r.row_count]), [
    ['example-user/sirajplus', 'falak', true, 2],
    ['example-user/sirajplus', 'falak', false, null],
    ['example-user/compass', 'falak', false, null],
  ])
  assert.equal(rows[0].purpose, 'why is student 7 non-compliant')
  assert.equal(rows[0].kind, 'read')
  assert.match(rows[1].error!, /SELECT/)
  assert.match(rows[2].error!, /غير مسموح/)
})

test('الحدود: ٦٠ لكل request_id و٣٠٠ في الساعة لكل مستودع (قابلة للضبط) — 429، والمرفوض لا يُحسب', async () => {
  deps.limits = { perRequest: 3, perHour: 5 }
  const codes: number[] = []
  for (let i = 0; i < 4; i++) codes.push((await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'rl000001' })).statusCode)
  assert.deepEqual(codes, [200, 200, 200, 429])
  const r = await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'rl000001' })
  assert.match(r.json().error, /حد 3 استدعاء لهذا الطلب/)
  // طلب جديد: الحد الساعي للمستودع (٣ محسوبة من قبل + ٢ = ٥)
  const c2: number[] = []
  for (let i = 0; i < 3; i++) c2.push((await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'rl000002' })).statusCode)
  assert.deepEqual(c2, [200, 200, 429])
  // مستودع آخر غير متأثر
  assert.equal((await q(QANDEEL, { db: 'qandeel', sql: 'select 1', request_id: 'rl000003' })).statusCode, 200)
  // بعد ساعة تنفتح النافذة
  clock = new Date(clock.getTime() + 3601_000)
  assert.equal((await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'rl000004' })).statusCode, 200)
  const limited = (await ciRows()).filter((x) => x.error === 'rate_limited')
  assert.ok(limited.length >= 3, 'محاولات تجاوز الحد مسجلة أيضاً')
})

test('مستودع معطّل (CI_GATEWAY_DISABLED_REPOS) = 403 حتى بتوكن صحيح، ويُسجَّل', async () => {
  deps.disabledRepos = new Set(['example-user/sirajplus'])
  const r = await q(SIRAJPLUS, { db: 'falak', sql: 'select 1', request_id: 'dis00001' })
  assert.equal(r.statusCode, 403)
  assert.match(r.json().error, /معطّلة لهذا المستودع/)
  assert.equal((await ciRows()).find((x) => x.request_id === 'dis00001')?.ok, false)
  assert.equal((await q(QANDEEL, { db: 'qandeel', sql: 'select 1', request_id: 'dis00002' })).statusCode, 200)
})

test('المخطط: القواعد المسموحة فقط، بلا الجداول المحظورة؛ قاعدة خارج النطاق = 403', async () => {
  const all = await app.inject({ method: 'GET', url: `/api/ci/db/schema?repo=${encodeURIComponent(SIRAJPLUS)}&request_id=sch00001`, headers: auth(SIRAJPLUS) })
  assert.equal(all.statusCode, 200, all.body)
  const j = all.json()
  assert.deepEqual(j.dbs.map((d: any) => d.db), ['falak', 'qandeel'])
  const falak = j.dbs.find((d: any) => d.db === 'falak')
  assert.ok(falak.tables.some((t: any) => t.table === 'students' && t.columns.some((c: any) => c.name === 'status' && c.type === 'text')))
  assert.ok(!falak.tables.some((t: any) => t.table === 'auth_creds'), 'الجدول المحظور لا يظهر')
  const one = await app.inject({ method: 'GET', url: `/api/ci/db/schema?repo=${encodeURIComponent(COMPASS)}&db=falak`, headers: auth(COMPASS) })
  assert.equal(one.statusCode, 403)
  const noAuth = await app.inject({ method: 'GET', url: `/api/ci/db/schema?repo=${encodeURIComponent(SIRAJPLUS)}` })
  assert.equal(noAuth.statusCode, 401)
})

test('بلا سر = البوابة غير مسجلة (404)، والسر موجود لكن db_access مطفأ = 503', async () => {
  const off = buildServer({ assistant: {} as any, webhookSecret: 'x', ciGateway: null })
  assert.equal((await off.inject({ method: 'POST', url: '/api/ci/db/query', payload: {} })).statusCode, 404)
  await off.close()
  const gw = new CiGateway({ secret: SECRET, dbs, store, projects: () => projects, enabled: () => false })
  const paused = buildServer({ assistant: {} as any, webhookSecret: 'x', ciGateway: gw })
  const r = await paused.inject({ method: 'POST', url: '/api/ci/db/query', headers: auth(SIRAJPLUS), payload: { repo: SIRAJPLUS, db: 'falak', sql: 'select 1', purpose: 'xxxx', request_id: 'a1' } })
  assert.equal(r.statusCode, 503)
  await paused.close()
})

test('رؤية المالك: معاينة الدمج تذكر «🔎 Claude استعلم N مرة …» و«استعلامات كلود» تعرض السجل', async () => {
  for (const [dbKey, n] of [['falak', 2], ['qandeel', 1]] as const) {
    for (let i = 0; i < n; i++) await q(SIRAJPLUS, { db: dbKey, sql: 'select 1 as x', request_id: 'vis00001' })
  }
  await q(SIRAJPLUS, { db: 'falak', sql: 'delete from students', request_id: 'vis00001' })   // الفاشل لا يُحسب
  await app.inject({ method: 'GET', url: `/api/ci/db/schema?repo=${encodeURIComponent(SIRAJPLUS)}&request_id=vis00001`, headers: auth(SIRAJPLUS) })
  const stats = await store.ciQueryStats('vis00001')
  assert.deepEqual(stats, { count: 3, dbs: ['falak', 'qandeel'] })
  assert.equal(ciQueriesLine(stats), '🔎 Claude استعلم 3 مرة من قواعد البيانات (falak، qandeel)')
  assert.equal(ciQueriesLine({ count: 0, dbs: [] }), '')
  const preview = pendingPreview({
    id: 1, short_no: 7, kind: 'merge_pr', status: 'open', origin_msg_id: null, preview_gw_id: null, preview_wa_id: null, preview_sent_at: null,
    created_at: clock, expires_at: clock,
    payload: { project: 'سراج بلس', verification: 'npm test ✅', summary: 'إصلاح', files: 2, additions: 3, deletions: 1, pr_url: 'https://github.com/x/y/pull/1', ci_queries: stats },
  } as any, 1, '966')
  assert.match(preview, /🔎 Claude استعلم 3 مرة من قواعد البيانات \(falak، qandeel\)\nhttps:\/\/github.com/)
  const list = formatCiAudit(await store.recentCiAudit(15), clock, 'Asia/Riyadh')
  assert.match(list, /^🔎 آخر استعلامات Claude/)
  assert.match(list, /sirajplus ← falak \(طلب vis00001\): ❌/)
  assert.match(list, /الغرض: investigate a data bug/)
  assert.equal(formatCiAudit([], clock, 'Asia/Riyadh'), 'ما استعلم Claude (GitHub Actions) من قواعد البيانات للحين.')
})
