/**
 * قواعد بيانات المشاريع: الحارس، المحظور، الحجب، الأرقام العربية، وطبقة READ ONLY — على PGlite حقيقي.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import {
  DatabaseRegistry, DbAccessError, assertSelectOnly, assertWriteSql, normalizeSqlDigits, maskedColumns, maskRows,
  parseDbConnections, formatTable, deniedTableIn, MASK, type PoolFactory,
} from './databases.js'
import { pglitePool } from '../test-fixtures.js'

const DENY = ['auth_creds', 'api_keys']
const conn = (over: Record<string, unknown> = {}) => ({
  key: 'falak', name_ar: 'نبراس', aliases: ['نبراس التعليمية'], project: 'falak-prod', url: 'postgres://u:SECRETPW@h:1/db', deny_tables: DENY, ...over,
})

let pg: PGlite
const log: string[] = []
let reg: DatabaseRegistry
const count = async (sql: string) => Number((await pg.query<any>(sql)).rows[0].n)

before(async () => {
  pg = await PGlite.create('memory://')
  await pg.exec(`
    CREATE TABLE students (id SERIAL PRIMARY KEY, name TEXT, national_id TEXT, status TEXT, password_hash TEXT);
    CREATE TABLE auth_creds (id INT, creds TEXT);
    CREATE TABLE api_keys (id INT, k TEXT);
    INSERT INTO auth_creds VALUES (1, 'TOPSECRET');
  `)
  // ٦٠ طالباً نشطاً + واحد هويته محفوظة بأرقام عربية
  await pg.exec(`INSERT INTO students (name, national_id, status, password_hash)
    SELECT 'طالب ' || g, (1000000000 + g)::text, 'active', 'h' || g FROM generate_series(1, 60) g`)
  await pg.exec(`INSERT INTO students (name, national_id, status, password_hash) VALUES ('نورة', '١٩٩٩٩٩٩٩٩٠', 'inactive', 'zzz')`)
  reg = new DatabaseRegistry([conn() as any], pglitePool(pg, log))
})
after(async () => { await pg.close() })

test('حارس القراءة: يرفض تسلسل الجمل والكتابة وDML داخل CTE والدوال الخطرة', () => {
  for (const bad of [
    'select 1; drop table x',
    'SELECT 1;DELETE FROM students',
    'delete from students',
    'update students set status = 1',
    "with x as (delete from students returning *) select * from x",
    'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1',
    'select * into newtab from students',
    'select * from students for update',
    'select * from students for share',
    'select pg_terminate_backend(123)',
    "select pg_read_file('/etc/passwd')",
    'select pg_sleep(100)',
    "select set_config('statement_timeout','0',false)",
    "select lo_import('/etc/passwd')",
    "select * from dblink('host=x', 'select 1') as t(a int)",
    "select query_to_xml('select 1', true, true, '')",
    'select * from pg_stats',
    'select * from pg_shadow',
    "copy students to '/tmp/x'",
    'drop table students',
    "select 1 /* تعليق مفتوح",
    "select 'نص مفتوح",
    '',
  ]) assert.throws(() => assertSelectOnly(bad), DbAccessError, bad)
})

test('حارس القراءة: يقبل SELECT وWITH…SELECT والكلمات داخل النصوص والتعليقات', () => {
  for (const ok of [
    "select count(*) from students where status = 'active'",
    'with a as (select 1 as x) select * from a',
    "select * from students where name = 'delete; drop table x'",
    'select updated_at, deleted_at, created_at from t -- delete this?',
    'select pg_size_pretty(pg_database_size(current_database()))',
    'SELECT 1;',
  ]) assert.doesNotThrow(() => assertSelectOnly(ok), ok)
  assert.equal(assertSelectOnly('SELECT 1;;  '), 'SELECT 1')
})

test('الجداول المحظورة: بالاسم أو بين تنصيص أو داخل نص لدالة — ومخفية من المخطط', async () => {
  for (const bad of ['select * from auth_creds', 'select * from "auth_creds"', 'select * from public.AUTH_CREDS',
    "select * from students where name in (select creds from auth_creds)"]) {
    assert.throws(() => assertSelectOnly(bad, DENY), /محظور/, bad)
  }
  assert.throws(() => assertWriteSql('delete from api_keys where id = 1', DENY), /محظور/)
  assert.equal(deniedTableIn('select * from auth_creds_archive', DENY), null, 'اسم أطول ليس هو المحظور')
  await assert.rejects(reg.query('falak', 'select * from auth_creds'), /محظور/)
  const schema = await reg.schema('falak')
  assert.match(schema, /students\(id integer, name text/)
  assert.doesNotMatch(schema, /auth_creds|api_keys/)
})

test('حارس الكتابة: INSERT/UPDATE/DELETE بجملة واحدة فقط', () => {
  for (const bad of ['drop table students', 'truncate students', 'alter table students add x int', 'create table y (a int)',
    'grant all on students to public', "update students set status='x' where id=1; drop table students",
    "with x as (select 1) delete from students", 'select * from students', "delete from students where id = pg_terminate_backend(1)"]) {
    assert.throws(() => assertWriteSql(bad), DbAccessError, bad)
  }
  const w = assertWriteSql("update students set status = 'inactive' where id = 3;")
  assert.equal(w.verb, 'update')
  assert.equal(w.hasWhere, true)
  assert.equal(assertWriteSql('delete from students').hasWhere, false)
  assert.equal(assertWriteSql("insert into students (name) values ('x') on conflict do nothing").verb, 'insert')
})

test('الحجب: بالاسم الظاهر وباسم العمود الأصلي (يغلق الالتفاف بـ AS)', () => {
  const cols = ['id', 'password_hash', 'api_key', 'name', 'sessionId', 'otp_code', 'refresh_token', 'x']
  assert.deepEqual(maskedColumns(cols, { x: 'secret_answer' }), ['password_hash', 'api_key', 'sessionId', 'otp_code', 'refresh_token', 'x'])
  const rows = maskRows([{ id: 1, password_hash: 'abc', name: 'n' }], ['password_hash'])
  assert.deepEqual(rows, [{ id: 1, password_hash: MASK, name: 'n' }])
})

test('الأرقام العربية: تُطبَّع داخل النصوص، وخريطة translate تبقى، والبحث يلقى المحفوظ بالعربي', async () => {
  assert.equal(normalizeSqlDigits("select 1 where a = '١٩٩٩٩٩٩٩٩٠'"), "select 1 where a = '1999999990'")
  const q = "select name from students where translate(national_id,'٠١٢٣٤٥٦٧٨٩','0123456789') = '١٩٩٩٩٩٩٩٩٠'"
  assert.equal(normalizeSqlDigits(q), "select name from students where translate(national_id,'٠١٢٣٤٥٦٧٨٩','0123456789') = '1999999990'")
  const r = await reg.query('falak', q)
  assert.deepEqual(r.rows, [{ name: 'نورة' }])
})

test('القراءة: READ ONLY + مهلة + ROLLBACK، حد ٥٠ صفاً، والأعمدة الحساسة محجوبة', async () => {
  log.length = 0
  const r = await reg.query('falak', 'select id, name, password_hash from students order by id')
  assert.equal(r.rows.length, 50)
  assert.equal(r.truncated, true)
  assert.deepEqual(r.masked, ['password_hash'])
  assert.ok(r.rows.every((x) => x.password_hash === MASK))
  assert.equal(log[0], 'BEGIN TRANSACTION READ ONLY')
  assert.equal(log[1], "SET LOCAL statement_timeout = '10s'")
  assert.match(log[2], /^SELECT \* FROM \(\n[\s\S]*\n\) AS _meem_q LIMIT 51$/)
  assert.equal(log.at(-1), 'ROLLBACK')
  const c = await reg.query('falak', "select count(*) as n from students where status = 'active'")
  assert.equal(Number(c.rows[0].n), 60)
})

test('طبقة ثانية: كتابة عبر مسار القراءة تفشل حتى لو تجاوزت الحارس (المعاملة READ ONLY)', async () => {
  const before = await count('select count(*) as n from students')
  const bypass = (sql: string) => (reg as any).readTx('falak', sql, sql)
  await assert.rejects(bypass("INSERT INTO students (name) VALUES ('دخيل')"), /read-only/i)
  await assert.rejects(bypass('WITH x AS (DELETE FROM students RETURNING *) SELECT count(*) FROM x'), /read-only/i)
  await assert.rejects(bypass('UPDATE students SET status = NULL'), /read-only/i)
  assert.equal(await count('select count(*) as n from students'), before)
  assert.equal(await count("select count(*) as n from students where status is null"), 0)
})

test('الكتابة: المعاينة ترجع العدد وعيّنة ثم ROLLBACK، والتنفيذ يُلغى لو تغيّر العدد', async () => {
  const sql = "update students set status = 'paused' where status = 'active' and id <= 7"
  const pv = await reg.previewWrite('falak', sql)
  assert.equal(pv.count, 7)
  assert.equal(pv.rows.length, 5)
  assert.ok(pv.rows.every((x) => x.password_hash === MASK), 'العيّنة محجوبة')
  assert.equal(await count("select count(*) as n from students where status = 'paused'"), 0, 'المعاينة ما غيّرت شي')

  await pg.exec("update students set status = 'paused' where id = 1")   // تغيّر شيء بين المعاينة والموافقة
  const bad = await reg.executeWrite('falak', sql, 7)
  assert.deepEqual(bad, { applied: false, count: 6 })
  assert.equal(await count("select count(*) as n from students where status = 'paused'"), 1, 'ROLLBACK — لا شيء تغيّر')

  const ok = await reg.executeWrite('falak', sql, 6)
  assert.deepEqual(ok, { applied: true, count: 6 })
  assert.equal(await count("select count(*) as n from students where status = 'paused'"), 7)
})

test('السجل: التعريف من البيئة، والتحديد بالمفتاح/الاسم العربي/المشروع، والغموض لا يُخمَّن', () => {
  const raw = JSON.stringify([
    conn(), conn({ key: 'waqti', name_ar: 'جداول سراج', aliases: ['جدولي'], project: 'waqti' }),
    conn({ key: 'noqta', name_ar: 'نخلة', aliases: [], project: 'noqta-prod' }),
    conn({ key: 'nuqta', name_ar: 'نخلة الجديدة', aliases: [], project: 'nuqta' }),
    { key: 'bad' }, conn(),
  ])
  const r = DatabaseRegistry.fromEnv({ DB_CONNECTIONS: raw })
  assert.deepEqual(r.list().map((d) => d.key), ['falak', 'waqti', 'noqta', 'nuqta'], 'التالف والمكرر يُتجاهل')
  assert.ok(!JSON.stringify(r.list()).includes('SECRETPW'), 'لا عناوين في القائمة')
  assert.deepEqual(r.resolve('نبراس').map((d) => d.key), ['falak'])
  assert.deepEqual(r.resolve('جدولي').map((d) => d.key), ['waqti'])
  assert.deepEqual(r.resolve('falak-prod').map((d) => d.key), ['falak'])
  assert.deepEqual(r.resolve('nuqta').map((d) => d.key), ['nuqta'])
  assert.ok(r.resolve('نخله').length > 1 || r.resolve('نخله')[0]?.key === 'noqta')
  assert.deepEqual(r.resolve(undefined), [], 'بلا اسم ومع أكثر من قاعدة = اسأل')
  assert.deepEqual(parseDbConnections('not json'), [])
  assert.deepEqual(parseDbConnections(undefined), [])
})

test('الأخطاء لا تحمل عنوان الاتصال، والمخطط مخزّن ١٠ دقائق', async () => {
  const boom: PoolFactory = () => ({
    async connect() { throw new Error('connect ECONNREFUSED postgres://u:SECRETPW@h:1/db\nstack') }, async end() {},
  })
  const r = new DatabaseRegistry([conn() as any], boom)
  await assert.rejects(r.query('falak', 'select 1'), (e: any) => e instanceof DbAccessError && !e.message.includes('SECRETPW') && e.message.includes('[url]'))

  let now = 0
  const calls: string[] = []
  const cached = new DatabaseRegistry([conn() as any], pglitePool(pg, calls), () => now)
  await cached.schema('falak')
  const n = calls.length
  now += 9 * 60_000
  await cached.schema('falak')
  assert.equal(calls.length, n, 'من الذاكرة')
  now += 2 * 60_000
  await cached.schema('falak')
  assert.ok(calls.length > n, 'انتهت العشر دقائق ← يُعاد')
})

test('الجدول المختصر: أفقي للقوائم، عمودي لصف واحد عريض', () => {
  assert.equal(formatTable(['n'], [{ n: 60 }]), 'n\n60')
  const wide = formatTable(['a', 'b', 'c', 'd'], [{ a: 1, b: null, c: 'x', d: new Date('2026-01-02T03:04:00Z') }])
  assert.equal(wide, '• a: 1\n• b: —\n• c: x\n• d: 2026-01-02 03:04')
  assert.match(formatTable(['i'], Array.from({ length: 20 }, (_, i) => ({ i }))), /… و5 صف ثاني$/)
})

test('المخطط الكبير يظهر كاملاً بلا اقتطاع وبأنواع مختصرة', async () => {
  const p2 = await PGlite.create('memory://')
  try {
    let ddl = ''
    for (let i = 0; i < 300; i++) ddl += `CREATE TABLE big_table_${i} (id INT, a_long_column_name_one VARCHAR(10), a_long_column_name_two TIMESTAMPTZ, a_long_column_name_three TEXT);\n`
    await p2.exec(ddl)
    const r2 = new DatabaseRegistry([conn() as any], pglitePool(p2, []))
    const text = await r2.schema('falak')
    assert.ok(text.length > 14_000, 'أطول من الحد القديم')
    assert.doesNotMatch(text, /مقطوع/)
    assert.equal(text.split('\n').length, 300)
    assert.match(text, /big_table_299\(id integer, a_long_column_name_one varchar, a_long_column_name_two timestamptz/)
  } finally { await p2.close() }
})
