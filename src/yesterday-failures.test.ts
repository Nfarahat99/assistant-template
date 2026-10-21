/**
 * أنماط إخفاق معروفة بين المالك والبوت (كل الرسائل والأسماء هنا مصطنعة) — كل نمط باختبار يعيد إنتاجه:
 * ١ جواب سؤال Claude بـ "ج" · ٢ حلقات التوضيح و"شغّل السكريبت" · ٣ "تم تأكيد" بلا فحص · ٤ REMOVED ليس حذفاً
 * ٥ "سراج اسستنت" و"نعم N" حرفياً · ٦ "فين ألاقي syncSeason" ← بحث كود لا ويب · ٧ لغة أجنبية · ٨ البوت يرد "نعم 307" · ٩ أسماء القواعد.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, codeTerm, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import { DeployWatcher } from './deploys.js'
import { parseServices, STATUS_AR, type RailwayClient, type RwService, type RwDeployment } from './clients/railway.js'
import { DatabaseRegistry } from './clients/databases.js'
import { pglitePool } from './test-fixtures.js'
import { sqlSystemRead, summarySystem, parseSqlReply } from './ai/dbsql.js'
import { systemPrompt } from './ai/understand.js'
import { capabilitiesForPrompt } from './capabilities.js'
import {
  stripForeignLatin, expandOptionAnswer, filterClarifyOptions, isActDirective, isApprovalEcho, isRunScriptRequest,
  nameMatches, normalizeName, tablesInSql, claimsVerification,
} from './lib/reply-guards.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient, CodeHit } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

let clock = new Date('2026-10-05T15:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent', wa_message_id: `wa-${id}` } as any },
}

// ───── GitHub مزيّف: تشغيل، سؤال Claude، بحث كود ─────
const dispatches: { repo: string; prompt: string }[] = []
let question: { number: number; html_url: string; body: string } | null = null
let codeHits: CodeHit[] | Error = []
const searches: { repo: string; term: string }[] = []
const github: GitHubClient = {
  async dispatchWorkflow(repo, _wf, _ref, inputs) { dispatches.push({ repo, prompt: inputs.prompt }) },
  async listRuns() { return [] }, async findPrByBranch() { return null }, async getPr() { throw new Error('x') },
  async prFiles() { return [] }, async mergePr() { return { sha: 'x' } }, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
  async findQuestion() { return question },
  async closeIssue() {},
  async searchCode(repo, term) { searches.push({ repo, term }); if (codeHits instanceof Error) throw codeHits; return codeHits },
}

// ───── Railway مزيّف (لإعادة النشر بالاسم) ─────
const targetsAsked: string[] = []
const botSvc: RwService = { projectId: 'p', projectName: 'my-assistant', serviceId: 's', serviceName: 'my-assistant', environmentId: 'e', environmentName: 'production', repo: 'example-user/my-assistant', image: null, latest: { id: 'd', status: 'QUEUED', createdAt: '2026-10-05T14:57:00Z', commitHash: 'abc', commitMessage: null, url: null }, domains: [] }
const railway: RailwayClient = {
  async listServices() { return [botSvc] }, async deployments() { return [] }, async logs() { return [] }, async redeploy() {},
  async projects() { return [] }, async details() { return [] },
  async findTargets(project) {
    targetsAsked.push(project)
    return project === 'my-assistant'
      ? [{ project: 'my-assistant', projectId: 'p', service: 'my-assistant', serviceId: 's', environment: 'production', environmentId: 'e' }]
      : []
  },
}

// ───── النموذج: يطابق بداية رسالة المالك (قد تُلحق بها تعليمات النظام) ─────
type Out = { actions: any[]; reply: string }
const script = new Map<string, Out | Out[]>()
const llmMsgs: string[] = []
const sqlScript: Record<string, string> = {}
const summaryPrompts: string[] = []
let webSearches = 0
const llm: LlmClient = {
  async complete(system, user) {
    if (system === sqlSystemRead()) {
      const req = user.split('الطلب:\n')[1].split('\n\n')[0].trim()
      const k = Object.keys(sqlScript).find((x) => req.startsWith(x))
      if (!k) throw new Error(`لا SQL لـ ${req}`)
      return sqlScript[k]
    }
    if (system.startsWith(summarySystem())) { summaryPrompts.push(user); return 'خلاصة 👌' }
    const msg = (user.split('رسالة وليد الجديدة:\n')[1] ?? '').trim()
    llmMsgs.push(msg)
    const key = [...script.keys()].sort((x, y) => y.length - x.length).find((k) => msg.startsWith(k))
    const v = key ? script.get(key)! : { actions: [{ type: 'answer', text: 'تمام' }], reply: '' }
    if (Array.isArray(v)) return JSON.stringify(v.length > 1 ? v.shift() : v[0])
    return JSON.stringify(v)
  },
  async searchWeb() { webSearches++; return { text: '', sources: [] } as any },
}

let pg: PGlite, db: Db, store: Store, a: Assistant
let seq = 0
async function say(text: string, extra: Partial<InboundPayload> = {}) {
  clock = new Date(clock.getTime() + 3_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `Y${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null, ...extra,
  } as InboundPayload)
  await a.idle()
  return sent.at(-1) ?? ''
}
const openNo = async (kind: string) => (await store.openPending(clock)).filter((p) => p.kind === kind).at(-1)?.short_no

/** طلب كود على البوت ← "نعم N" ← Claude يفتح issue سؤال ← البوت يعرضه. يرجع request_id */
async function askedQuestion(body: string): Promise<string> {
  const req = `عدل البوت: ميزة ${++seq}`
  script.set(req, { actions: [{ type: 'code_change', project_query: 'البوت', request: req }], reply: '' })
  await say(req)
  await say(`نعم ${await openNo('code_change')}`)
  const id = /رقم ([0-9a-f]{8})/.exec(sent.at(-1)!)![1]
  question = { number: 53, html_url: 'https://github.com/example-user/my-assistant/issues/53', body }
  clock = new Date(clock.getTime() + 60_000)
  await a.pollJobs()
  await a.idle()
  question = null
  assert.match(sent.at(-1)!, new RegExp(`❓ Claude يحتاج توضيح .*\\(رقم ${id}\\)`))
  return id
}

const Q_BODY = `1. التوجيه 12 مخزّن في القاعدة. ممكن تكتب لي نصه؟
2. وش تبي بالضبط: (أ) أمر جديد يحوّل توجيهاً واحداً لطلب code_change؟ أو (ب) فحص دوري يمر على التوجيهات المخزّنة ويطلع منها طلبات تعديل؟ أو (ج) غير كذا؟
3. نبدأ مباشرة ولا ننتظر موافقتك؟`

before(async () => {
  pg = await PGlite.create('memory://')
  await pg.exec(`CREATE TABLE students (id SERIAL PRIMARY KEY, name TEXT, uniform_ok BOOLEAN, day DATE);
    INSERT INTO students (name, uniform_ok, day) VALUES
      ('عمر ماجد الزهراني', false, '2026-10-04'),
      ('ماجد عبدالله با شعيبه', false, '2026-10-04'),
      ('ماجد عبدالله با شعيبه', true, '2026-10-03');`)
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  // projects.json البعيد فيه البوت بأسماء قليلة — المدمج يكمّلها ("سراج اسستنت")
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([
    { folder: 'my-assistant', repo: 'example-user/my-assistant', aliases: ['المساعد', 'مساعد سراج', 'البوت'], railway_project: 'my-assistant' },
    { folder: 'C:/sirajplus', repo: 'example-user/sirajplus', aliases: ['سراج بلس', 'فلك'] },
    { folder: 'C:/qandeel', repo: 'example-user/qandeel-hub', aliases: ['قنديل', 'مشعل'], railway_project: 'qndeel-saas' },
    { folder: 'C:/planners', repo: 'example-user/waqti', aliases: ['جدول الحصص'] },
  ])))
  a = new Assistant({
    cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects, now: () => clock, railway,
    databases: new DatabaseRegistry([{ key: 'falak', name_ar: 'فلك', aliases: ['منصة فلك'], project: 'falak', url: 'postgres://x', deny_tables: [] }] as any, pglitePool(pg)),
  })
  // الافتراضي في القالب: موقف — اختبارات القواعد هنا تفترض الوصول مفعّلاً
  await a.settings.update({ features: { db_access: true } })
})
after(async () => { await db.close(); await pg.close() })
beforeEach(() => { sent.length = 0; llmMsgs.length = 0; dispatches.length = 0; searches.length = 0; targetsAsked.length = 0; webSearches = 0 })

// ═════════════ ١) جواب سؤال Claude ═════════════

test('١ "ج" بعد سؤال Claude = توضيح <id>: الخيار (ج) — بلا "ما تقصد بـ ج؟" وبلا نموذج', async () => {
  const id = await askedQuestion(Q_BODY)
  dispatches.length = 0
  llmMsgs.length = 0
  const r = await say('ج')
  assert.equal(llmMsgs.length, 0, 'ذهب للنموذج')
  assert.doesNotMatch(r, /ما تقصد/)
  assert.match(r, new RegExp(`اعتبرت ردك جواب سؤال Claude \\(رقم ${id}\\): «الخيار \\(ج\\): غير كذا»`))
  assert.equal(dispatches.length, 1)
  assert.match(dispatches[0].prompt, /توضيح من وليد \(بعد سؤالك\): الخيار \(ج\): غير كذا/)
  // انجاب ← ما عاد مفتوح: الرسالة التالية تمشي عادي
  await say('وش أخبارك اليوم')
  assert.equal(llmMsgs.length, 1)
})

test('١ نص حر / صوتية كأول رسالة بعد السؤال = جواب، و"الخيار ب" يُوسَّع', async () => {
  await askedQuestion(Q_BODY)
  dispatches.length = 0
  await say('أبي فحص يشتغل لحاله على كل التوجيهات طول الوقت')
  assert.match(dispatches.at(-1)!.prompt, /توضيح من وليد \(بعد سؤالك\): أبي فحص يشتغل لحاله/)

  await askedQuestion(Q_BODY)
  dispatches.length = 0
  await say('الخيار ب')
  assert.match(dispatches.at(-1)!.prompt, /الخيار \(ب\): فحص دوري يمر على التوجيهات المخزّنة/)
})

test('١ أ/ب/ج ↔ a/b/c: "ب" على سؤال بخيارات لاتينية ← (b)، و"c" على خيارات عربية ← (ج)', async () => {
  assert.equal(expandOptionAnswer('ب', 'Choose: (a) new command, (b) scan every saved guideline (c) neither?'), 'الخيار (b): scan every saved guideline')
  assert.equal(expandOptionAnswer('c', Q_BODY), 'الخيار (ج): غير كذا')
  assert.equal(expandOptionAnswer('ا', Q_BODY).startsWith('الخيار (أ)'), true)
  await askedQuestion('Options: (a) manual trigger (b) scheduled scan (c) skip')
  dispatches.length = 0
  await say('ب')
  assert.match(dispatches.at(-1)!.prompt, /الخيار \(b\): scheduled scan/)
})

test('١ اقتباس رسالة السؤال = جواب حتى لو جت رسائل بينهما؛ وأمر موافقة كأول رسالة لا يُخطف؛ وبعد ساعتين لا', async () => {
  const id = await askedQuestion(Q_BODY)
  await say('مهامي')                       // رسالة بينهما ← ما عاد "أول رسالة"
  dispatches.length = 0
  await say('خلها تنتظر موافقتي', { quoted_message_id: 'wa-x', quoted_text: `❓ Claude يحتاج توضيح قبل ما يعدّل على البوت (رقم ${id}):` })
  assert.match(dispatches.at(-1)!.prompt, /توضيح من وليد \(بعد سؤالك\): خلها تنتظر موافقتي/)

  await askedQuestion(Q_BODY)
  dispatches.length = 0
  llmMsgs.length = 0
  await say('نعم 999')
  assert.equal(dispatches.length, 0, '"نعم N" انخطفت كجواب')
  assert.deepEqual(llmMsgs, ['نعم 999'], 'أمر الموافقة يمشي في مساره العادي')

  const id3 = await askedQuestion(Q_BODY)
  clock = new Date(clock.getTime() + 2 * 3600_000 + 60_000)
  dispatches.length = 0
  await say('ج')
  assert.equal(dispatches.length, 0, 'جواب ضمني بعد انتهاء النافذة')
  await say(`توضيح ${id3}: ج`)                // الصيغة الصريحة تبقى شغالة دائماً
  assert.equal(dispatches.length, 1)
})

test('١ اقتباس سؤال أقدم (رقم مختلف عن الأخير) يجاوب ذاك السؤال بالذات', async () => {
  const older = await askedQuestion(Q_BODY)
  // طلب جديد كأول رسالة بعد السؤال (يبدأ بـ "عدل…") ← ما يُخطف كجواب
  const newer = await askedQuestion('أي جدول تقصد؟')
  assert.ok(await store.getKv(`code_question:${older}`), 'طلب جديد انخطف كجواب للسؤال')
  dispatches.length = 0
  await say('ب', { quoted_message_id: 'wa-old', quoted_text: `❓ Claude يحتاج توضيح قبل ما يعدّل على البوت (رقم ${older}):\n\n…` })
  assert.match(sent.at(-1)!, new RegExp(`جواب سؤال Claude \\(رقم ${older}\\): «الخيار \\(ب\\)`))
  assert.ok(await store.getKv(`code_question:${newer}`), 'السؤال الأحدث لازم يبقى مفتوح')
})

// ═════════════ ٢) حلقات التوضيح ═════════════

test('٢ "شغّل السكريبت": جواب صادق واحد + مسودة لابتوب بالأمر — بلا خيارات دمج/طلبات معلّقة، والمرة الثانية مختصرة', async () => {
  await store.addTurn('assistant', '[315] ✅ التعديل خلص في سراج بلس:\n[claude] سكريبت إعادة بناء أيام الزي\nملف جديد `scripts/rebuild-uniform-days.ts` يسحب أيام الموسم القديمة\nhttps://github.com/example-user/sirajplus/pull/22')
  const r = await say('شغّل السكريبت الحين لو سمحت')
  assert.equal(llmMsgs.length, 0)
  assert.match(r, /ما أقدر أشغّل سكربتات أو أوامر على السيرفرات/)
  assert.match(r, /مسودة للابتوب رقم \d+: «تشغيل scripts\/rebuild-uniform-days\.ts على الإنتاج — سراج بلس»/)
  assert.match(r, /npx tsx scripts\/rebuild-uniform-days\.ts --dry-run/)
  assert.doesNotMatch(r, /رد برقم الخيار|نعم 315|\[276\]/)
  const drafts = await store.laptopDrafts()
  assert.equal(drafts.at(-1)!.project, 'example-user/sirajplus')
  const again = await say('نفذ Rebuild-uniform-days.ts')
  assert.match(again, /زي ما قلت: ما أقدر أشغّل سكربتات/)
  assert.equal((await store.laptopDrafts()).length, drafts.length, 'مسودة مكررة')
  assert.ok(isRunScriptRequest('شغّل السكريبت الحين لو سمحت') && !isRunScriptRequest('شغّل الملخص'))
})

test('٢ سؤال توضيح واحد فقط لكل طلب: بعد اختيار خيار، النموذج إن سأل مرة ثانية يُمنع (بلا خيارات مرقّمة)', async () => {
  script.set('وين ألاقي هالخاصية', { actions: [{ type: 'clarify', question: 'أي مشروع؟', options: ['جدول الحصص', 'قنديل', 'سراج بلس'] }], reply: '' })
  const r1 = await say('وين ألاقي هالخاصية')
  assert.match(r1, /أي مشروع؟\n1\. جدول الحصص/)
  script.set('وين ألاقي هالخاصية\n(اختياري', [
    { actions: [{ type: 'clarify', question: 'أي شاشة؟', options: ['الرئيسية', 'الإعدادات'] }], reply: '' },
    { actions: [{ type: 'clarify', question: 'أي شاشة؟', options: ['الرئيسية', 'الإعدادات'] }], reply: '' },
  ])
  const r2 = await say('3')
  assert.equal(llmMsgs.length, 3, 'محاولة إضافية واحدة فقط بلا توضيح')
  assert.match(llmMsgs[2], /clarify ممنوع نهائياً/)
  assert.doesNotMatch(r2, /رد برقم الخيار|1\. الرئيسية/)
  assert.match(r2, /ما راح أسألك مرة ثانية/)
  assert.equal(await store.getClarify(clock), null)

  // رد نصي على سؤال التوضيح (مو رقم) ← نفس القاعدة
  script.set('طلّع لي التقرير', { actions: [{ type: 'clarify', question: 'أي تقرير؟', options: ['الغياب', 'الزي'] }], reply: '' })
  await say('طلّع لي التقرير')
  script.set('اللي عن الزي', [
    { actions: [{ type: 'clarify', question: 'لأي يوم؟', options: ['اليوم', 'أمس'] }], reply: '' },
    { actions: [{ type: 'answer', text: 'أبشر، تقرير الزي حق اليوم 👍' }], reply: '' },
  ])
  const r3 = await say('اللي عن الزي')
  assert.equal(r3, 'أبشر، تقرير الزي حق اليوم 👍')
})

test('٢ "تصرف انت وشوف الأنسب" / "جاوب على سؤالي": لا أسئلة، وخيارات "نعم 306" لا تُعرض أبداً', async () => {
  assert.ok(isActDirective('تصرف انت وشوف الأنسب') && isActDirective('طيب جاوب على سؤالي') && isActDirective('تصرف'))
  script.set('تصرف انت وشوف الأنسب', [
    { actions: [{ type: 'clarify', question: 'تقصد أنفذ طلب الكود رقم 306؟', options: ['نعم 306', 'لا 306', 'عدّل 306'] }], reply: '' },
    { actions: [{ type: 'answer', text: 'طلب الكود تنفيذه ينتظر موافقتك الصريحة: اكتب «نعم» ومعها رقم الطلب.' }], reply: '' },
  ])
  const r = await say('تصرف انت وشوف الأنسب')
  assert.match(llmMsgs[0], /وليد قال «تصرف\/جاوب»/)
  assert.doesNotMatch(r, /1\. نعم 306/)
  assert.match(r, /ينتظر موافقتك الصريحة/)
  // الخيارات من السياق فقط: طلبات معلّقة ما ذكرها المالك وأوامر الموافقة تُحذف
  assert.deepEqual(filterClarifyOptions(['[276] قنديل: ترتيب الأوائل', '[309] سراج بلس: دمج PR #19', 'نعم 315 (ادمج)', 'تشغيل rebuild-uniform-days.ts'], 'شغّل السكريبت'),
    ['تشغيل rebuild-uniform-days.ts'])
  assert.deepEqual(filterClarifyOptions(['[276] قنديل', '[279] فلك'], 'وش صار على 276 و 279'), ['[276] قنديل', '[279] فلك'])
  // ولما يبقى أقل من خيارين: سؤال بلا قائمة مرقّمة
  script.set('نظّم لي الأولويات', { actions: [{ type: 'clarify', question: 'تقصد أي مشروع بالضبط؟', options: ['[276] قنديل', 'نعم 306'] }], reply: '' })
  const r2 = await say('نظّم لي الأولويات')
  assert.equal(r2, 'تقصد أي مشروع بالضبط؟')
})

// ═════════════ ٣) الصدق ═════════════

test('٣ "تاكد عند كلود" ← النموذج قال "تم تأكيد…" بلا فحص: يُستبدل بالصراحة + طلب تقرير فعلي (بموافقة)', async () => {
  script.set('تاكد عند كلود انه ماشي عليه', { actions: [{ type: 'answer', text: 'تم تأكيد إن كلود صار يمر على كل توجيه جديد ✔️' }], reply: '' })
  const r = await say('تاكد عند كلود انه ماشي عليه')
  assert.doesNotMatch(r, /تم تأكيد/)
  assert.match(r, /ما أقدر أأكد هذا بنفسي — ما نفّذت أي فحص فعلي/)
  assert.match(r, /جهزت الطلب \(ما نفّذته بعد\)/)
  const p = (await store.openPending(clock)).filter((x) => x.kind === 'code_change').at(-1)!
  assert.equal(p.payload.repo, 'example-user/my-assistant')
  assert.match(p.payload.request, /تحقّق بقراءة الكود فقط \(بدون تعديل أي منطق\): تاكد عند كلود انه ماشي عليه/)
  assert.ok(claimsVerification('تم تأكيد إن كلود صار يمر') && !claimsVerification('تمّ حفظ التوجيه رقم 12 ✅'))
  assert.match(systemPrompt(), /لا تقل «تم» أو «تم التأكيد»/)
  const facts = capabilitiesForPrompt({ githubConnected: true, githubOwner: 'x', projects: [], selfRepo: 'x', telegram: 'off', whatsapp: { status: 'connected', banned: false }, sendMode: 'link', version: null, recentJobs: [] })
  assert.match(facts, /ما تقرأ الكود بنفسك/)
  assert.match(facts, /REMOVED" تعني إن نشراً أقدم استُبدل/)
})

// ═════════════ ٤) متابعة النشر ═════════════

test('٤ REMOVED لنشر استُبدل بدمج أحدث نتابعه: "استُبدل… ما انحذف شي" مرة، والنتيجة من متابعة الأحدث — لا "محذوف"', async () => {
  const out: string[] = []
  const deps: Record<string, RwDeployment[]> = {}
  const svc: RwService = { projectId: 'p', projectName: 'qndeel-saas', serviceId: 'm', serviceName: 'qndeel-saas', environmentId: 'e', environmentName: 'production', repo: 'example-user/qandeel-hub', image: null, latest: null, domains: ['qandeel.example.com'] }
  const rw: RailwayClient = { ...railway, async listServices() { return [svc] }, async deployments(id) { return deps[id] ?? [] } }
  const mk = (id: string, status: RwDeployment['status'], sha: string, at: string): RwDeployment => ({ id, status, createdAt: at, commitHash: sha, commitMessage: null, url: null })
  const watcher = (tag: string) => new DeployWatcher({ store, railway: rw, now: () => clock, tz: 'Asia/Riyadh', httpGet: async () => 200, say: async (t) => { out.push(`${tag}:${t}`) }, offerRedeploy: async () => ({ text: '', pendingId: 0 }) })
  for (const [id, sha] of [['r401', '4b8e2c1aaa'], ['r402', '9c0d3f5bbb']]) {
    await store.addJob({ request_id: id, project: 'قنديل', repo: 'example-user/qandeel-hub', default_branch: 'main', request: 'x', dispatched_at: clock })
    await store.transitionJob(id, 'dispatched', 'merged')
    await store.startDeployWatch(id, sha, clock)
  }
  deps.m = [mk('d1', 'BUILDING', '4b8e2c1aaa', '2026-10-05T15:32:00Z')]
  // نسختان من البوت شغالتين معاً (أثناء نشره) ← "🚀 بدأ" مرة وحدة
  await watcher('A').poll(); await watcher('B').poll()
  assert.equal(out.filter((m) => m.includes('🚀 بدأ النشر على qndeel-saas')).length, 1)

  deps.m = [mk('d2', 'BUILDING', '9c0d3f5bbb', '2026-10-05T15:36:20Z'), mk('d1', 'REMOVED', '4b8e2c1aaa', '2026-10-05T15:32:00Z')]
  clock = new Date(clock.getTime() + 20_000)
  await watcher('A').poll()
  deps.m = [mk('d2', 'SUCCESS', '9c0d3f5bbb', '2026-10-05T15:36:20Z'), mk('d1', 'REMOVED', '4b8e2c1aaa', '2026-10-05T15:32:00Z')]
  clock = new Date(clock.getTime() + 20_000)
  await watcher('A').poll(); await watcher('B').poll()
  const all = out.join('\n')
  assert.doesNotMatch(all, /محذوف|🗑️/)
  assert.match(all, /↪️ نشر qndeel-saas \(قنديل\) على commit 4b8e2c1 استُبدل بنشر أحدث \(commit 9c0d3f5\) — هذا طبيعي في Railway وما انحذف شي/)
  assert.equal(out.filter((m) => m.includes('✅ انتشر بنجاح على qndeel-saas')).length, 1, 'نجاح مكرر')
  assert.equal((await store.watchedDeploys()).length, 0)
  assert.doesNotMatch(STATUS_AR.REMOVED, /محذوف/)
})

test('٤ REMOVED استُبدل بنشر أحدث غير متابَع: نتابعه ونبلّغ بنتيجته، وREMOVED بلا أحدث: رسالة محايدة بعد مهلة', async () => {
  const out: string[] = []
  const deps: Record<string, RwDeployment[]> = {}
  const svc: RwService = { projectId: 'p', projectName: 'falak', serviceId: 'w', serviceName: 'falak-site', environmentId: 'e', environmentName: 'production', repo: 'example-user/sirajplus', image: null, latest: null, domains: [] }
  const rw: RailwayClient = { ...railway, async listServices() { return [svc] }, async deployments(id) { return deps[id] ?? [] } }
  const w = new DeployWatcher({ store, railway: rw, now: () => clock, tz: 'Asia/Riyadh', say: async (t) => { out.push(t) }, offerRedeploy: async () => ({ text: '', pendingId: 0 }) })
  const mk = (id: string, status: RwDeployment['status'], sha: string, at: string): RwDeployment => ({ id, status, createdAt: at, commitHash: sha, commitMessage: null, url: null })
  await store.addJob({ request_id: 'r412', project: 'سراج بلس', repo: 'example-user/sirajplus', default_branch: 'main', request: 'x', dispatched_at: clock })
  await store.startDeployWatch('r412', '2d7f9e3aaa', clock)
  deps.w = [mk('n1', 'DEPLOYING', 'manualzzz', '2026-10-05T16:01:00Z'), mk('o1', 'REMOVED', '2d7f9e3aaa', '2026-10-05T16:00:50Z')]
  await w.poll()
  assert.match(out.join('\n'), /استُبدل بنشر أحدث \(commit manualz\) — هذا طبيعي في Railway وما انحذف شي\. أتابع النشر الأحدث/)
  deps.w = [mk('n1', 'SUCCESS', 'manualzzz', '2026-10-05T16:01:00Z'), mk('o1', 'REMOVED', '2d7f9e3aaa', '2026-10-05T16:00:50Z')]
  await w.poll()
  assert.match(out.at(-1)!, /✅ انتشر بنجاح على falak-site \(عبر النشر الأحدث commit manualz\)/)

  await store.addJob({ request_id: 'r415', project: 'سراج بلس', repo: 'example-user/sirajplus', default_branch: 'main', request: 'x', dispatched_at: clock })
  await store.startDeployWatch('r415', '8a1c6b4aaa', clock)
  deps.w = [mk('o2', 'REMOVED', '8a1c6b4aaa', '2026-10-05T16:09:40Z')]
  svc.latest = mk('n1', 'SUCCESS', 'manualzzz', '2026-10-05T16:01:00Z')
  out.length = 0
  await w.poll()
  assert.equal(out.length, 0, 'حكم قبل المهلة')
  clock = new Date(clock.getTime() + 3 * 60_000)
  await w.poll()
  assert.match(out.at(-1)!, /ℹ️ نشر falak-site \(سراج بلس\) على commit 8a1c6b4 ما اكتمل — Railway استبدله أو ألغاه \(هذا مو حذف للمشروع ولا للخدمة\)\. الشغّال الحين: ✅ شغّال على commit manualz/)
  assert.doesNotMatch(out.join('\n'), /محذوف/)
})

test('٤ بيئة production فقط حتى لو البيئة الأساسية staging (لا "🚀 بدأ النشر" مرتين)', () => {
  const inst = (env: string) => ({ node: { serviceId: 's', serviceName: 'qndeel-saas', environmentId: env, source: { repo: 'example-user/qandeel-hub' }, latestDeployment: null, domains: {} } })
  const list = parseServices({ projects: { edges: [{ node: { id: 'p', name: 'qndeel-saas', primaryEnvironmentId: 'stg', environments: { edges: [
    { node: { id: 'stg', name: 'preview-staging', serviceInstances: { edges: [inst('stg')] } } },
    { node: { id: 'prod', name: 'production', serviceInstances: { edges: [inst('prod')] } } },
  ] } } }] } })
  assert.equal(list.length, 1)
  assert.equal(list[0].environmentName, 'production')
})

// ═════════════ ٥) اسم البوت على Railway + "نعم N" حرفياً ═════════════

test('٥ "سراج اسستنت"/"سراج اسيستانت"/"البوت" = مشروع my-assistant (حتى لو projects.json البعيد ناقصه)، وإعادة النشر تلقاه', async () => {
  const reg = new ProjectRegistry(parseProjects(JSON.stringify([{ folder: 'my-assistant', repo: 'example-user/my-assistant', aliases: ['المساعد'] }])))
  for (const n of ['سراج اسستنت', 'سراج اسيستانت', 'سراج أسيستنت', 'البوت', 'my assistant']) {
    assert.deepEqual(reg.resolve(n).map((p) => p.repo), ['example-user/my-assistant'], n)
  }
  assert.equal(reg.resolve('سراج اسستنت')[0].railway_project, 'my-assistant')
  // الأمر السريع "أعد نشر …"
  const r0 = await say('اعد نشر سراج أسيستنت')
  assert.match(r0, /🚂 جهزت إعادة نشر \(ما نفّذتها بعد\): my-assistant \/ my-assistant/)
  // ومسار النموذج (railway_redeploy) بتهجئة ثانية لاسم البوت
  script.set('طيب سو له ريستارت في ريلواي', { actions: [{ type: 'railway_redeploy', project_query: 'سراج اسستانت' }], reply: '' })
  const r = await say('طيب سو له ريستارت في ريلواي')
  assert.deepEqual(targetsAsked, ['my-assistant'])
  assert.doesNotMatch(r, /ما لقيت خدمة تطابق/)
  assert.match(r, /my-assistant/)
})

test('٥ "نعم N" حرفياً: يطلب رقم الطلب من المعاينة — لا بحث في Railway ولا نموذج', async () => {
  for (const p of await store.openPending(clock)) await store.decidePending(p.id, 'rejected', clock)
  const r = await say('نعم N')
  assert.equal(llmMsgs.length, 0)
  assert.equal(targetsAsked.length, 0)
  assert.match(r, /«N» مكانه رقم الطلب اللي يظهر في المعاينة/)
  script.set('أعد نشر البوت', { actions: [{ type: 'railway_redeploy', project_query: 'البوت' }], reply: '' })
  await say('أعد نشر البوت')
  const no = await openNo('railway_redeploy')
  const r2 = await say('نعم N')
  assert.match(r2, new RegExp(`المعلّق الحين:[\\s\\S]*رد مثلاً: نعم ${no}`))
  // والنموذج إن كتب «قول نعم N» ما يوصل حرفياً
  script.set('ليه لسا واقف بالطابور', { actions: [], reply: "البناء لسا شغال. تبي أعيد النشر؟ اكتب 'نعم N' وأجهزه." })
  const r3 = await say('ليه لسا واقف بالطابور')
  assert.doesNotMatch(r3, /نعم N/)
  assert.match(systemPrompt(), /لا تكتب أبداً «نعم N»/)
})

// ═════════════ ٦) بحث الكود ═════════════

test('٦ "فين ألاقي دالة syncSeason في سراج بلس" ← بحث كود GitHub بمسارات وسياق — بلا بحث ويب ولا نموذج', async () => {
  codeHits = [{ path: 'src/server/importer/sync.ts', html_url: 'https://github.com/example-user/sirajplus/blob/main/src/server/importer/sync.ts', fragments: ['import x\nexport async function syncSeason(seasonId: string) {\n  const days'] },
    { path: 'src/app/admin/sync-button.tsx', html_url: 'https://github.com/example-user/sirajplus/blob/main/src/app/admin/sync-button.tsx', fragments: ['onClick={() => syncSeason(season.id)}'] }]
  const r = await say('فين ألاقي دالة syncSeason في سراج بلس ؟')
  assert.equal(llmMsgs.length, 0)
  assert.equal(webSearches, 0)
  assert.deepEqual(searches, [{ repo: 'example-user/sirajplus', term: 'syncSeason' }])
  assert.match(r, /🔎 «syncSeason» في كود سراج بلس \(example-user\/sirajplus\) — 2 ملف/)
  assert.match(r, /• src\/server\/importer\/sync\.ts\n  export async function syncSeason\(seasonId: string\) \{/)
  assert.match(r, /onClick=\{\(\) => syncSeason\(season\.id\)\}/)
  assert.equal(codeTerm('زر syncseason'), 'syncseason')
})

test('٦ النموذج اختار web_search على "syncseason example-user/sirajplus" ← يتحول لبحث كود؛ ولا نتائج ← طلب تقرير لـ Claude (لا ويب)', async () => {
  codeHits = []
  script.set('خل كلود يدور بنفسه ويعطيني الجواب', { actions: [{ type: 'web_search', query: 'syncseason example-user/sirajplus' }], reply: 'لحظة، أدور لك…' })
  const r = await say('خل كلود يدور بنفسه ويعطيني الجواب')
  await a.idle()
  assert.equal(webSearches, 0, 'بحث ويب عن معرّف مستودع')
  assert.deepEqual(searches, [{ repo: 'example-user/sirajplus', term: 'syncseason' }])
  assert.match(r, /ما لقيت «syncseason» ببحث GitHub السريع في example-user\/sirajplus — جهزت طلب لـ Claude يدور في الكود ويكتب الجواب/)
  const p = (await store.openPending(clock)).filter((x) => x.kind === 'code_change').at(-1)!
  assert.equal(p.payload.repo, 'example-user/sirajplus')
  assert.match(p.payload.request, /سؤال عن الكود بدون أي تعديل منطق: وين موجود «syncseason»[\s\S]*reports\/code-answer-syncseason\.md/)
  // إجراء code_search الصريح + فشل بحث GitHub ← نفس الطلب الاحتياطي (مسجّل كعطل حقيقي)
  codeHits = new Error('GitHub GET /search/code → 403')
  script.set('فتش كود قنديل عن الدالة attendanceFlag', { actions: [{ type: 'code_search', project_query: 'قنديل', query: 'attendanceFlag' }], reply: '' })
  const r2 = await say('فتش كود قنديل عن الدالة attendanceFlag')
  assert.match(r2, /جهزت طلب لـ Claude يدور في الكود/)
  assert.ok((await a.lastFailures()).some((f) => /بحث الكود في example-user\/qandeel-hub/.test(f.what)))
  assert.match(systemPrompt(), /code_search/)
})

// ═════════════ ٧) اللغة ═════════════

test('٧ عبارة فرنسية وسط الرد تُقص قبل الإرسال؛ الإنجليزي والكود والروابط تبقى', async () => {
  script.set('وش معنى syncseason', { actions: [{ type: 'answer', text: "الظاهر إن الأمر يقصد مزامنة مستودع GitHub اسمه sirajplus qui appartient à l'équipe exampleteam2، يعني تحديث الملفات." }], reply: '' })
  const r = await say('وش معنى syncseason')
  assert.doesNotMatch(r, /appartient|équipe|à/)
  assert.match(r, /مستودع GitHub اسمه exampleteam2، يعني تحديث الملفات/)
  const en = 'Note: Archived classes are hidden from the dashboard. See src/app/dashboard/classes.tsx https://github.com/x/y/pull/41 `let é = 2`'
  assert.deepEqual(stripForeignLatin(en), { text: en, changed: false })
  assert.equal(stripForeignLatin('La mise à jour est prête pour les élèves').changed, true)
  assert.match(systemPrompt(), /ممنوع أي لغة ثانية/)
})

// ═════════════ ٨) البوت لا يرد بأمر موافقة ═════════════

test('٨ "وش اللي صار توه" ← النموذج رد "نعم 307": لا يُرسل كرد؛ يوضح إن الموافقة منه ويعرض المعلّق', async () => {
  script.set('وش اللي صار توه', { actions: [{ type: 'answer', text: 'نعم 307' }], reply: '' })
  const r = await say('وش اللي صار توه')
  assert.notEqual(r.trim(), 'نعم 307')
  assert.doesNotMatch(r, /^نعم 307$/m)
  assert.match(r, /ما أقدر أكتب موافقة بالنيابة عنك/)
  script.set('طمني على الحال', { actions: [], reply: 'نعم 19' })
  assert.match(await say('طمني على الحال'), /الموافقة لازم تجي منك/)
  assert.ok(isApprovalEcho('نعم 307') && isApprovalEcho('«لا 19»') && !isApprovalEcho('نعم، جهزت الطلب 307'))
})

// ═════════════ ٩) أسماء الأشخاص في القواعد ═════════════

test('٩ "ماجد باشعيبة": الصفوف لازم تطابق الاسم كامل — لا جواب عن "عمر ماجد الزهراني"', async () => {
  sqlScript['شيك على الطالب ماجد باشعيبة'] = JSON.stringify({ sql: `SELECT name, uniform_ok, day FROM students WHERE name ILIKE '%ماجد%'`, name: 'ماجد باشعيبة' })
  script.set('شيك على الطالب ماجد باشعيبة', { actions: [{ type: 'db_query', db_query: 'فلك', question: 'شيك على الطالب ماجد باشعيبة في منصة فلك' }], reply: '' })
  summaryPrompts.length = 0
  await say('شيك على الطالب ماجد باشعيبة')
  assert.equal(summaryPrompts.length, 1)
  assert.match(summaryPrompts[0], /با شعيبه/)
  assert.doesNotMatch(summaryPrompts[0], /الزهراني/)
  assert.ok(nameMatches('ماجد باشعيبة', 'ماجد عبدالله با شعيبه') && !nameMatches('ماجد باشعيبة', 'عمر ماجد الزهراني'))
  assert.equal(normalizeName('أبو بكر با شعيبة'), 'ابوبكر باشعيبه')
})

test('٩ اسم يطابق أكثر من شخص ← قائمة وسؤال؛ اسم ما رجع ← "ما لقيت بالضبط" مع الأسماء؛ ولا نتائج ← القاعدة والجدول', async () => {
  sqlScript['ماجد لبس الشماغ أمس؟'] = JSON.stringify({ sql: `SELECT name, uniform_ok FROM students WHERE name ILIKE '%ماجد%'`, name: 'ماجد' })
  script.set('ماجد لبس الشماغ أمس؟', { actions: [{ type: 'db_query', db_query: 'فلك', question: 'ماجد لبس الشماغ أمس؟' }], reply: '' })
  const r = await say('ماجد لبس الشماغ أمس؟')
  assert.match(r, /لقيت أكثر من شخص يطابق «ماجد» في فلك، أي واحد؟\n1\. عمر ماجد الزهراني\n2\. ماجد عبدالله با شعيبه/)

  sqlScript['طمني عن طلال الزهراني'] = JSON.stringify({ sql: `SELECT name FROM students WHERE name ILIKE '%ماجد%'`, name: 'طلال الزهراني' })
  script.set('طمني عن طلال الزهراني', { actions: [{ type: 'db_query', db_query: 'فلك', question: 'طمني عن طلال الزهراني' }], reply: '' })
  const r2 = await say('طمني عن طلال الزهراني')
  assert.match(r2, /ما لقيت «طلال الزهراني» بالضبط في فلك \(بحثت في جدول: students\)/)
  assert.match(r2, /عمر ماجد الزهراني/)

  sqlScript['كم واحد اسمه مهند عندنا'] = JSON.stringify({ sql: `SELECT name FROM students WHERE name ILIKE '%مهند%'` })
  script.set('كم واحد اسمه مهند عندنا', { actions: [{ type: 'db_query', db_query: 'فلك', question: 'كم واحد اسمه مهند عندنا' }], reply: '' })
  const r3 = await say('كم واحد اسمه مهند عندنا')
  assert.match(r3, /ما لقيت شي يطابق في فلك \(بحثت في جدول: students\) 🤷/)
  assert.deepEqual(tablesInSql('SELECT a.x FROM "Attendance" a JOIN students s ON s.id=a.sid'), ['Attendance', 'students'])
  assert.deepEqual(parseSqlReply('{"sql":"SELECT 1","name":"ماجد"}'), { sql: 'SELECT 1', name: 'ماجد' })
  assert.match(sqlSystemRead(), /لازم يطابق كل أجزاء الاسم/)
})
