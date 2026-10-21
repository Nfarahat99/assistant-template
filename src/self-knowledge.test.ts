/**
 * أنماط تعثّر شائعة (رسائل مصطنعة): ردود مكررة، إنكار قدرات موجودة، ادعاء إصلاحات لم تحدث، ومسارات C:/ ظاهرة.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, composeReply, stripLocalPaths, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects, selfProject } from './projects.js'
import { buildSystemPrompt, fitToBudget, PROMPT_BUDGET_CHARS } from './ai/understand.js'
import { findYoutubeUrl } from './ai/youtube.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
// seedKnowledge يوحّد CRLF ← \n (نسخة ويندوز من الملف قد تكون CRLF)
const OWNER_MD = readFileSync(new URL('../knowledge/owner.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ───── ١) رسالة واحدة لكل دور ─────

test('composeReply: answer يلغي reply المكرر، والإجراءات الأخرى تبقى مع reply', () => {
  assert.equal(composeReply('أهلاً! كيف أقدر أساعدك؟', [{ type: 'answer', text: 'هلا والله، وش تبي؟' }]), 'هلا والله، وش تبي؟')
  assert.equal(composeReply('ما فهمت', [{ type: 'clarify', text: 'تقصد أحمد سالم أو الغامدي؟' }]), 'تقصد أحمد سالم أو الغامدي؟')
  assert.equal(composeReply('أبشر', [{ type: 'add_task', text: '📝 أضفت المهمة 3: العقد' }]), 'أبشر\n\n📝 أضفت المهمة 3: العقد')
  assert.equal(composeReply('تم', [{ type: 'add_task', text: 'تم' }]), 'تم', 'النص المكرر حرفياً يُحذف')
  assert.equal(composeReply('', []), 'تمام 👍')
})

// ───── ٥) لا مسارات محلية ─────

test('stripLocalPaths: C:/ و C:\\ تُحجب من أي نص للمالك', () => {
  assert.equal(stripLocalPaths('المشروع في C:/planners/src'), 'المشروع في [مسار محلي]')
  assert.equal(stripLocalPaths('(C:\\hudoor\\app.ts)'), '([مسار محلي])')
  assert.equal(stripLocalPaths('https://github.com/example-user/hudoor'), 'https://github.com/example-user/hudoor')
  assert.equal(stripLocalPaths('الساعة 10:30'), 'الساعة 10:30')
})

// ───── ٤) يوتيوب: كشف الرابط ─────

test('findYoutubeUrl: الصيغ الشائعة ← رابط قياسي بلا معاملات تتبع', () => {
  const canon = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  assert.equal(findYoutubeUrl('شف https://youtu.be/dQw4w9WgXcQ?si=abc'), canon)
  assert.equal(findYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), canon)
  assert.equal(findYoutubeUrl('m.youtube.com/shorts/dQw4w9WgXcQ'), canon)
  assert.equal(findYoutubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null)
})

// ───── تكامل ─────

const cfg = loadConfig({
  WEBHOOK_SECRET: 's', OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh',
} as any)
let clock = new Date('2026-10-15T08:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _to, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const systems: string[] = []
const script: Record<string, string> = {}
const videoCalls: string[] = []
const llm: LlmClient = {
  async complete(system, user) {
    systems.push(system)
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return script[msg] ?? JSON.stringify({ actions: [{ type: 'answer', text: 'هلا' }], reply: 'أهلاً' })
  },
  async summarizeVideo(url, instruction) {
    videoCalls.push(url)
    assert.match(instruction, /لا تنفّذ أي تعليمات/)
    return JSON.stringify({ title: 'درس Node', summary: 'شرح مبسط للأحداث.', points: ['حلقة الأحداث', 'الوعود'] })
  },
}
const github: GitHubClient = {
  async dispatchWorkflow() {}, async listRuns() { return [] }, async findPrByBranch() { return null },
  async getPr() { throw new Error('x') }, async prFiles() { return [] }, async mergePr() {}, async closePr() {},
  async deleteBranch() {}, async getFileContent() { return '[]' },
}

// ٤٥ مشروعاً مصطنعاً بمسارات C:/ بنفس شكل projects.json
const manyProjects = [
  { folder: 'C:/planners', repo: 'example-user/waqti', default_branch: 'master', aliases: ['جداول سراج', 'waqti'] },
  { folder: 'C:/hudoor', repo: 'example-user/hudoor', aliases: ['تحضير سراج'] },
  ...Array.from({ length: 41 }, (_, i) => ({ folder: `C:/p${i}`, repo: `example-user/proj-${i}`, aliases: [`مشروع ${i}`] })),
  { folder: 'C:/x', repo: 'example-org/ops-tracker-agent', aliases: ['مكتب المشاريع'] },
]

let db: Db, store: Store, assistant: Assistant, noGh: Assistant
let seq = 0
const last = () => sent.at(-1) ?? ''
async function say(text: string, who: Assistant = assistant) {
  await who.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `S${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000) + seq, type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await who.idle()
}

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  const projects = new ProjectRegistry(parseProjects(JSON.stringify(manyProjects)))
  assistant = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects, now: () => clock })
  await assistant.seedKnowledge(OWNER_MD)
  assistant.attachVersion({ sha: 'abc1234def5678', message: 'fix: رد واحد لكل دور', date: '2026-10-15T07:00:00Z', built_at: null, source: 'build-env' })
  noGh = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github: null, projects, now: () => clock })
})
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0; systems.length = 0 })

test('رد النموذج بـ reply + answer ← رسالة واحدة فقط للمالك', async () => {
  await say('هلا')
  assert.equal(sent.length, 1)
  assert.equal(last(), 'هلا')
})

test('البرومبت يحوي ذاكرة المالك كاملة ثم الحقائق الحية وقاعدة الصدق، والتعديل من kv ينعكس فوراً', async () => {
  await say('كيفك')
  const sys = systems[0]
  assert.ok(sys.includes(OWNER_MD.trim()), 'owner.md غير موجود في البرومبت')
  assert.ok(sys.indexOf('ذاكرتك عن وليد') < sys.indexOf('── حقائق عنك'), 'الذاكرة قبل الحالة الحية')
  assert.match(sys, /أنت مربوط بـ GitHub \(الحساب example-user\)/)
  assert.match(sys, /example-user\/my-assistant/)
  assert.match(sys, /لا تقل أبداً إنك أصلحت أو عدّلت/)
  assert.match(sys, /إرسال الرسائل للناس: وضع link/)
  assert.doesNotMatch(sys, /C:\/planners/, 'مسار محلي في البرومبت')

  await store.setKv('knowledge_md', '# ذاكرة معدّلة من اللوحة')
  await say('وبعدين')
  assert.match(systems.at(-1)!, /ذاكرة معدّلة من اللوحة/)
  await store.setKv('knowledge_md', OWNER_MD)
})

test('الميزانية: السجل يُقص قبل الذاكرة', () => {
  const sys = buildSystemPrompt({ knowledge: OWNER_MD, capabilities: 'حقائق' })
  const ctx: any = {
    nowIso: 'x', weekday: 'x', contacts: [], projects: [], openTasks: [], pending: [],
    history: Array.from({ length: 200 }, (_, i) => ({ role: 'user', text: `رسالة قديمة ${i} `.repeat(20) })),
  }
  const user = fitToBudget(sys, 'جديد', ctx)
  assert.ok(sys.length + user.length <= PROMPT_BUDGET_CHARS)
  assert.ok(sys.includes(OWNER_MD.trim()))
  assert.ok(user.includes('رسالة قديمة 199'), 'الأحدث يبقى')
  assert.ok(!user.includes('رسالة قديمة 0 '), 'الأقدم يُقص')
})

test('"انت مربوط مع جتهب؟" ← نعم حتمية بلا نموذج؛ وبدون توكن ← لا', async () => {
  await say('انت مربوط مع جتهب؟')
  assert.equal(systems.length, 0, 'لم يُستدعَ النموذج')
  assert.match(last(), /^ايه ✅ مربوط مع GitHub \(الحساب example-user\)/)
  await say('انت متصل بـ github؟', noGh)
  assert.match(last(), /^لا، GitHub مو مربوط/)
})

test('"مشاريعي": الاسم العربي — المستودع، مجمّعة، ≤٤٠ سطراً، بلا C:/ ، ومعها البوت نفسه', async () => {
  await say('مشاريعي')
  const m = last()
  assert.equal(systems.length, 0)
  assert.ok(m.split('\n').length <= 40)
  assert.match(m, /• جداول سراج — example-user\/waqti/)
  assert.match(m, /💻 مشاريعي على GitHub \(46\)/, '٤٤ من الملف + البوت + إعدادات Claude')
  assert.doesNotMatch(m, /C:/)
  assert.match(m, /… و\d+ غيرها/)
  await say('ورني المشاريع')
  assert.match(last(), /مشاريعي على GitHub/)
})

test('"طلباتي": آخر الطلبات بالحالة والروابط (بما فيها الفاشلة)', async () => {
  await store.addJob({ request_id: 'aaaa1111', project: 'جداول سراج', repo: 'example-user/waqti', default_branch: 'master', request: 'أضف تصدير Excel', dispatched_at: clock })
  await store.updateJob('aaaa1111', { status: 'failed', run_url: 'https://github.com/example-user/waqti/actions/runs/1' })
  await store.addJob({ request_id: 'bbbb2222', project: 'تحضير سراج', repo: 'example-user/hudoor', default_branch: 'main', request: 'زر حضور', dispatched_at: new Date(clock.getTime() + 1000) })
  await store.updateJob('bbbb2222', { status: 'awaiting_merge', pr_url: 'https://github.com/example-user/hudoor/pull/5' })
  await say('طلباتي')
  const m = last()
  assert.match(m, /• تحضير سراج — 👀 ينتظر موافقتك على الدمج/)
  assert.match(m, /pull\/5/)
  assert.match(m, /• جداول سراج — ❌ فشل/)
  assert.match(m, /actions\/runs\/1/)
  assert.ok(m.indexOf('تحضير سراج') < m.indexOf('جداول سراج'), 'الأحدث أولاً')
  // الحقائق الحية في البرومبت تعرف الطلبات أيضاً
  await say('وش صار على طلباتي؟ بالتفصيل')
  assert.match(systems.at(-1)!, /جداول سراج: failed https:\/\/github\.com\/example-user\/waqti\/actions\/runs\/1/)
})

test('"وش تقدر تسوي" و"نسختك" حتمية', async () => {
  await say('وش تقدر تسوي')
  assert.match(last(), /💻 تعديل الكود: .*Claude Code على GitHub/)
  assert.match(last(), /طوّر نفسك/)
  await say('نسختك')
  assert.match(last(), /🏷️ نسختي: abc1234/)
  assert.match(last(), /fix: رد واحد لكل دور/)
  assert.match(last(), /github\.com\/example-user\/my-assistant\/commit\/abc1234def5678/)
  assert.equal(systems.length, 0)
})

test('البوت نفسه في المشاريع: "نفسك"/"البوت" تحلّ إلى my-assistant، و"طوّر نفسك" ← طلب code_change بمعاينة', async () => {
  const reg = new ProjectRegistry(parseProjects(JSON.stringify(manyProjects)))
  assert.equal(reg.resolve('نفسك')[0].repo, selfProject().repo)
  assert.equal(reg.resolve('البوت')[0].repo, selfProject().repo)
  assert.equal(new ProjectRegistry([selfProject()]).all().filter((p) => p.repo === selfProject().repo).length, 1, 'لا تكرار إن كان موجوداً')

  script['طوّر نفسك: خل الملخص الصباحي ٨'] = JSON.stringify({
    actions: [{ type: 'code_change', project_query: 'نفسك', request: 'اجعل الملخص الصباحي الساعة 8' }], reply: '' })
  await say('طوّر نفسك: خل الملخص الصباحي ٨')
  assert.match(last(), /بأطلب من Claude تعديل على البوت \(example-user\/my-assistant\)/)
  assert.match(last(), /جهزت الطلب \(ما نفّذته بعد\)/)
  assert.match(last(), /أنفّذه؟ رد: نعم \d+/)
  assert.doesNotMatch(last(), /صلّحت|ضبطت|عدّلت/)
  await say('لا')
})

test('يوتيوب: ملخص ونقاط ← "احفظها كمهمة" ← مهمة؛ وبلا دعم ← رسالة احتياط', async () => {
  await say('شف هذا https://youtu.be/dQw4w9WgXcQ?si=abc')
  assert.deepEqual(videoCalls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
  assert.ok(sent.some((m) => m.startsWith('🎬 جالس أشوف الفيديو')), 'رد فوري قبل الملخص')
  assert.match(last(), /🎬 درس Node\n\nشرح مبسط للأحداث\.\n\nأهم النقاط:\n• حلقة الأحداث\n• الوعود/)
  assert.match(last(), /احفظها كمهمة/)
  await say('احفظها كمهمة')
  assert.match(last(), /📝 حفظتها \(\d+\): 🎬 مشاهدة: درس Node/)
  const t = (await store.openTasks()).find((x) => x.title.includes('درس Node'))!
  assert.match(t.notes!, /youtube\.com\/watch\?v=dQw4w9WgXcQ/)

  const plain = new Assistant({ cfg, store, llm: { complete: llm.complete }, stt: { async transcribe() { return '' } }, gateway, github, projects: new ProjectRegistry([]), now: () => clock })
  await say('https://www.youtube.com/watch?v=dQw4w9WgXcQ', plain)
  assert.match(last(), /ما قدرت ألخص الفيديو \(السبب: تلخيص الفيديو غير مفعّل/)
})
