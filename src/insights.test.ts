import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { WeeklyInsights, formatReport, MIN_REQUESTS } from './insights/weekly.js'

const FRI = new Date('2026-10-09T14:30:00Z')   // الجمعة ١٧:٣٠ الرياض

async function setup(llm: any = null) {
  const db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  const store = new Store(db)
  const w = new WeeklyInsights({ db, llm, now: () => FRI, tz: 'Asia/Riyadh' })
  const claimed = new Set<string>()
  const claim = async (k: string, v: string) => { const key = `${k}=${v}`; if (claimed.has(key)) return false; claimed.add(key); return true }
  return { db, store, w, claim }
}

test('لا تقرير إن كان النشاط أقل من الحد، ولا خارج الجمعة/الوقت، ولا موقوفاً', async () => {
  const { db, store, w, claim } = await setup()
  for (let i = 0; i < MIN_REQUESTS - 1; i++) await store.addTurn('user', `طلب ${i}`)
  assert.equal(await w.scheduled({ enabled: true, at: '17:00', claim }), null)
  await store.addTurn('user', 'ذكرني بالاجتماع')
  assert.equal(await w.scheduled({ enabled: false, at: '17:00', claim }), null)
  assert.equal(await w.scheduled({ enabled: true, at: '20:45', claim }), null, 'قبل الوقت')
  const parts = await w.scheduled({ enabled: true, at: '17:00', claim })
  assert.ok(parts?.[0].startsWith('📈 تقريرك الأسبوعي'))
  assert.equal(await w.scheduled({ enabled: true, at: '17:00', claim }), null, 'مرة واحدة')
  const thu = new WeeklyInsights({ db, llm: null, now: () => new Date('2026-10-08T14:30:00Z'), tz: 'Asia/Riyadh' })
  assert.equal(await thu.scheduled({ enabled: true, at: '17:00', claim: async () => true }), null, 'الجمعة فقط')
  await db.close()
})

test('الأرقام من القاعدة والنصائح من النموذج، وعند فشله نصائح قواعدية', async () => {
  const llm = { async complete() { return '{"summary":"أسبوع نشيط","tips":["ركّز على مهمة واحدة كل صباح"]}' } }
  const a = await setup(llm)
  await a.store.addTurn('user', 'أضف مهمة مراجعة العقد')
  await a.store.addTurn('user', 'عدّل كود الصفحة الرئيسية')
  const t = await a.store.addTask({ title: 'قديمة', due_at: new Date('2026-10-01T00:00:00Z') })
  const txt = await a.w.report()
  assert.match(txt, /أسبوع نشيط/)
  assert.match(txt, /ركّز على مهمة واحدة/)
  assert.match(txt, /طلباتك: ٢ في/)
  assert.match(txt, /متأخرة ١/)
  assert.ok(t.id)
  await a.db.close()

  const b = await setup({ async complete() { throw new Error('down') } })
  await b.store.addTask({ title: 'متأخرة', due_at: new Date('2026-10-01T00:00:00Z') })
  assert.match(await b.w.report(), /مهمة متأخرة/)
  await b.db.close()
})

test('formatReport بلا نموذج يعرض الأرقام والنصائح مرقّمة', () => {
  const f: any = { requests: 7, activeDays: 3, busiestDay: { name: 'الاثنين', count: 4 }, peakHour: { h: 9, count: 3 }, lateNight: 0, themes: [{ theme: 'code', count: 3 }],
    tasks: { created: 2, done: 1, open: 3, overdue: 0, stale: 0, reminders: 0 }, projects: { open: 0, overdue: 0, doneThisWeek: 0, highOpen: 0, topProject: null, topProjectOpen: 0 }, codeJobs: { total: 0, merged: 0, failed: 0 }, samples: [] }
  const t = formatReport(f, '', ['أ', 'ب'])
  assert.match(t, /١\. أ\n٢\. ب/)
  assert.match(t, /تعديلات كود \(٣\)/)
})
