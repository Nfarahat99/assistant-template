/**
 * متتبّع مشاريع البزنس: إضافة/إنهاء/عرض/ترتيب، الموجز اليومي والأسبوعي، الإيقاف من الإعدادات،
 * اقتراحات Railway بموافقة، تأكيد الحذف، وقائمة الإطلاق.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import type { RailwayClient, RwService } from './clients/railway.js'
import type { GatewayClient } from './clients/gateway.js'
import type { LlmClient } from './ai/providers.js'
import { parseLlmOutput } from './ai/schema.js'
import {
  ProjectItems, rankItems, formatBrief, splitMessage, scoreItem, normDate, type ProjectItem, type RankCtx,
} from './projects/items.js'
import { guessKind } from './projects/tracker.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

// الأربعاء ٧ أكتوبر ٢٠٢٦، ٠٦:٠٠ بتوقيت الرياض
let clock = new Date('2026-10-07T03:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const services: RwService[] = [
  {
    projectId: 'p1', projectName: 'nakhla', serviceId: 's-q', serviceName: 'web', environmentId: 'e', environmentName: 'production',
    repo: 'example-user/nakhla', image: null, domains: ['example-nakhla-production.up.railway.app'],
    latest: { id: 'd1', status: 'SUCCESS', createdAt: clock.toISOString(), commitHash: 'abc', commitMessage: null, url: null },
  },
  {
    projectId: 'p2', projectName: 'falak', serviceId: 's-s', serviceName: 'app', environmentId: 'e', environmentName: 'production',
    repo: 'example-user/falak', image: null, domains: ['falak.example.com'],
    latest: { id: 'd2', status: 'FAILED', createdAt: clock.toISOString(), commitHash: 'def', commitMessage: null, url: null },
  },
]
const railway: RailwayClient = {
  async listServices() { return services },
  async deployments() { return [] }, async logs() { return [] }, async redeploy() {},
  async projects() { return [] }, async details() { return [] }, async findTargets() { return [] },
}
const script: Record<string, any> = {}
let checklistReply = ''
const llm: LlmClient = {
  async complete(system, user) {
    if (system.startsWith('أنت تجهّز قائمة إطلاق')) return checklistReply
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: '?' }], reply: '' })
  },
}

let db: Db, store: Store, a: Assistant, items: ProjectItems
let seq = 0
const say = async (text: string, actions?: any[]) => {
  if (actions) script[text] = { actions, reply: '' }
  clock = new Date(clock.getTime() + 2_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `P${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
  return sent.at(-1)!
}
const lastPendingNo = async () => (await store.openPending(clock)).filter((p) => p.kind === 'project_items').at(-1)!.short_no

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  items = new ProjectItems(db)
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([
    { folder: 'C:/nakhla', repo: 'example-user/nakhla', default_branch: 'main', aliases: ['نخلة'], railway_project: 'nakhla' },
    { folder: 'C:/qandeel', repo: 'example-user/qandeel', default_branch: 'main', aliases: ['قنديل'] },
    { folder: 'C:/falak', repo: 'example-user/falak', default_branch: 'main', aliases: ['نبراس'], railway_project: 'falak' },
    { folder: 'C:/old', repo: 'example-user/oldie', default_branch: 'main', aliases: ['القديم'], note: 'archive' },
  ])))
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github: null, projects, now: () => clock, railway })
  // الافتراضي في القالب: موقف — هذه الاختبارات عن الموجز وهو مفعّل
  await a.settings.update({ features: { project_status_daily: true } })
})
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0 })

// ───── دوال صافية ─────

const mk = (o: Partial<ProjectItem>): ProjectItem => ({
  id: 1, project_key: 'k', project_label: 'ك', title: 't', kind: 'other', status: 'todo', priority: 2, due_date: null, notes: null,
  position: null, source: 'owner', created_at: new Date('2026-10-01T00:00:00Z'), updated_at: new Date(), done_at: null, ...o,
})
const rctx = (profiles: Record<string, any> = {}): RankCtx => ({
  today: '2026-10-07', tzDate: (d) => d.toISOString().slice(0, 10),
  profiles: new Map(Object.entries(profiles).map(([k, stage]) => [k, { project_key: k, project_label: k, stage, audience: null, revenue_model: null, updated_at: new Date() }])),
})

test('الترتيب: المتأخر ثم العالي ثم ما يمنع الإطلاق، والمتوقف آخراً', () => {
  const list = [
    mk({ id: 1, title: 'عادي' }),
    mk({ id: 2, title: 'متأخر', due_date: '2026-10-05' }),
    mk({ id: 3, title: 'عالي', priority: 1 }),
    mk({ id: 4, title: 'دومين قبل الإطلاق', kind: 'domain', project_key: 'pre' }),
    mk({ id: 5, title: 'عالي في مشروع متوقف', priority: 1, project_key: 'zz' }),
  ]
  const c = rctx({ pre: 'building', zz: 'paused' })
  assert.deepEqual(rankItems(list, c).map((i) => i.id), [2, 3, 4, 1, 5])
  // بعد الإطلاق: التسويق يتقدم على الميزة
  const post = rctx({ x: 'launched' })
  assert.ok(scoreItem(mk({ project_key: 'x', kind: 'marketing' }), post) > scoreItem(mk({ project_key: 'x', kind: 'feature' }), post))
  // الركود يرفع الدرجة
  assert.ok(scoreItem(mk({ created_at: new Date('2026-09-01T00:00:00Z') }), c) > scoreItem(mk({ created_at: new Date('2026-10-06T00:00:00Z') }), c))
})

test('normDate وguessKind', () => {
  assert.equal(normDate('2026-10-12T09:00:00+03:00'), '2026-10-12')
  assert.equal(normDate('2026-02-30'), null)
  assert.equal(normDate('بكرة'), null)
  assert.equal(guessKind('ما ركبنا دومين'), 'domain')
  assert.equal(guessKind('حملة تسويق قبل رمضان'), 'marketing')
  assert.equal(guessKind('شي غريب'), 'other')
})

test('المخطط: أولوية high تتحول لـ 1، والنوع الغريب لا يرفض الرد', () => {
  const r = parseLlmOutput(JSON.stringify({ actions: [{ type: 'project_item_add', project_query: 'قنديل', title: 'حملة', kind: 'weird', priority: 'high' }], reply: '' }))
  assert.ok(r.ok)
  const act = r.ok && r.value.actions[0]
  assert.equal((act as any).priority, 1)
  assert.equal((act as any).kind, undefined)
  assert.ok(!parseLlmOutput(JSON.stringify({ actions: [{ type: 'project_item_update', status: 'done' }], reply: '' })).ok, 'لازم رقم أو نص')
})

test('التقسيم: الموجز الطويل ينقسم تحت حد تيليجرام بلا قص', () => {
  const many = Array.from({ length: 300 }, (_, i) => mk({ id: i + 1, project_key: `p${i % 40}`, project_label: `مشروع ${i % 40}`, title: `بند طويل نسبياً رقم ${i} `.repeat(3) }))
  const parts = formatBrief({ date: 'الأربعاء', items: many, profiles: [], ctx: rctx() })
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 3900, `طول ${p.length}`)
  assert.ok(parts.join('\n\n').includes('مشروع 39'))
  assert.deepEqual(splitMessage('a\n\nb', 3), ['a', 'b'])
})

// ───── التكامل عبر المحادثة ─────

test('إضافة بلا موافقة، إنهاء بالنص وبالرقم، و"وش باقي على"', async () => {
  let r = await say('نخلة ما ركبنا لها دومين', [{ type: 'project_item_add', project_query: 'نخلة', title: 'تركيب دومين' }])
  assert.match(r, /📌 سجّلت على نخلة: 🌐 تركيب دومين/)
  r = await say('قنديل: لازم نسوي حملة تسويق قبل رمضان', [{ type: 'project_item_add', project_query: 'قنديل', title: 'حملة تسويق قبل رمضان', kind: 'marketing', priority: 1, due_date: '2027-02-01' }])
  assert.match(r, /📣 حملة تسويق قبل رمضان \(أولوية عالية، الموعد 2027-02-01\)/)
  await say('قنديل: صفحة هبوط', [{ type: 'project_item_add', project_query: 'قنديل', title: 'صفحة هبوط', kind: 'launch' }])
  // تكرار نفس البند لا يُضاف مرتين
  assert.match(await say('نخلة: تركيب دومين', [{ type: 'project_item_add', project_query: 'نخلة', title: 'تركيب دومين' }]), /موجودة من قبل/)
  assert.equal((await items.open()).length, 3)

  r = await say('وش باقي على قنديل؟')
  assert.match(r, /📁 قنديل — ٢ مفتوحة/)
  assert.ok(r.indexOf('حملة تسويق') < r.indexOf('صفحة هبوط'), 'العالية أولاً')

  r = await say('خلصت دومين نخلة', [{ type: 'project_item_update', project_query: 'نخلة', query: 'دومين', status: 'done' }])
  assert.match(r, /✅ خلصت: نخلة — تركيب دومين — ما بقى شي مفتوح/)
  const landing = (await items.open()).find((i) => i.title === 'صفحة هبوط')!
  r = await say(`خلصت بند ${landing.id}`)
  assert.match(r, /✅ خلصت: قنديل — صفحة هبوط \(باقي ١ مفتوحة\)/)
  assert.equal((await items.open()).length, 1)
})

test('مشروع ما له مستودع يُسجَّل باسمه، والمرحلة تتحدث', async () => {
  const r = await say('عزم: نجهز عرض للعملاء', [{ type: 'project_item_add', project_query: 'عزم', title: 'عرض للعملاء', kind: 'sales' }])
  assert.match(r, /سجّلت على عزم/)
  assert.match(r, /مشروع جديد/)
  assert.match(await say('قنديل صارت مطلقة', [{ type: 'project_stage', project_query: 'قنديل', stage: 'launched' }]), /المرحلة: مطلق[\s\S]*مبروك/)
  assert.equal((await items.profile('example-user/qandeel'))!.stage, 'launched')
})

test('الحذف يحتاج تأكيد: المعاينة أولاً ثم "نعم N"', async () => {
  const it = await items.add({ project_key: 'example-user/falak', project_label: 'نبراس', title: 'بند للحذف' }, clock)
  let r = await say(`احذف بند ${it.id}`)
  assert.match(r, /🗑️ أحذف البند من نبراس: بند للحذف؟[\s\S]*نعم \d+/)
  assert.ok(await items.get(it.id), 'ما انحذف قبل الموافقة')
  r = await say(`نعم ${await lastPendingNo()}`)
  assert.match(r, /حذفته من نبراس/)
  assert.equal(await items.get(it.id), null)
})

test('"رتب لي مهام نبراس": ترتيب مقترح ← "نعم N" يعتمده', async () => {
  const low = await items.add({ project_key: 'example-user/falak', project_label: 'نبراس', title: 'محتوى انستقرام', kind: 'content', priority: 3 }, clock)
  const late = await items.add({ project_key: 'example-user/falak', project_label: 'نبراس', title: 'عقد المدرسة', kind: 'sales', due_date: '2026-10-01' }, clock)
  let r = await say('رتب لي مهام نبراس', [{ type: 'project_items', project_query: 'نبراس', mode: 'prioritize' }])
  assert.match(r, /🧭 ترتيبي المقترح لـ نبراس/)
  assert.ok(r.indexOf('عقد المدرسة') < r.indexOf('محتوى انستقرام'))
  r = await say(`نعم ${await lastPendingNo()}`)
  assert.match(r, /اعتمدت الترتيب/)
  assert.equal((await items.get(late.id))!.position, 1)
  assert.equal((await items.get(low.id))!.position, 2)
})

test('قائمة الإطلاق: النموذج يكيّفها، والموجود يُستبعد، والحفظ بعد الموافقة', async () => {
  checklistReply = JSON.stringify({ items: [
    { title: 'حملة تسويق قبل رمضان', kind: 'marketing' },   // موجود ← يُستبعد
    { title: 'تركيب دومين', kind: 'domain' },
    { title: 'باقات الأسعار للمدارس', kind: 'sales' },
    { title: 'سياسة الخصوصية', kind: 'admin' },
  ] })
  const before = (await items.open('example-user/qandeel')).length
  const r = await say('جهز قائمة إطلاق لقنديل', [{ type: 'project_checklist', project_query: 'قنديل' }])
  assert.match(r, /🚀 قائمة إطلاق قنديل \(٣ بند/)
  assert.doesNotMatch(r, /حملة تسويق/)
  assert.equal((await items.open('example-user/qandeel')).length, before, 'ما حُفظ شيء قبل الموافقة')
  assert.match(await say(`نعم ${await lastPendingNo()}`), /📌 أضفت ٣ بند على قنديل/)
  assert.equal((await items.open('example-user/qandeel')).length, before + 3)
})

test('اقتراحات Railway: دومين railway فقط / نشر فاشل ← معاينة؛ القبول يضيف، والرفض لا يتكرر', async () => {
  let r = await say('وش تقترح على مشاريعي؟', [{ type: 'project_suggest' }])
  assert.match(r, /💡 لاحظت من Railway/)
  // نخلة: عندها بند دومين منجز من قبل ← لا اقتراح دومين؛ نبراس: آخر نشر فاشل ← "نشر المشروع"
  assert.doesNotMatch(r, /نخلة: تركيب دومين/)
  assert.match(r, /🚀 نبراس: نشر المشروع \(ما فيه نسخة شغّالة\) — آخر نشر لـ app فشل/)
  assert.doesNotMatch(r, /القديم/, 'المؤرشف لا يُقترح عليه')
  assert.ok(!(await items.forProject('example-user/falak')).some((i) => i.kind === 'launch'), 'اقتراح فقط — ما انضاف قبل الموافقة')
  // القبول يضيفها كبنود
  assert.match(await say(`نعم ${await lastPendingNo()}`), /📌 أضفت ١ بند:\n• نبراس: نشر المشروع/)
  const added = (await items.forProject('example-user/falak')).find((i) => i.kind === 'launch')!
  assert.equal(added.source, 'suggestion')
  assert.equal(added.priority, 1)
  assert.match(await say('وش تقترح على مشاريعي؟', [{ type: 'project_suggest' }]), /ما لقيت شي جديد أقترحه/)
  // الرفض يُحفظ فلا يتكرر الاقتراح حتى لو انحذف البند
  await items.remove([added.id])
  await say('وش تقترح على مشاريعي؟', [{ type: 'project_suggest' }])
  assert.match(await say(`لا ${await lastPendingNo()}`), /ما راح أقترحها مرة ثانية/)
  assert.match(await say('وش تقترح على مشاريعي؟', [{ type: 'project_suggest' }]), /ما لقيت شي جديد أقترحه/)
})

test('الموجز اليومي في وقته مرة واحدة، والإيقاف من الإعدادات يمنعه', async () => {
  // بند قديم معلّق من ١٢ يوم
  const old = await items.add({ project_key: 'example-user/nakhla', project_label: 'نخلة', title: 'ربط بوابة الدفع', kind: 'sales', priority: 1 }, new Date('2026-09-25T09:00:00Z'))
  clock = new Date('2026-10-07T06:05:00Z')   // الأربعاء ٠٩:٠٥ الرياض
  await a.tick()
  const brief = sent.find((m) => m.startsWith('📊 مشاريعك اليوم'))
  assert.ok(brief, sent.join('\n---\n'))
  assert.match(brief!, /🎯 أهم الخطوات:/)
  assert.match(brief!, /نخلة: ربط بوابة الدفع — معلّقة من ١٢ يوم/)
  assert.match(brief!, /⏰ متأخرة:|عقد المدرسة — متأخرة ٦ يوم/)
  assert.match(brief!, /📁 المشاريع:\n• /)
  assert.match(brief!, /👉 ركّز اليوم على: /)
  sent.length = 0
  await a.projectBriefTick()
  assert.equal(sent.length, 0, 'مرة واحدة في اليوم')

  // اليوم التالي، الميزة موقفة
  await a.settings.update({ features: { project_status_daily: false } })
  clock = new Date('2026-10-08T06:10:00Z')
  await a.projectBriefTick()
  assert.equal(sent.length, 0)
  await a.settings.update({ features: { project_status_daily: true }, project_status_at: '10:30' })
  await a.projectBriefTick()
  assert.equal(sent.length, 0, 'قبل الوقت المضبوط')
  clock = new Date('2026-10-08T07:31:00Z')
  await a.projectBriefTick()
  assert.ok(sent.some((m) => m.startsWith('📊 مشاريعك اليوم')))
  await items.update(old.id, { status: 'done' }, clock)
})

test('الأحد: موجز أسبوعي بالمرحلة والمنجز والمشاريع الفاضية + اقتراحات للموافقة', async () => {
  await a.settings.update({ project_status_at: '09:00' })
  clock = new Date('2026-10-11T06:15:00Z')   // الأحد ٠٩:١٥ الرياض
  await a.projectBriefTick()
  const weekly = sent.find((m) => m.startsWith('📊 مشاريعك هذا الأسبوع'))
  assert.ok(weekly, sent.join('\n---\n'))
  assert.match(weekly!, /📁 قنديل \(مطلق\): \d|📁 قنديل \(مطلق\): [٠-٩]/)
  assert.match(weekly!, /✅ خلّصت هالأسبوع/)
  assert.doesNotMatch(weekly!, /القديم/, 'المؤرشف ما يُذكر')
  // "حالة المشاريع" عند الطلب
  sent.length = 0
  assert.match(await say('حالة المشاريع'), /📊 مشاريعك اليوم/)
})

test('الموجز لا يُرسل لمن ما استخدم المتتبّع، ولا يومياً بلا بنود', async () => {
  const db2 = await createDb({ pgliteDir: 'memory://' })
  await migrate(db2)
  const out: string[] = []
  const gw2: GatewayClient = { async sendText(_f, _t, t) { out.push(t); return { id: 'x', status: 'queued' } }, async getMessage(id) { return { id, status: 'sent' } } }
  const sunday = new Date('2026-10-11T06:15:00Z')
  const b = new Assistant({ cfg, store: new Store(db2), llm, stt: { async transcribe() { return '' } }, gateway: gw2, github: null,
    projects: new ProjectRegistry(parseProjects(JSON.stringify([{ folder: 'x', repo: 'a/b', aliases: ['بي'] }]))), now: () => sunday, railway: null })
  await b.settings.update({ features: { project_status_daily: true } })
  await b.projectBriefTick()
  assert.equal(out.length, 0)
  await db2.close()
})
