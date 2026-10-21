/**
 * إصلاحات لأنماط تعثّر معروفة (كل الرسائل والأسماء والنطاقات هنا مصطنعة): تحديث النفس، وصول Railway في الحالة الحية، روابط المشاريع،
 * تكرار الطلبات، تيليجرام للآخرين، بحث بلا مصادر، النشرة اليومية، حد Claude، نبض اللابتوب، والتوكنات الملصوقة.
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
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
export const cfgOf = (extra: Record<string, string> = {}) => loadConfig({
  OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh', ...extra,
} as any)

let clock = new Date('2026-10-25T08:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const svc = (id: string, name: string, project: string, repo: string | null, domain: string | null): RwService => ({
  projectId: project, projectName: project, serviceId: id, serviceName: name, environmentId: 'env', environmentName: 'production',
  repo, image: null, latest: { id: `${id}-d`, status: 'SUCCESS', createdAt: clock.toISOString(), commitHash: 'abc', commitMessage: null, url: null },
  domains: domain ? [domain] : [],
})
const services: RwService[] = [
  svc('q-web', 'web', 'nakhla', 'example-user/nakhla', 'nakhla.example.com'),
  svc('k-web', 'site', 'nakhla-site', 'example-user/nakhla-site', 'nakhla-site.example'),
  svc('j-web', 'web', 'waqti', 'example-user/waqti', 'example-waqti.up.railway.app'),
  svc('j-sol', 'solver', 'waqti', 'example-user/waqti', null),
  svc('t-att', 'attendance', 'hudoor-attendance', null, 'example-hudoor.up.railway.app'),
]
let rwCalls = 0
const railway: RailwayClient = {
  async listServices() { rwCalls++; return services },
  async deployments() { return [] }, async logs() { return [] }, async redeploy() {},
  async projects() { return [] }, async details() { return [] }, async findTargets() { return [] },
}
export const dispatches: { repo: string; prompt: string }[] = []
const github: GitHubClient = {
  async dispatchWorkflow(repo, _wf, _ref, inputs) { dispatches.push({ repo, prompt: inputs.prompt }) },
  async listRuns() { return [] }, async findPrByBranch() { return null }, async getPr() { throw new Error('x') },
  async prFiles() { return [] }, async mergePr() { return { sha: 'x' } }, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
}
const systems: string[] = []
const script: Record<string, any> = {}
const llm: LlmClient = {
  async complete(system, user) {
    systems.push(system)
    const msg = (user.split('رسالة وليد الجديدة:\n')[1] ?? '').trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: 'تمام' }], reply: '' })
  },
}
const projects = () => new ProjectRegistry(parseProjects(JSON.stringify([
  { folder: 'C:/nakhla', repo: 'example-user/nakhla', aliases: ['نخلة', 'nakhla'] },
  { folder: 'C:/nakhla-site', repo: 'example-user/nakhla-site', aliases: ['نخلة الموقع', 'nakhla-site'] },
  { folder: 'C:/planners', repo: 'example-user/waqti', aliases: ['جدول الحصص'] },
  { folder: 'C:/hudoor', repo: 'example-user/hudoor', aliases: ['حضور الصفوف'], railway_project: 'hudoor-attendance' },
])))

let db: Db, store: Store, a: Assistant
let seq = 0
export async function say(text: string, who?: Assistant) {
  clock = new Date(clock.getTime() + 3_000)
  await (who ?? a).accept({
    event: 'message', session_phone: ASSISTANT, message_id: `T${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await (who ?? a).idle()
}
const last = () => sent.at(-1) ?? ''
const make = (extra: Partial<ConstructorParameters<typeof Assistant>[0]> = {}) =>
  new Assistant({ cfg: cfgOf(), store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects: projects(), now: () => clock, railway, ...extra })

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  a = make()
})
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0; systems.length = 0 })

// ───── (a) تحديث النفس ─────
test('(a) دمج على مستودع البوت: "بتحدّث نفسي الحين…" ثم بعد الإقلاع "✅ تحدثت للنسخة" مرة واحدة بقائمة التغييرات', async () => {
  // أول إقلاع: يُسجَّل بصمت
  a.attachVersion({ sha: 'aaaaaaa1111', message: 'old', date: null, built_at: null, source: 'git' })
  assert.equal(await a.announceVersionIfNew(), false)
  assert.equal(sent.length, 0)

  await store.addJob({ request_id: 'self1', project: 'البوت', repo: 'example-user/my-assistant', default_branch: 'main', request: 'خل التذكير الصباحي ٦:٤٥\nوباقي التفاصيل', dispatched_at: clock })
  await store.updateJob('self1', { status: 'merged' })
  await store.startDeployWatch('self1', 'bbbbbbb2222', new Date(clock.getTime() + 1000))

  const booted = make()
  booted.attachVersion({ sha: 'bbbbbbb2222', message: 'feat: التذكير الصباحي ٦:٤٥ (#12)', date: null, built_at: null, source: 'build-env' })
  assert.equal(await booted.announceVersionIfNew(), true)
  assert.match(last(), /^✅ تحدثت للنسخة bbbbbbb — feat: التذكير الصباحي ٦:٤٥ \(#12\)\nاللي تغيّر:\n• خل التذكير الصباحي ٦:٤٥$/)
  assert.equal(await booted.announceVersionIfNew(), false, 'مرة واحدة فقط')
  assert.equal((await store.getJob('self1'))!.deploy_status, 'success')
})

// ───── (b) الحالة الحية ─────
test('(b) مع التوكن: الحالة الحية تقول "عندي وصول Railway" وتسرد الخدمات بالنشر التلقائي والرابط؛ وبدونه تشرح كيف يُضاف', async () => {
  await say('تقدر توصل للاستضافة حقتي؟')
  const sys = systems.at(-1)!
  assert.match(sys, /عندك وصول Railway \(قراءة \+ إعادة نشر بموافقة\)/)
  assert.match(sys, /لا تقل أبداً "ما عندي وصول لريلواي"/)
  assert.match(sys, /nakhla\/web — نشر تلقائي من example-user\/nakhla — https:\/\/nakhla\.example\.com/)
  assert.match(sys, /hudoor-attendance\/attendance — رفع يدوي — https:\/\/example-hudoor\.up\.railway\.app/)
  const calls = rwCalls
  await say('وسؤال ثاني بعد')
  assert.equal(rwCalls, calls, 'الخدمات من الذاكرة المؤقتة، لا طلب API بكل رسالة')

  const noRw = make({ railway: null })
  await say('وش تقدر توصل له؟', noRw)
  assert.match(systems.at(-1)!, /Railway غير مربوط الآن\. إن سُئلت قل بالضبط: .*railway\.com\/account\/tokens.*RAILWAY_API_TOKEN/s)
  await say('حالة النشر', noRw)
  assert.match(last(), /لإضافته: railway\.com\/account\/tokens/)
})

// ───── (c) روابط المشاريع ─────
test('(c) "لينك موقع نخلة" ← nakhla، "لينك نخلة الموقع" ← nakhla-site، ومشروع بخدمتين يعرض الرابط الموجود', async () => {
  await say('لينك موقع نخلة')
  assert.equal(last(), '🌐 نخلة:\n• web: https://nakhla.example.com')
  await say('لينك نخلة الموقع')
  assert.equal(last(), '🌐 نخلة الموقع:\n• site: https://nakhla-site.example')
  await say('موقع جدول الحصص')
  assert.match(last(), /• web: https:\/\/example-waqti\.up\.railway\.app/)
  assert.doesNotMatch(last(), /solver/)
  await say('عطني رابط حضور الصفوف')
  assert.match(last(), /https:\/\/example-hudoor\.up\.railway\.app/)
})

// ───── (d) تكرار الطلبات ─────
test('(d) نفس طلب التعديل مرتين: طلب واحد فقط، والثاني يُرد عليه بالرقم؛ وبعد التشغيل نفس الطلب لا يُشغَّل مرة ثانية خلال ١٠ دقائق', async () => {
  script['عدّل في جدول الحصص: حط زر طباعة'] = { actions: [{ type: 'code_change', project_query: 'جدول الحصص', request: 'حط زر طباعة' }], reply: '' }
  await say('عدّل في جدول الحصص: حط زر طباعة')
  const [p] = (await store.openPending(clock)).filter((x) => x.kind === 'code_change')
  await say('عدّل في جدول الحصص: حط زر طباعة')
  assert.equal((await store.openPending(clock)).filter((x) => x.kind === 'code_change').length, 1)
  assert.equal(last(), `نفس الطلب جاهز ومعلّق [${p.short_no}] — رد «نعم ${p.short_no}» لتنفيذه.`)

  await say(`نعم ${p.short_no}`)
  assert.equal(dispatches.length, 1)
  script['عدّل في جدول الحصص: حط  زر طباعة'] = { actions: [{ type: 'code_change', project_query: 'جدول الحصص', request: 'حط  زر طباعة' }], reply: '' }
  await say('عدّل في جدول الحصص: حط  زر طباعة')     // نفس النص بمسافة زائدة
  assert.match(last(), /^نفس الطلب شغال \(رقم [0-9a-f]{8}\) — ما جهزته مرة ثانية\.$/)
  assert.equal(dispatches.length, 1)
})

// ───── (e) تيليجرام للآخرين ─────
test('(e) "ابعث لفيصل في تيليجرام": شرح صادق للقيد + رابط مشاركة t.me بالنص مرمّزاً', async () => {
  script['ابعث لفيصل في تيليجرام إني بتأخر شوي'] = { actions: [{ type: 'send_telegram', contact_query: 'فيصل', text: 'بتأخر ١٠ دقايق & جاي بعدها؟' }], reply: 'تم الإرسال ✅' }
  await say('ابعث لفيصل في تيليجرام إني بتأخر شوي')
  const m = last()
  assert.match(m, /بوت تيليجرام ما يقدر يبدأ محادثة مع أحد ما راسله قبل/)
  assert.ok(m.includes('https://t.me/share/url?url=&text=' + encodeURIComponent('بتأخر ١٠ دقايق & جاي بعدها؟')))
  assert.doesNotMatch(m, /تم الإرسال/, 'ادعاء إرسال')
})

// ───── (f) بحث بلا مصادر ─────
test('(f) بحث عربي محلي بلا مصادر: محاولة بالإنجليزي، ثم معرفة عامة موسومة — لا طريق مسدود', async () => {
  const prompts: string[] = []
  let englishHasSources = false
  const empty = { text: 'ما لقيت', chunks: [], supports: [], queries: [] }
  const withSrc = {
    text: '1. مقهى المثال — معروف في الرياض\n', queries: ['best cafes malqa riyadh'],
    chunks: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/X', title: 'cafe.example.com' }],
    supports: [{ text: 'مقهى المثال — معروف في الرياض', chunkIndices: [0] }],
  }
  const gk: string[] = []
  const searchLlm: LlmClient = {
    async complete(system, user) {
      if (system.includes('من معرفتك العامة')) { gk.push(user); return JSON.stringify({ answer: 'مقهى المثال سلسلة قهوة محلية معروفة https://fake.example' }) }
      return JSON.stringify({ actions: [{ type: 'web_search', query: 'أفضل مقاهي حي الملقا بالرياض' }], reply: '' })
    },
    async searchWeb(p) { prompts.push(p); return prompts.length === 2 && englishHasSources ? withSrc : empty },
  }
  const s1 = make({ llm: searchLlm })
  await say('وش أفضل مقاهي حي الملقا بالرياض؟', s1)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /Search the web in English/)
  assert.match(last(), /^📚 من معرفتي العامة \(بدون مصادر حديثة\):\nمقهى المثال سلسلة قهوة محلية معروفة/)
  assert.doesNotMatch(last(), /fake\.example/)
  assert.equal(gk.length, 1)

  prompts.length = 0
  englishHasSources = true
  await say('وش أفضل مقاهي حي الملقا بالرياض؟', s1)
  assert.match(last(), /1\. مقهى المثال/)
  assert.match(last(), /🔗 cafe\.example\.com/)
})

// ───── (h) النشرة اليومية ─────
test('(h) موجز AI الساعة ٦ مساءً: من المصادر مباشرة (روابط وتواريخ من البيانات)، مرة يومياً، وبلا تكرار — ولا عند الطلب', async () => {
  const iso = (h: number) => new Date(Date.parse('2026-10-25T15:05:00Z') - h * 3600_000).toISOString()
  const hn = { hits: [
    { objectID: '1', title: 'Claude Code adds MCP skills marketplace', url: 'https://example.com/news/skills', created_at: iso(3), points: 300 },
    { objectID: '2', title: 'Show HN: WhatsApp bot framework in TypeScript', url: 'https://example.com/a/wa', created_at: iso(5), points: 80 },
    { objectID: '3', title: 'Old agents post', url: 'https://old.example.com/x', created_at: '2026-09-01T00:00:00Z', points: 99 },
  ] }
  const atom = `<feed><entry><title>Gemini 4 notes for Next.js developers</title><link href="https://example.com/g4" rel="alternate"/><published>${iso(4)}</published></entry></feed>`
  const fetched: string[] = []
  const newsFetch = async (url: string) => {
    fetched.push(url)
    if (url.includes('hn.algolia.com')) return new Response(JSON.stringify(hn))
    if (url.includes('simonwillison')) return new Response(atom)
    if (url.includes('openai.com')) throw new Error('ECONNRESET')
    if (url.includes('api.github.com') || url.includes('huggingface')) return new Response(JSON.stringify(url.includes('github') ? { items: [] } : []))
    return new Response('<rss><channel></channel></rss>')
  }
  const prompts: string[] = []
  const newsLlm: LlmClient = {
    ...llm,
    async complete(system, user) {
      if (!system.includes('موجز AI')) return llm.complete(system, user)
      prompts.push(user)
      return JSON.stringify({ items: JSON.parse(user).map((x: any) => ({ id: x.id, summary_ar: `ملخص ${x.id}`, why_ar: 'يهمك لأن… https://evil.example.com', idea_ar: 'جرّبه في بوتك' })) })
    },
  }
  const n = make({ llm: newsLlm, newsFetch })
  // الافتراضي في القالب: موقف — هذا الاختبار عن الموجز وهو مفعّل
  await n.settings.update({ features: { ai_news_digest: true } })
  await store.setKv('briefs_paused', '1')
  clock = new Date('2026-10-25T15:05:00Z')        // 18:05 الرياض
  await n.tick(); await n.idle()
  const m = sent.find((x) => x.startsWith('🗞️ موجز AI'))!
  assert.ok(m, 'أُرسل الموجز')
  assert.match(m, /^🗞️ موجز AI — 2026-10-25\n\n1\. Claude Code adds MCP skills marketplace\n   ملخص 1\n   💡 يهمك لأن…\n   🛠️ جرّبه في بوتك\n   🗓️ 2026-10-25 · Hacker News\n   🔗 https:\/\/example\.com\/news\/skills/)
  assert.match(m, /Gemini 4 notes for Next\.js developers/)
  assert.match(m, /🔗 https:\/\/example\.com\/g4/)
  assert.doesNotMatch(m, /Old agents post|evil/)
  assert.doesNotMatch(prompts[0], /https?:/, 'النموذج لا يرى روابط')
  assert.ok(fetched.some((u) => u.includes('hn.algolia.com')))

  sent.length = 0
  await n.tick(); await n.idle()
  assert.ok(!sent.some((x) => x.startsWith('🗞️')), 'مرة واحدة في اليوم')

  // عند الطلب في نفس اليوم: نفس الأخبار لا تتكرر
  await say('اخبار الذكاء اليوم', n)
  await n.idle()
  assert.match(sent.find((x) => x.startsWith('🗞️ موجز AI'))!, /ما لقيت أخبار جديدة/)

  sent.length = 0
  clock = new Date('2026-10-26T15:05:00Z')
  await n.tick(); await n.idle()
  assert.match(sent.find((x) => x.startsWith('🗞️ موجز'))!, /ما لقيت أخبار جديدة مهمة/, 'نفس الأخبار لا تتكرر في اليوم التالي')
  await store.setKv('briefs_paused', '0')
})

test('(h) موجز AI: بلا newsFetch (الاختبارات/تشغيل محلي) لا يلمس الشبكة', async () => {
  await say('موجز الذكاء')
  assert.match(last(), /غير متاح/)
})

// ───── (i) حد Claude ─────
test('(i) فشل بسبب حد Claude: الوقت الحقيقي للرجوع + عرض إعادة المحاولة (نعم N فقط) ← جدولة ← تشغيل تلقائي بعد الرجوع', async () => {
  const runs: any[] = []
  const d2: string[] = []
  const gh: GitHubClient = {
    ...github,
    async dispatchWorkflow(repo, _wf, _ref, inputs) {
      d2.push(inputs.request_id)
      runs.push({ id: d2.length, display_title: `claude ${inputs.request_id}`, name: 'Claude Code', status: 'completed', conclusion: 'failure', html_url: `https://github.com/${repo}/actions/runs/${d2.length}`, created_at: clock.toISOString() })
    },
    async listRuns() { return runs },
    async findPrByBranch() { return null },
    async runFailureText() { return `Claude AI usage limit reached|${Math.floor((clock.getTime() + 3 * 3600_000) / 1000)}` },
  }
  const c = make({ github: gh })
  script['عدّل في حضور الصفوف: أضف خانة ملاحظات'] = { actions: [{ type: 'code_change', project_query: 'حضور الصفوف', request: 'أضف خانة ملاحظات' }], reply: '' }
  await say('عدّل في حضور الصفوف: أضف خانة ملاحظات', c)
  const p1 = (await store.openPending(clock)).find((x) => x.kind === 'code_change' && x.payload.request === 'أضف خانة ملاحظات')!
  await say(`نعم ${p1.short_no}`, c)
  assert.equal(d2.length, 1)

  await c.pollJobs(); await c.idle()
  const m = sent.find((x) => x.startsWith('⏳ حد استخدام Claude خلص'))!
  assert.match(m, /يرجع تقريباً الساعة \d\d:\d\d/)
  const retry = (await store.openPending(clock)).find((x) => x.payload.retry_at)!
  assert.match(m, new RegExp(`أعيد المحاولة تلقائياً الساعة \\d\\d:\\d\\d؟ رد: نعم ${retry.short_no}`))
  assert.match(m, /Gemini داخل GitHub Actions غير متاح/)

  await say('زين', c)
  await say(`نعم ${retry.short_no}`, c)
  assert.match(last(), /^⏰ تمام، بعيد تشغيل الطلب على حضور الصفوف الساعة \d\d:\d\d/)
  assert.equal(d2.length, 1, 'لا تشغيل قبل الموعد')

  await c.tick(); assert.equal(d2.length, 1)
  clock = new Date(clock.getTime() + 3 * 3600_000 + 3 * 60_000)
  await c.tick(); await c.idle()
  assert.equal(d2.length, 2)
  assert.ok(sent.some((x) => x.startsWith('🔁 رجع حد Claude — أعيد تشغيل الطلب على حضور الصفوف')))
})

// ───── (j) نبض اللابتوب ─────
import { buildServer } from './server.js'
test('(j) POST /api/heartbeat بالتوكن فقط، و"لابتوبي فاتح؟" من آخر نبض', async () => {
  const hbA = make()
  await say('لابتوبي فاتح؟', hbA)
  assert.match(last(), /ما وصلني أي نبض من اللابتوب/)
  const app = buildServer({ assistant: hbA, webhookSecret: 's', heartbeat: { token: 'hb-secret-123', record: (i) => hbA.recordHeartbeat(i) } })
  const hit = (auth?: string, body: any = { host: 'DESK-LAPTOP' }) => app.inject({
    method: 'POST', url: '/api/heartbeat', payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
  })
  assert.equal((await hit()).statusCode, 401)
  assert.equal((await hit('Bearer wrong')).statusCode, 401)
  assert.equal((await hit('Bearer hb-secret-123')).statusCode, 200)
  await say('لابتوبي فاتح؟', hbA)
  assert.match(last(), /^🟢 اللابتوب شغال — آخر مرة شفته: اليوم .* · DESK-LAPTOP$/)
  clock = new Date(clock.getTime() + 30 * 60_000)
  await say('اللاب يشتغل الحين؟', hbA)
  assert.match(last(), /^⚪ اللابتوب ما يرد — آخر مرة شفته: .*\(قبل 3\d دقيقة\)/)
  await app.close()
})

// ───── (k) توكن ملصوق ─────
import { detectSecrets } from './lib/secrets.js'
test('(k) توكن Railway ملصوق: لا يُعاد ولا يُخزَّن ولا يصل للنموذج؛ يُضبط على خدمة البوت إن لم يكن وصول، وإلا يُذكر', async () => {
  const TOKEN = 'a7d0c4e2-5b19-4f6a-9c33-1e8b7d2f6a90'
  const setCalls: string[] = []
  const noRw = make({ railway: null, setOwnRailwayToken: async (t) => { setCalls.push(t) } })
  const before = systems.length
  await say(`خذ توكن الريلواي حقي ${TOKEN}`, noRw)
  assert.equal(systems.length, before, 'التوكن وصل للنموذج')
  assert.deepEqual(setCalls, [TOKEN])
  assert.match(last(), /لصقت توكن \(Railway\)/)
  assert.match(last(), /احذف الرسالة الحين/)
  assert.match(last(), /✅ ضبطت RAILWAY_API_TOKEN على خدمتي/)
  assert.ok(!sent.some((m) => m.includes(TOKEN)), 'التوكن ظهر في رد')
  const turns = await store.lastTurns(5)
  assert.ok(turns.every((t) => !t.text.includes(TOKEN)), 'التوكن في السجل')
  assert.ok(turns.some((t) => t.text.includes('[railway-token محجوب]')))

  // مع وصول موجود: لا ضبط
  await say(`my railway token is ${TOKEN}`)
  assert.match(last(), /عندي وصول Railway أصلاً/)
  // بلا وصول ولا معرّفات الخدمة: تعليمات دقيقة
  const noSetter = make({ railway: null, setOwnRailwayToken: null })
  await say(`هذا التوكن حق ريلوي ${TOKEN}`, noSetter)
  assert.match(last(), /railway\.com\/account\/tokens/)

  assert.deepEqual(detectSecrets('ghp_' + 'a'.repeat(36)).map((s) => s.kind), ['github'])
  assert.deepEqual(detectSecrets('رقم السجل a7d0c4e2-5b19-4f6a-9c33-1e8b7d2f6a90 موجود في الملف'), [], 'UUID عادي بلا ذكر توكن')
})
