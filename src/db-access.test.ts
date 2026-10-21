/**
 * قواعد بيانات المشاريع من المحادثة: سؤال ← SELECT ← جواب + جدول + الاستعلام،
 * وتعديل ← معاينة (ROLLBACK) ← "نعم N" فقط ← تنفيذ أو إلغاء لو تغيّر العدد، وكل شيء في db_audit.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, mentionsNumber, type InboundPayload } from './assistant.js'
import { ProjectRegistry } from './projects.js'
import { DatabaseRegistry } from './clients/databases.js'
import { pglitePool } from './test-fixtures.js'
import { sqlSystemRead, sqlSystemWrite, summarySystem } from './ai/dbsql.js'
import { capabilitiesForPrompt } from './capabilities.js'
import type { GatewayClient } from './clients/gateway.js'
import type { LlmClient } from './ai/providers.js'
import { toLatinDigits } from './lib/phone.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

let clock = new Date('2026-10-01T08:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}

/** فهم رسالة المالك ← إجراءات */
const script: Record<string, any> = {}
/** كتابة SQL: حسب نص الطلب ← طابور ردود */
const sqlScript: Record<string, string[]> = {}
const sqlPrompts: string[] = []
const summaryPrompts: string[] = []
const llm: LlmClient = {
  async complete(system, user) {
    if (system === sqlSystemRead() || system === sqlSystemWrite()) {
      sqlPrompts.push(user)
      const req = user.split('الطلب:\n')[1].split('\n\nمحاولتك السابقة')[0].split('\n\nاستعلامك السابق')[0].trim()
      // الطلب يصل للنموذج بأرقام لاتينية
      const q = sqlScript[req] ?? sqlScript[Object.keys(sqlScript).find((k) => toLatinDigits(k) === req) ?? '']
      if (!q?.length) throw new Error(`لا SQL مبرمج لـ: ${req}`)
      return JSON.stringify(q.length > 1 ? { sql: q.shift() } : { sql: q[0] })
    }
    if (system === summarySystem()) { summaryPrompts.push(user); return 'عندك 60 طالب نشط 👌' }
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: '؟' }], reply: '' })
  },
}

let db: Db, store: Store, a: Assistant, pg: PGlite
let seq = 0
const say = async (text: string) => {
  clock = new Date(clock.getTime() + 2_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `D${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
  return sent.at(-1) ?? ''
}
const n = async (sql: string) => Number((await pg.query<any>(sql)).rows[0].n)
const audit = () => store.recentDbAudit(100)
const openDbWrite = async () => (await store.openPending(clock)).filter((p) => p.kind === 'db_write').at(-1)

before(async () => {
  pg = await PGlite.create('memory://')
  await pg.exec(`
    CREATE TABLE students (id SERIAL PRIMARY KEY, name TEXT, national_id TEXT, status TEXT, password_hash TEXT);
    CREATE TABLE auth_creds (id INT, creds TEXT);
    CREATE TABLE logs (id SERIAL PRIMARY KEY, msg TEXT);
  `)
  await pg.exec(`INSERT INTO students (name, national_id, status, password_hash)
    SELECT 'طالب ' || g, (1000000000 + g)::text, 'active', 'HASH' || g FROM generate_series(1, 60) g`)
  await pg.exec(`INSERT INTO logs (msg) SELECT 'l' || g FROM generate_series(1, 600) g`)
  const conns = [
    { key: 'falak', name_ar: 'نبراس', aliases: [], project: 'falak', url: 'postgres://x', deny_tables: ['auth_creds'] },
    { key: 'waqti', name_ar: 'جداول سراج', aliases: ['جدولي'], project: 'waqti', url: 'postgres://y', deny_tables: [] },
  ]
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  a = new Assistant({
    cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github: null, projects: new ProjectRegistry([]),
    now: () => clock, railway: null, databases: new DatabaseRegistry(conns as any, pglitePool(pg)),
  })
})
after(async () => { await db.close(); await pg.close() })
beforeEach(async () => { sent.length = 0; await a.settings.update({ features: { db_access: true } }) })

test('سؤال: SELECT واحدة ← خلاصة فقط (بلا جدول خام) + الاستعلام لا يظهر، ورد النموذج المتخيَّل لا يظهر، والسجل يحفظه', async () => {
  const q = 'كم طالب نشط في نبراس؟'
  script[q] = { actions: [{ type: 'db_query', db_query: 'نبراس', question: q }], reply: 'عندك ١٠٠٠ طالب' }
  sqlScript[q] = ["select count(*) as n from students where status = 'active'"]
  const out = await say(q)
  assert.equal(out, 'عندك 60 طالب نشط 👌')
  assert.doesNotMatch(out, /select|🔎/i, 'الـ SQL لا يظهر للمستخدم')
  assert.doesNotMatch(out, /١٠٠٠/, 'رد النموذج بلا بيانات لا يُعرض')
  // المخطط أُعطي للنموذج بلا الجداول المحظورة
  assert.match(sqlPrompts.at(-1)!, /students\(id integer/)
  assert.doesNotMatch(sqlPrompts.at(-1)!, /auth_creds/)
  const [row] = await audit()
  assert.deepEqual({ db: row.db_key, kind: row.kind, rows: row.row_count, ok: row.ok }, { db: 'falak', kind: 'read', rows: 1, ok: true })
})

test('بحث بصفر نتائج ← محاولة وحدة بصياغة أوسع (ILIKE) قبل "ما لقيت"', async () => {
  const q = 'ابحث عن طالب اسمه احمد'
  script[q] = { actions: [{ type: 'db_query', db_query: 'نبراس', question: q }], reply: '' }
  sqlScript[q] = ["select id from students where status = 'no-such-status'", "select id from students where status ilike '%act%'"]
  const out = await say(q)
  assert.equal(out, 'عندك 60 طالب نشط 👌')
  assert.match(sqlPrompts.at(-1)!, /رجع صفر صفوف/)
})

test('الأعمدة الحساسة محجوبة في الرد ولا تصل للنموذج أبداً', async () => {
  const q = 'وريني أول ٣ طلاب مع الهاش'
  script[q] = { actions: [{ type: 'db_query', db_query: 'نبراس', question: q }], reply: '' }
  sqlScript[q] = ['select name, password_hash from students order by id limit 3']
  summaryPrompts.length = 0
  const out = await say(q)
  assert.match(out, /طالب 1 \| •••/)
  assert.match(out, /🔒 محجوب: password_hash/)
  assert.doesNotMatch(out, /HASH\d/)
  assert.equal(summaryPrompts.length, 1)
  assert.doesNotMatch(summaryPrompts[0], /HASH\d/)
  assert.match(summaryPrompts[0], /طالب 1/, 'الصفوف غير المحجوبة تصل للملخص')
})

test('استعلام مرفوض من الحارس (مرتين) ← خطأ واضح، لا شيء يتغير، والمحاولتان في السجل', async () => {
  const q = 'احذف الطلاب'
  script[q] = { actions: [{ type: 'db_query', db_query: 'نبراس', question: q }], reply: '' }
  sqlScript[q] = ['select 1; drop table students']
  const out = await say(q)
  assert.match(out, /❌ ما قدرت أجاوب من قاعدة نبراس: مسموح جملة وحدة بس/)
  assert.equal(await n('select count(*) as n from students'), 60)
  const rows = (await audit()).slice(0, 2)
  assert.ok(rows.every((r) => r.kind === 'read' && !r.ok && /جملة وحدة/.test(r.error ?? '')))
})

test('تعديل: معاينة (بلا تغيير) ← "تمام/يلا/نعم" ما توافق ← "نعم N" تنفّذ', async () => {
  const q = 'غير حالة الطالب 5 إلى موقوف في نبراس'
  script[q] = { actions: [{ type: 'db_write', db_query: 'نبراس', request: q }], reply: 'تم التعديل ✅' }
  sqlScript[q] = ["update students set status = 'suspended' where id = 5"]
  const out = await say(q)
  const p = (await openDbWrite())!
  assert.ok(out.startsWith(`[${p.short_no}] 📝 جهزت التعديل (ما نفّذته بعد) على قاعدة نبراس:`), out)
  assert.match(out, /يأثر على 1 صف\./)
  assert.ok(out.endsWith(`أنفّذه؟ رد: نعم ${p.short_no} / لا ${p.short_no}`))
  assert.doesNotMatch(out, /تم التعديل/, 'النموذج ما يدّعي التنفيذ')
  assert.doesNotMatch(out, /HASH5/, 'العيّنة محجوبة')
  assert.equal(await n("select count(*) as n from students where status = 'suspended'"), 0, 'المعاينة رُجعت')

  for (const w of ['تمام', 'يلا', 'اي']) {
    await say(w)
    assert.equal(await n("select count(*) as n from students where status = 'suspended'"), 0, `"${w}" نفّذ التعديل`)
  }
  assert.match(sent.at(-1)!, new RegExp(`تعديل قاعدة البيانات يحتاج تأكيد صريح برقمه: رد «نعم ${p.short_no}»`))
  const done = await say(`نعم ${p.short_no}`)
  assert.equal(done, '✅ نفّذت التعديل على نبراس: 1 صف.')
  assert.equal(await n("select count(*) as n from students where status = 'suspended' and id = 5"), 1)
  const kinds = (await audit()).slice(0, 2).map((r) => `${r.kind}:${r.row_count}:${r.ok}`)
  assert.deepEqual(kinds, ['write:1:true', 'preview:1:true'])
  await say(`نعم ${p.short_no}`)
  assert.equal((await audit())[0].kind, 'write', 'لا تنفيذ مرتين')
  assert.equal((await audit()).filter((r) => r.kind === 'write').length, 1)
})

test('تعديل: العدد تغيّر بين المعاينة والموافقة ← إلغاء كامل (ROLLBACK)', async () => {
  const q = 'وقف أول ٣ طلاب نشطين'
  script[q] = { actions: [{ type: 'db_write', db_query: 'نبراس', request: q }], reply: '' }
  sqlScript[q] = ["update students set status = 'paused' where status = 'active' and id <= 3"]
  await say(q)
  const p = (await openDbWrite())!
  assert.equal(p.payload.expected, 3)
  await pg.exec("update students set status = 'other' where id = 2")
  const out = await say(`نعم ${p.short_no}`)
  assert.match(out, /⚠️ ما نفّذت التعديل على نبراس — عدد الصفوف تغيّر \(المعاينة 3، الحين 2\)/)
  assert.equal(await n("select count(*) as n from students where status = 'paused'"), 0)
  const [w] = await audit()
  assert.equal(w.kind, 'write')
  assert.equal(w.ok, false)
  assert.equal(w.row_count, 2)
})

test('تعديل أكثر من ٥٠٠ صف: يُرفض إلا إذا ذكر المالك العدد صراحة', async () => {
  const q = 'احذف كل السجلات من logs'
  script[q] = { actions: [{ type: 'db_write', db_query: 'نبراس', request: q }], reply: '' }
  sqlScript[q] = ['delete from logs']
  const before = (await store.openPending(clock)).length
  const out = await say(q)
  assert.match(out, /⚠️ التعديل يأثر على 600 صف في نبراس — أكثر من 500، ما جهزته/)
  assert.equal((await store.openPending(clock)).length, before)

  const q2 = 'احذف كل السجلات من logs وهي ٦٠٠ صف'
  script[q2] = { actions: [{ type: 'db_write', db_query: 'نبراس', request: q2 }], reply: '' }
  sqlScript[q2] = ['delete from logs']
  const out2 = await say(q2)
  assert.match(out2, /يأثر على 600 صف ⚠️ بدون شرط WHERE/)
  assert.equal(await n('select count(*) as n from logs'), 600)
  assert.ok(mentionsNumber('تمام ١٬٢٠٠ صف', 1200))
  assert.ok(!mentionsNumber('6000 صف', 600))
})

test('بلا اسم قاعدة ومع أكثر من قاعدة: يسأل بخيارات، والرقم يكمل الطلب', async () => {
  const q = 'كم طالب عندي؟'
  script[q] = { actions: [{ type: 'db_query', question: q }], reply: '' }
  sqlScript[q] = ['select count(*) as n from students']
  const out = await say(q)
  assert.match(out, /أي قاعدة بيانات تقصد؟\n1\. نبراس \(falak\)\n2\. جداول سراج \(waqti\)/)
  const res = await say('1')
  assert.match(res, /عندك 60/)
  assert.doesNotMatch(res, /select|🔎/i)
})

test('الميزة موقفة من اللوحة ← لا وصول، والحالة الحية تذكر الأسماء فقط', async () => {
  const s = await a.selfState()
  assert.deepEqual(s.databases, ['نبراس (falak — falak)', 'جداول سراج (waqti — waqti)'])
  const cap = capabilitiesForPrompt(s)
  assert.match(cap, /db_query/)
  assert.doesNotMatch(cap, /postgres:\/\//)

  await a.settings.update({ features: { db_access: false } })
  const q = 'كم طالب في نبراس؟'
  script[q] = { actions: [{ type: 'db_query', db_query: 'نبراس', question: q }], reply: '' }
  const calls = sqlPrompts.length
  assert.equal(await say(q), 'الوصول لقواعد البيانات موقف من لوحة التحكم 🔒')
  assert.equal(sqlPrompts.length, calls, 'ما استدعى النموذج ولا القاعدة')
  assert.match(capabilitiesForPrompt(await a.selfState()), /موقف من لوحة التحكم/)
})
