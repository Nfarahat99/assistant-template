/**
 * التذكيرات المتكررة والسياق (كل الرسائل والعناوين هنا مصطنعة) — نمط التعثّر: تذكيرات يومية ما توصل أبداً.
 * - التذكيرات المتكررة (tasks.recurrence + task_occurrences)
 * - الورد بعد التفعيل وسط اليوم → القناة الأساسية (تيليجرام)
 * - حجب المفاتيح في قراءة الصور، مرجع الصورة، "هل هو متصل" ليس عن البوت،
 *   خلاصة Claude بدل التخمين عند انتهاء التشغيل بلا PR، وتلوّث سياق طلبات الكود بين المشاريع.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import { Settings } from './settings.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient, WorkflowRun } from './clients/github.js'
import { conclusionFromLog } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'
import type { OwnerChannel } from './channels.js'
import { parseRecurrence, nextOccurrence, anchorRecurrence, streak, formatRecurrence, expectedBetween } from './lib/recurrence.js'
import { maskSecrets } from './lib/secrets.js'
import { stripSelfStatus } from './lib/reply-guards.js'
import { detectCorrections, scopeOwnerTurns, scopeRelatedJobs, mentionedRepos, type TopicScope } from './lib/code-context.js'
import { morningBrief, eveningReview, formatTaskList } from './format.js'
import { parseLlmOutput } from './ai/schema.js'
import { systemPrompt } from './ai/understand.js'

const TZ = 'Asia/Riyadh'
const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ } as any)
/** وقت الرياض → UTC */
const riyadh = (iso: string) => new Date(`${iso}+03:00`)

// ═════════════ مكتبة التكرار ═════════════

test('parseRecurrence: daily / weekly:<days> / every_n_days:<n> / weekdays + الصيغ العربية', () => {
  assert.deepEqual(parseRecurrence('daily', '21:00'), { kind: 'daily', time: '21:00' })
  assert.deepEqual(parseRecurrence('daily@21:30'), { kind: 'daily', time: '21:30' })
  assert.deepEqual(parseRecurrence('weekly:0,3', '09:00'), { kind: 'weekly', days: [0, 3], time: '09:00' })
  assert.deepEqual(parseRecurrence('weekly:الأحد'), { kind: 'weekly', days: [0], time: '09:00' })
  assert.deepEqual(parseRecurrence('every_n_days:2', '21:00'), { kind: 'every_n_days', n: 2, time: '21:00' })
  assert.deepEqual(parseRecurrence('weekdays', '07:30'), { kind: 'weekdays', time: '07:30' })
  assert.deepEqual(parseRecurrence('يومياً'), { kind: 'daily', time: '09:00' })
  assert.deepEqual(parseRecurrence('كل يومين'), { kind: 'every_n_days', n: 2, time: '09:00' })
  assert.deepEqual(parseRecurrence('كل أحد'), { kind: 'weekly', days: [0], time: '09:00' })
  assert.deepEqual(parseRecurrence({ kind: 'daily', time: '21:00' }), { kind: 'daily', time: '21:00' })
  assert.deepEqual(parseRecurrence('{"kind":"weekly","days":[4],"time":"18:00"}'), { kind: 'weekly', days: [4], time: '18:00' })
  for (const bad of [null, '', 'once', 'every_n_days', 'blah', { kind: 'monthly' }]) assert.equal(parseRecurrence(bad as any), null, String(bad))
  assert.equal(formatRecurrence({ kind: 'daily', time: '21:00' }), 'يومياً 9:00م')
})

test('nextOccurrence: لا يرجع ماضياً أبداً، ويتخطى الفائت؛ أسبوعي/كل يومين/أيام الدوام', () => {
  const daily = { kind: 'daily' as const, time: '21:00' }
  assert.equal(nextOccurrence(daily, riyadh('2026-10-07T11:00'), TZ).toISOString(), riyadh('2026-10-07T21:00').toISOString())
  assert.equal(nextOccurrence(daily, riyadh('2026-10-07T21:00'), TZ).toISOString(), riyadh('2026-10-08T21:00').toISOString(), 'نفس اللحظة ← الموعد التالي')
  // متأخر ٣ أيام ← الموعد القادم فقط (لا تراكم)
  assert.equal(nextOccurrence(daily, riyadh('2026-10-10T22:00'), TZ).toISOString(), riyadh('2026-10-11T21:00').toISOString())
  // 2026-10-07 أربعاء ← "كل أحد" = 11 أكتوبر
  assert.equal(nextOccurrence({ kind: 'weekly', days: [0], time: '09:00' }, riyadh('2026-10-07T11:00'), TZ).toISOString(), riyadh('2026-10-11T09:00').toISOString())
  // أيام الدوام: الخميس مساءً ← الأحد (الجمعة والسبت عطلة)
  assert.equal(nextOccurrence({ kind: 'weekdays', time: '07:30' }, riyadh('2026-10-08T20:00'), TZ).toISOString(), riyadh('2026-10-11T07:30').toISOString())
  const e2 = anchorRecurrence({ kind: 'every_n_days', n: 2, time: '21:00' }, riyadh('2026-10-07T21:00'), TZ)
  assert.equal(e2.start, '2026-10-07')
  assert.equal(nextOccurrence(e2, riyadh('2026-10-07T22:00'), TZ).toISOString(), riyadh('2026-10-09T21:00').toISOString())
  assert.deepEqual(expectedBetween(e2, '2026-10-07', '2026-10-13'), ['2026-10-07', '2026-10-09', '2026-10-11', '2026-10-13'])
})

test('streak: متتالية حتى اليوم، موعد اليوم غير المنجز لا يكسرها، والفائت يكسرها', () => {
  const daily = { kind: 'daily' as const, time: '21:00' }
  assert.equal(streak(daily, new Set(['2026-10-05', '2026-10-06', '2026-10-07']), '2026-10-07'), 3)
  assert.equal(streak(daily, new Set(['2026-10-05', '2026-10-06']), '2026-10-07'), 2, 'اليوم ما خلص')
  assert.equal(streak(daily, new Set(['2026-10-04', '2026-10-06']), '2026-10-07'), 1, '5 فائت')
  assert.equal(streak({ kind: 'weekly', days: [0], time: '09:00' }, new Set(['2026-09-27', '2026-10-04']), '2026-10-07'), 2)
})

test('schema: add_task يقبل recurrence وremind_at؛ stop_reminder؛ والقيمة الغريبة لا ترفض الرد', () => {
  const r = parseLlmOutput(JSON.stringify({ actions: [
    { type: 'add_task', title: 'قراءة كتاب', due_at: '2026-10-07T21:00:00+03:00', remind_at: '2026-10-07T21:00:00+03:00', recurrence: 'daily' },
    { type: 'add_task', title: 'ورد', recurrence: { kind: 'weekly', days: [0] } },
    { type: 'add_task', title: 'x', recurrence: 42 },
    { type: 'stop_reminder', task_id: 27 },
    { type: 'set_reminder', text: 'رياضة', at: '2026-10-07T18:00:00+03:00', recurrence: 'every_n_days:2' },
  ], reply: '' }))
  assert.ok(r.ok)
  const a = (r as any).value.actions
  assert.equal(a[0].recurrence, 'daily'); assert.equal(a[0].remind_at, '2026-10-07T21:00:00+03:00')
  assert.match(a[1].recurrence, /"weekly"/)
  assert.equal(a[2].recurrence, undefined)
  assert.equal(a[3].task_id, 27)
  assert.equal(a[4].recurrence, 'every_n_days:2')
  // قواعد البرومبت
  assert.match(systemPrompt(), /لا تنشئ عادة يومية كمهمة لمرة واحدة أبداً/)
  assert.match(systemPrompt(), /remind_at = due_at/)
  assert.match(systemPrompt(), /"recurrence":"daily\|weekly/)
})

// ═════════════ المساعد كاملاً ═════════════

let clock = riyadh('2026-10-07T11:00')
const wa: string[] = []
const tg: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { wa.push(text); return { id: `g${wa.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const tgChannel: OwnerChannel = { name: 'telegram', available: () => true, async send(text) { tg.push(text); return { id: `t${tg.length}`, quoteKey: null } } }
const users: string[] = []
const script: Record<string, any> = {}
let onUser: ((user: string) => any) | null = null
const llm: LlmClient = {
  async complete(_system, user) {
    users.push(user)
    const custom = onUser?.(user)
    if (custom) return JSON.stringify(custom)
    const msg = (user.split('رسالة وليد الجديدة:\n')[1] ?? '').split('\n(')[0].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: 'تمام' }], reply: '' })
  },
  async completeWithMedia() {
    return JSON.stringify({ kind: 'other', messages: [], reading: 'شاشة جهاز بصمة "بوابة الساحة الشرقية"، ومكتوب عليه مفصول.\n- الوسيط: متوقف.\n- الإجراء المقترح: "شغّل الوسيط على جهاز الإدارة في المدرسة".\n- مفتاح الوسيط: zk-Q7xDemoKey00ExampleOnly42' })
  },
  async completeWithAudio() {
    // الصوت المباشر فهم السؤال كسؤال عام (نمط الخطأ المقصود)
    return JSON.stringify({ transcript: 'طيب ليه مكتوب غير متصل؟ وش العلة', actions: [{ type: 'clarify', question: 'وش اللي طالع عندك غير متصل؟', options: ['واتساب سراج', 'خدمة على ريلواي', 'غيرهم'] }], reply: '' })
  },
}
const dispatches: { repo: string; prompt: string }[] = []
let runs: WorkflowRun[] = []
let conclusion: { text: string; url: string | null; source: 'issue' | 'log' } | null = null
const github: GitHubClient = {
  async dispatchWorkflow(repo, _wf, _ref, inputs) { dispatches.push({ repo, prompt: inputs.prompt }) },
  async listRuns() { return runs }, async findPrByBranch() { return null }, async getPr() { throw new Error('x') },
  async prFiles() { return [] }, async mergePr() { return { sha: 'x' } }, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
  async findIssue() { return null }, async findQuestion() { return null },
  async runConclusion() { return conclusion },
}
const projects = () => new ProjectRegistry(parseProjects(JSON.stringify([
  { folder: 'C:/waha-attendance', repo: 'example-user/waha-attendance', aliases: ['حضور الواحة', 'حضور', 'الحضور', 'waha-attendance'] },
  { folder: 'C:/app', repo: 'example-user/qandeel-hub', aliases: ['قنديل', 'qandeel'] },
  { folder: 'C:/sirajplus', repo: 'example-user/sirajplus', aliases: ['سراج بلس', 'sirajplus'] },
  { folder: 'C:/whatsappSiraj', repo: 'example-user/whatsapp-siraj', aliases: ['واتساب سراج'] },
])))

let db: Db, store: Store, a: Assistant, settings: Settings
let seq = 0
async function say(text: string, extra: Partial<InboundPayload> = {}) {
  clock = new Date(clock.getTime() + 3_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `R${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null, ...extra,
  } as InboundPayload)
  await a.idle()
  return wa.at(-1) ?? ''
}
const tickAt = async (iso: string) => { clock = riyadh(iso); await a.tick(); await a.idle() }

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  settings = new Settings(cfg, store)
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects: projects(), now: () => clock, settings, ackAfterMs: 60_000 })
  // الملخصات وموجز المشاريع والتقارير لا تهمّنا هنا
  await settings.update({ features: { briefs: false, project_status_daily: false, weekly_insights: false, self_review: false, ai_news_digest: false } })
})
after(async () => { await db.close() })
beforeEach(() => { wa.length = 0; tg.length = 0; users.length = 0; onUser = null })

test('"كل يوم ٩ بالليل ذكرني بصفحتين من تفسير ابن كثير" ← مهمة متكررة: تذكير اليوم ٩م، ثم بكرة — تذكير واحد لكل موعد', async () => {
  clock = riyadh('2026-10-07T11:00')
  script['كل يوم ٩ بالليل ذكرني بصفحتين من تفسير ابن كثير'] = { actions: [{ type: 'set_reminder', text: 'صفحتين من تفسير ابن كثير', at: '2026-10-07T21:00:00+03:00', recurrence: 'daily' }], reply: '' }
  const r = await say('كل يوم ٩ بالليل ذكرني بصفحتين من تفسير ابن كثير')
  assert.match(r, /🔁 أضفت صفحتين من تفسير ابن كثير \((\d+)\) — يومياً 9:00م\. أول تذكير اليوم 9:00م/)
  const id = +/\((\d+)\)/.exec(r)![1]
  const t = (await store.getTask(id))!
  assert.equal(t.status, 'open')
  assert.equal(t.remind_at!.toISOString(), riyadh('2026-10-07T21:00').toISOString())
  await store.setKv('owner_last_channel', 'whatsapp')

  await tickAt('2026-10-07T20:59')
  assert.equal(wa.filter((m) => m.includes('⏰ تذكير')).length, 0)
  await tickAt('2026-10-07T21:00')
  await tickAt('2026-10-07T21:01')
  await tickAt('2026-10-07T23:00')
  const fired = wa.filter((m) => m.includes('⏰ تذكير: صفحتين من تفسير ابن كثير'))
  assert.equal(fired.length, 1, 'مرة واحدة للموعد')
  assert.match(fired[0], /🔁[\s\S]*التذكير الجاي بكرة 9:00م/)
  const after = (await store.getTask(id))!
  assert.equal(after.status, 'open', 'المتكررة لا تُقفل')
  assert.equal(after.remind_at!.toISOString(), riyadh('2026-10-08T21:00').toISOString())
  assert.equal(after.reminded_at, null)

  // الخدمة طافية ٣ أيام: تذكير واحد فقط ثم الموعد القادم في المستقبل (الفائت يُتخطّى)
  wa.length = 0
  await tickAt('2026-10-11T22:30')
  await tickAt('2026-10-11T22:31')
  assert.equal(wa.filter((m) => m.includes('⏰ تذكير: صفحتين من تفسير ابن كثير')).length, 1)
  assert.equal((await store.getTask(id))!.remind_at!.toISOString(), riyadh('2026-10-12T21:00').toISOString())
  await store.stopTask(id)
})

test('"مراجعة يومية لمتن الآجرومية" بموعد فقط ← تصير يومية (لا مرة واحدة)، والمهمة العادية بموعد لها remind_at', async () => {
  clock = riyadh('2026-10-07T11:00')
  script['سجل مهمة مراجعة يومية لمتن الآجرومية ٩ المسا'] = { actions: [{ type: 'add_task', title: 'مراجعة يومية لمتن الآجرومية', due_at: '2026-10-07T21:00:00+03:00' }], reply: '' }
  const r = await say('سجل مهمة مراجعة يومية لمتن الآجرومية ٩ المسا')
  const id = +/\((\d+)\)/.exec(r)![1]
  const t = (await store.getTask(id))!
  assert.equal(JSON.parse(t.recurrence!).kind, 'daily')
  assert.equal(t.remind_at!.toISOString(), riyadh('2026-10-07T21:00').toISOString())
  await store.stopTask(id)

  script['حط مهمة أكلم شركة الكهرباء بكرة ١٠ الصبح'] = { actions: [{ type: 'add_task', title: 'أكلم شركة الكهرباء', due_at: '2026-10-08T10:00:00+03:00' }], reply: '' }
  const r2 = await say('حط مهمة أكلم شركة الكهرباء بكرة ١٠ الصبح')
  const t2 = (await store.getTask(+/المهمة (\d+)/.exec(r2)![1]))!
  assert.equal(t2.recurrence, null)
  assert.equal(t2.remind_at!.toISOString(), riyadh('2026-10-08T10:00').toISOString(), 'مهمة لها وقت = لها تذكير')
  assert.match(r2, /⏰/)
  await store.completeTask(t2.id)
})

test('"خلصت N" على متكررة: يُسجَّل إنجاز اليوم، تبقى مفتوحة، تذكير اليوم يُلغى والقادم بكرة؛ والسلسلة تُعدّ', async () => {
  clock = riyadh('2026-10-07T11:00')
  const t = await store.addTask({ title: 'مطالعة الرحيق المختوم', source: 'reminder', due_at: riyadh('2026-10-07T21:00'), remind_at: riyadh('2026-10-07T21:00'), recurrence: '{"kind":"daily","time":"21:00"}' })
  const r = await say(`خلصت ${t.id}`)
  assert.match(r, /✅ سجّلت إنجاز اليوم: مطالعة الرحيق المختوم 🔁/)
  assert.match(r, /التذكير الجاي بكرة 9:00م/)
  let cur = (await store.getTask(t.id))!
  assert.equal(cur.status, 'open')
  assert.equal(cur.remind_at!.toISOString(), riyadh('2026-10-08T21:00').toISOString(), 'لا تذكير الليلة بشي خلّصه')
  assert.match(await say(`خلصت ${t.id}`), /مسجّل من قبل/)
  assert.deepEqual(await store.occurrenceDates(t.id, '2026-10-01'), ['2026-10-07'])

  // اليوم الثاني بعد التذكير (٩:٣٠م): الموعد القادم بكرة، والسلسلة ٢
  await tickAt('2026-10-08T21:00')
  clock = riyadh('2026-10-08T21:30')
  const r2 = await say(`خلصت ${t.id}`)
  assert.match(r2, /السلسلة: ٢ مرات متتالية/)
  cur = (await store.getTask(t.id))!
  assert.equal(cur.remind_at!.toISOString(), riyadh('2026-10-09T21:00').toISOString())

  // الملخص الصباحي: "اليوم 9:00م 🔁" — لا "متأخرة" ولا ⚠️ حتى لو بقي موعد قديم عالق
  await db.query(`UPDATE tasks SET remind_at=$2, due_at=$2 WHERE id=$1`, [t.id, riyadh('2026-10-03T21:00')])
  clock = riyadh('2026-10-09T07:30')
  const brief = morningBrief(await store.openTasks(), clock, TZ, await store.openReminders())
  assert.match(brief, new RegExp(`${t.id}\\. مطالعة الرحيق المختوم — اليوم 9:00م 🔁`))
  assert.doesNotMatch(brief, /الرحيق المختوم — [^\n]*⚠️/)
  assert.doesNotMatch(brief, /متأخرة:[\s\S]*الرحيق المختوم/)
  // المجدول يصلح العالق بلا تذكير متأخر قبل وقته
  await store.stopTask(t.id)
})

test('الملخص المسائي والقوائم: المتكررة بموعدها القادم 🔁، والمتأخرة العادية ⚠️ كما هي', async () => {
  const now = riyadh('2026-10-09T20:00')
  const rec = await store.addTask({ title: 'مراجعة يومية لمتن الآجرومية', due_at: riyadh('2026-10-04T21:00'), remind_at: riyadh('2026-10-04T21:00'), recurrence: '{"kind":"daily","time":"21:00"}' })
  const one = await store.addTask({ title: 'مهمة متأخرة', due_at: riyadh('2026-10-04T09:00') })
  const ev = eveningReview(await store.openTasks(), now, TZ)
  assert.match(ev, new RegExp(`${rec.id}\\. مراجعة يومية لمتن الآجرومية — اليوم 9:00م 🔁`))
  assert.match(ev, new RegExp(`${one.id}\\. مهمة متأخرة — [^\\n]*⚠️`))
  const overdue = formatTaskList(await store.openTasks(), 'overdue', now, TZ)
  assert.doesNotMatch(overdue, /الآجرومية/)
  assert.match(formatTaskList(await store.openTasks(), 'today', now, TZ), /الآجرومية — اليوم 9:00م 🔁/)
  await store.deleteTask(rec.id); await store.deleteTask(one.id)
})

test('"وقف تذكير N" يوقف المتكرر (لا تذكيرات بعدها)، و"احذف N" يحذف', async () => {
  clock = riyadh('2026-10-07T11:00')
  const t = await store.addTask({ title: 'أذكار المساء', due_at: riyadh('2026-10-07T21:00'), remind_at: riyadh('2026-10-07T21:00'), recurrence: '{"kind":"daily","time":"21:00"}' })
  assert.match(await say(`وقف تذكير ${t.id}`), /🔕 وقفت التذكير المتكرر لـ«أذكار المساء»/)
  assert.equal((await store.getTask(t.id))!.status, 'done')
  await tickAt('2026-10-07T21:00')
  assert.equal(wa.filter((m) => m.includes('أذكار المساء')).length, 1, 'رد الإيقاف فقط — لا تذكير')
  const t2 = await store.addTask({ title: 'تذكير للحذف', recurrence: '{"kind":"daily","time":"21:00"}', remind_at: riyadh('2026-10-08T21:00') })
  assert.match(await say(`احذف ${t2.id}`), /🗑️ حذفت «تذكير للحذف»/)
  assert.equal(await store.getTask(t2.id), null)
  // عبر النموذج: "بطّل تذكير الدرس"
  const t3 = await store.addTask({ title: 'سماع درس الفقه', recurrence: '{"kind":"daily","time":"21:00"}', remind_at: riyadh('2026-10-08T21:00') })
  script['بطّل تذكير درس الفقه'] = { actions: [{ type: 'stop_reminder', query: 'درس الفقه' }], reply: '' }
  assert.match(await say('بطّل تذكير درس الفقه'), /🔕 وقفت/)
  assert.equal((await store.getTask(t3.id))!.status, 'done')
})

test('الورد: التفعيل وسط اليوم (١٤:٠٠) ← ٣ تذكيرات بين ١٤:٠١ و٢١:٠٠ فقط، كلها على القناة الأساسية (تيليجرام)', async () => {
  a.attachTelegram(tgChannel)
  clock = riyadh('2026-10-07T13:00')
  await store.setKv('owner_last_channel', 'telegram')
  await tickAt('2026-10-07T13:30')
  assert.equal(tg.length + wa.length, 0, 'الميزة موقفة')
  // التفعيل من اللوحة يُحفظ في kv — والمجدول يقرأ الإعدادات من القاعدة كل دقيقة
  await store.setKv('settings', JSON.stringify({ ...settings.get(), features: { ...settings.get().features, quran_wird: true }, wird_count: 3, wird_from: '08:00', wird_to: '21:00' }))
  const times: string[] = []
  for (let m = 14 * 60; m <= 22 * 60; m += 5) {
    const iso = `2026-10-07T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    const before = tg.length
    await tickAt(iso)
    if (tg.length > before) times.push(iso.slice(11))
  }
  const wird = tg.filter((m) => /ورد|القرآن|كتاب الله|المصحف/.test(m))
  assert.equal(wird.length, 3, `3 تذكيرات (${times.join(', ')})`)
  assert.equal(wa.length, 0, 'لا شيء على واتساب — القناة الأساسية تيليجرام')
  for (const t of times) assert.ok(t > '14:00' && t <= '21:05', t)
  // اليوم التالي: خطة جديدة كاملة من ٨ص
  tg.length = 0
  for (let m = 7 * 60; m <= 22 * 60; m += 10) await tickAt(`2026-10-08T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  assert.equal(tg.filter((m) => /ورد|القرآن|كتاب الله|المصحف/.test(m)).length, 3)
  await settings.update({ features: { quran_wird: false } })
})

// ═════════════ الصور والسياق وخلاصة Claude ═════════════

const image = (): Partial<InboundPayload> => ({ type: 'image', text: null, media: { mimetype: 'image/jpeg', base64: 'IMG', seconds: null, ptt: false, file_name: null } })

test('(a) حجب المفاتيح: قراءة صورة فيها "مفتاح الوسيط: zk-…" لا تُعاد في الرد ولا تُحفظ في السجل', async () => {
  a.attachTelegram({ ...tgChannel, available: () => false })
  clock = riyadh('2026-10-07T12:20')
  await say('', image())
  const out = wa.at(-1)!
  assert.match(out, /الوسيط: متوقف/)
  assert.doesNotMatch(out, /Q7xDemoKey00ExampleOnly42/)
  assert.match(out, /مفتاح الوسيط: zk-•••• \(محجوب\)/)
  const turns = await store.lastTurns(4)
  assert.ok(turns.length && turns.every((t) => !t.text.includes('Q7xDemoKey00ExampleOnly42')), 'لا في دور المالك ولا رد البوت')
  // دالة الحجب: صيغ معروفة + قيمة طويلة بجانب كلمة مفتاح — بلا إيجابيات كاذبة على الأرقام التسلسلية والروابط
  assert.equal(maskSecrets('token: sk-proj-abcdefghijklmnop1234'), 'token: sk-•••• (محجوب)')
  assert.equal(maskSecrets('NVIDIA nvapi-AbCdEf1234567890xyz'), 'NVIDIA nvapi-•••• (محجوب)')
  assert.equal(maskSecrets('ghp_abcdefghijklmnop1234567890'), 'ghp_•••• (محجوب)')
  assert.equal(maskSecrets('password = Hunter2Hunter2Hunter2X'), 'password = •••• (محجوب)')
  assert.equal(maskSecrets('secret: 0123456789abcdef0123456789abcdef'), 'secret: •••• (محجوب)')
  for (const keep of ['الرقم التسلسلي: XY9Z000000042', 'https://github.com/example-user/waha-attendance/actions/runs/1000000003', 'commit 3e5a9d1', 'المستودع example-user/my-assistant']) assert.equal(maskSecrets(keep), keep)
})

test('(b) بعد الصورة مباشرة "🎤 طيب ليه مكتوب غير متصل" ← المرجع هو الصورة (الوسيط متوقف) — لا خيارات واتساب سراج/ريلواي', async () => {
  clock = riyadh('2026-10-07T12:30')
  await say('', image())
  onUser = (user) => /تنبيه سياق: رسالة وليد السابقة مباشرة كانت صورة/.test(user) && /الوسيط: متوقف/.test(user)
    ? { actions: [{ type: 'answer', text: 'اللي في الصورة إن الوسيط واقف على جهاز المدرسة — يشغلونه هناك ويرجع جهاز البصمة يتصل.' }], reply: '' }
    : { actions: [{ type: 'clarify', question: 'وش اللي طالع عندك غير متصل؟', options: ['واتساب سراج', 'خدمة على ريلواي', 'غيرهم'] }], reply: '' }
  const r = await say('', { type: 'audio', text: null, media: { mimetype: 'audio/ogg', base64: 'AUD', seconds: 3, ptt: true, file_name: null } })
  assert.match(r, /الوسيط/)
  assert.doesNotMatch(r, /واتساب سراج|ريلواي|رد برقم الخيار/)
  assert.equal(await store.getClarify(clock), null)
  // بعد رسالة أخرى بينهما: لا تلميح صورة
  await say('مهامي')
  onUser = null
  users.length = 0
  await say('ليه مفصول؟')
  assert.doesNotMatch(users.at(-1)!, /تنبيه سياق: رسالة وليد السابقة مباشرة كانت صورة/)
})

test('(c) "وش اللي عدّله كلود؟ وهو الحين شغال ولا لا" ← لا كلام عن حالة البوت (هو = الوسيط)', async () => {
  script['وش اللي عدّله كلود؟ وهو الحين شغال ولا لا'] = { actions: [{ type: 'answer', text: 'Claude ما غيّر شي — يقول العطل تشغيلي: الوسيط متوقف على جهاز المدرسة. البوت الحين شغال والواتساب مربوط ✅' }], reply: '' }
  const r = await say('وش اللي عدّله كلود؟ وهو الحين شغال ولا لا')
  assert.match(r, /الوسيط متوقف/)
  assert.doesNotMatch(r, /البوت الحين شغال|الواتساب مربوط/)
  // سؤال صريح عن البوت يبقى كما هو
  assert.equal(stripSelfStatus('أنا الحين أونلاين والواتساب متصل ✅', 'انت شغال؟'), 'أنا الحين أونلاين والواتساب متصل ✅')
  assert.equal(stripSelfStatus('الوسيط واقف.\nالبوت الحين شغال والواتساب مربوط ✅', 'هو رجع ولا لا'), 'الوسيط واقف.')
  assert.match(systemPrompt(), /لا تتكلم عن حالتك أنت/)
})

test('(d) Claude خلّص بلا PR ← نرسل خلاصته الفعلية (issue/سجل التشغيل) لا "يمكن ما احتاج تعديل"', async () => {
  clock = riyadh('2026-10-07T12:23')
  const mk = async (id: string) => {
    await store.addJob({ request_id: id, project: 'حضور الواحة', repo: 'example-user/waha-attendance', default_branch: 'main', request: 'فحص الوسيط', dispatched_at: new Date(clock.getTime() - 5 * 60_000) })
    runs = [{ id: 1000000003, name: 'Claude Code', display_title: `claude ${id}`, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example-user/waha-attendance/actions/runs/1000000003', created_at: new Date(clock.getTime() - 4 * 60_000).toISOString() }]
  }
  await mk('9d3b7f20')
  conclusion = { text: 'الكود سليم: الشاشة تحكم من آخر نبضة وصلت، والوسيط انطفى على جهاز المدرسة. المطلوب يشغلون «تشغيل-الوسيط.bat».', url: null, source: 'log' }
  await a.pollJobs(); await a.idle()
  const msg = wa.at(-1)!
  assert.match(msg, /📋 Claude خلّص على حضور الواحة بدون PR \(رقم 9d3b7f20\) — هذا اللي توصّل له/)
  assert.match(msg, /تشغيل-الوسيط\.bat/)
  assert.doesNotMatch(msg, /يمكن ما احتاج/)
  assert.equal((await store.getJob('9d3b7f20'))!.status, 'reported')
  // الخلاصة صارت في السجل ← "وش الخلاصة؟" يجاوب منها
  assert.ok((await store.lastTurns(3)).some((t) => t.text.includes('تشغيل-الوسيط.bat')))

  // بلا أي خلاصة: صراحة بدل تخمين
  await mk('aaaa0001')
  conclusion = null
  await a.pollJobs(); await a.idle()
  assert.match(wa.at(-1)!, /ما ترك أي شرح لقراره[\s\S]*ما راح أخمّن/)
  assert.doesNotMatch(wa.at(-1)!, /يمكن ما احتاج/)
  // ويُطلب من Claude دائماً issue عند عدم فتح PR
  conclusion = null; runs = []
  script['افحص الوسيط حق حضور الواحة'] = { actions: [{ type: 'code_change', project_query: 'حضور الواحة', request: 'فحص الوسيط' }], reply: '' }
  await say('افحص الوسيط حق حضور الواحة')
  const p = (await store.openPending(clock)).filter((x) => x.kind === 'code_change').at(-1)!
  await say(`نعم ${p.short_no}`)
  assert.match(dispatches.at(-1)!.prompt, /NO-PR RULE[\s\S]*\[claude-report\]/)
})

test('conclusionFromLog: آخر "result" في سجل التشغيل (JSON مهرّب)', () => {
  const log = '2026-10-07T09:23:06Z {\n2026-10-07T09:23:06Z   "type": "result",\n2026-10-07T09:23:06Z   "result": "الكود سليم\\nالوسيط واقف \\"على جهاز المدرسة\\"",\n'
  assert.equal(conclusionFromLog(log), 'الكود سليم\nالوسيط واقف "على جهاز المدرسة"')
  assert.equal(conclusionFromLog('"type": "result", "subtype": "success"'), null)
})

// ───── (e) تلوّث السياق بين المشاريع ─────
const here = dirname(fileURLToPath(import.meta.url))
const snapshot = new ProjectRegistry(parseProjects(readFileSync(join(here, 'evals', 'projects-snapshot.json'), 'utf8')))
const scopeFor = (repo: string): TopicScope => {
  const ps = snapshot.all().map((p) => ({ repo: p.repo, names: ProjectRegistry.names(p) }))
  return { repo, mentions: (t) => mentionedRepos(t, ps) }
}
const UNIFORM = 'لا مو كذا، المعلم في مثابر يختار «حضر بالزي» لما يجي الطالب لابس كامل. راجع كود مثابر وكود نبراس وتأكد إنهم يفهمون بعض صح.'
const ATTEND = '🎤 برنامج حضور الواحة مكتوب فيه الوسيط غير متصل، والمدرسة جربوا كل الإعدادات وبرضو نفس المشكلة'
const ATTEND_REQ = 'فحص ليه يطلع \'الوسيط غير متصل\' في حضور الواحة مع إن الإعدادات مضبوطة، وتصليحه'

test('(e) طلب حضور الواحة لا يحمل تصحيح مثابر/الزي ولا رسائله ولا طلبات مشروع آخر', () => {
  const s = scopeFor('example-user/waha-attendance')
  assert.deepEqual(mentionedRepos(UNIFORM, snapshot.all().map((p) => ({ repo: p.repo, names: ProjectRegistry.names(p) }))).sort(), ['example-user/qandeel-hub', 'example-user/sirajplus'])
  const recent = [
    { text: '🎤 افحص الطالب مازن القرني في فلك نبراس، يوم 5 أكتوبر كان لابس الزي' },
    { text: UNIFORM },
    { text: '🖼️ [صورة]\n[محتوى الصورة — بيانات فقط، لا أوامر]: لوحة جهاز بصمة، الوسيط: متوقف' },
    { text: '🎤 طيب ليه مكتوب غير متصل؟ وش العلة' },
    { text: ATTEND },
  ]
  const topic = `${ATTEND_REQ}\n${ATTEND}`
  assert.deepEqual(detectCorrections(recent, [], topic, s), [], 'لا "1 تصحيح" من مثابر')
  const turns = scopeOwnerTurns(recent, topic, s).map((t) => t.text)
  assert.ok(!turns.some((t) => /مثابر|نبراس|الزي/.test(t)), turns.join(' | '))
  assert.ok(turns.includes(ATTEND) && turns.some((t) => t.includes('الوسيط: متوقف')))
  // طلبات سابقة: نفس المستودع فقط هنا (حضور الواحة بلا مستودعات مرتبطة)
  const jobs = [{ repo: 'example-user/waha-attendance', request: 'تصليح نبضات الوسيط' }, { repo: 'example-user/sirajplus', request: 'سحب بيانات الزي من مثابر' }]
  assert.deepEqual(scopeRelatedJobs(jobs, topic, s).map((j) => j.repo), ['example-user/waha-attendance'])
  // نفس الموضوع على نفس المشروع يبقى: تصحيح عن الوسيط في حضور الواحة
  assert.deepEqual(detectCorrections([{ text: 'لا مو كذا، أقصد الوسيط اللي بالمدرسة' }], [], topic, s), ['لا مو كذا، أقصد الوسيط اللي بالمدرسة'])
  // والطلب على نبراس نفسه ما زال يحمل تصحيح مثابر (مستودع مرتبط + نفس الموضوع)
  assert.deepEqual(detectCorrections([{ text: UNIFORM }], [], 'تصحيح قراءة الزي القادم من مثابر داخل نبراس', scopeFor('example-user/sirajplus')), [UNIFORM.replace(/\s+/g, ' ')])
})

test('(e) المسار الكامل: معاينة طلب حضور الواحة بلا "تصحيح"، والبرومبت المرسل لـ Claude بلا مثابر/نبراس/الزي', async () => {
  clock = new Date()   // أدوار السجل تُختم بوقت القاعدة الحقيقي — نافذة ٤٨ ساعة تُحسب من هنا
  script[UNIFORM] = { actions: [{ type: 'answer', text: 'تمام' }], reply: '' }
  await say(UNIFORM)
  const msg = ATTEND.replace(/^🎤 /, '')
  script[msg] = { actions: [{ type: 'code_change', project_query: 'حضور الواحة', request: ATTEND_REQ }], reply: '' }
  const pv = await say(msg)
  assert.match(pv, /جهزت الطلب/)
  assert.doesNotMatch(pv, /تصحيح منك/)
  const p = (await store.openPending(clock)).filter((x) => x.kind === 'code_change').at(-1)!
  await say(`نعم ${p.short_no}`)
  const prompt = dispatches.at(-1)!.prompt
  assert.equal(dispatches.at(-1)!.repo, 'example-user/waha-attendance')
  assert.ok(prompt.includes('الوسيط غير متصل'))
  assert.doesNotMatch(prompt, /مثابر|نبراس|حضر بالزي/)
  assert.doesNotMatch(prompt, /## تصحيحات المالك/)
})

test('التقرير الأسبوعي يعدّ العادات: المنجز من المتوقع والسلسلة (من task_occurrences)', async () => {
  const { WeeklyInsights, formatReport } = await import('./insights/weekly.js')
  const t = await store.addTask({ title: 'ورد القرآن اليومي', recurrence: '{"kind":"daily","time":"21:00"}', remind_at: riyadh('2026-10-16T21:00') })
  for (const d of ['2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16']) await store.addOccurrence(t.id, d, riyadh(`${d}T21:30`))
  const wi = new WeeklyInsights({ db, llm: null, now: () => riyadh('2026-10-16T17:00'), tz: TZ })
  const f = await wi.collect()
  const h = f.habits!.find((x) => x.title === 'ورد القرآن اليومي')!
  assert.deepEqual({ done: h.done, expected: h.expected, streak: h.streak }, { done: 4, expected: 7, streak: 3 })
  assert.match(formatReport(f, '', ['x']), /🔁 ورد القرآن اليومي: ٤ من ٧ هالأسبوع · سلسلة ٣ 🔥/)
  await store.deleteTask(t.id)
})

test('برومبت الفهم: أدوار قديمة فيها مفتاح (خُزّنت قبل الحجب) تصل للنموذج محجوبة', async () => {
  const { buildUserMessage } = await import('./ai/understand.js')
  const msg = buildUserMessage('اقرا لي اللي في الصورة', {
    nowIso: '2026-10-07T12:00:00+03:00', weekday: 'الأربعاء', contacts: [], projects: [], openTasks: [], pending: [],
    history: [{ role: 'user', text: '🖼️ [صورة]\n- مفتاح الوسيط: zk-Q7xDemoKey00ExampleOnly42' }],
  })
  assert.doesNotMatch(msg, /Q7xDemoKey00ExampleOnly42/)
  assert.match(msg, /مفتاح الوسيط: zk-•••• \(محجوب\)/)
  assert.match(systemPrompt(), /لا railway_status إلا إذا ذكر صراحة/)
})
