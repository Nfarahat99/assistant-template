/**
 * Hotfix: البوت "شكله فصل" — فيديو يوتيوب علّق الطابور، ولا رد عند انتهاء المهلة، وأسباب مخترعة.
 * هنا: الخلفية لا تحجب، إشعار استلام، شبكة أمان، أعطال صادقة، وبحث ويب بمصادر حقيقية فقط.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry } from './projects.js'
import { parseGrounded, extractItems, formatNews } from './ai/websearch.js'
import type { GatewayClient } from './clients/gateway.js'
import type { LlmClient } from './ai/providers.js'
import type { OwnerChannel, SentRef } from './channels.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───── استجابة Gemini حقيقية الشكل مع groundingMetadata ─────
const GROUNDED = {
  candidates: [{
    content: { parts: [{ text:
      '1. Anthropic تطلق Claude Code agents SDK — يفيدك لأتمتة طلبات الكود في البوت\n' +
      '2. Railway تضيف نشراً تلقائياً للـ monorepo — يسهّل نشر مشاريعك من GitHub مباشرة https://fake.example/invented\n' +
      '3. خبر بلا مصدر عن شيء مخترع — لا يجب أن يظهر\n' }] },
    groundingMetadata: {
      webSearchQueries: ['AI news today Claude Code'],
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'anthropic.com' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', title: 'blog.railway.com' } },
      ],
      groundingSupports: [
        { segment: { startIndex: 3, endIndex: 50, text: 'Anthropic تطلق Claude Code agents SDK' }, groundingChunkIndices: [0] },
        { segment: { startIndex: 90, endIndex: 140, text: 'Railway تضيف نشراً تلقائياً للـ monorepo' }, groundingChunkIndices: [1, 7] },
      ],
    },
  }],
}

test('grounding: البنود تُربط بمصادرها الحقيقية فقط، والبند بلا مصدر يُحذف، والروابط داخل النص تُزال', () => {
  const g = parseGrounded(GROUNDED)
  assert.equal(g.chunks.length, 2)
  assert.deepEqual(g.queries, ['AI news today Claude Code'])
  const items = extractItems(g)
  assert.equal(items.length, 2, 'البند الثالث بلا مصدر')
  assert.equal(items[0].title, 'Anthropic تطلق Claude Code agents SDK')
  assert.equal(items[0].why, 'يفيدك لأتمتة طلبات الكود في البوت')
  assert.deepEqual(items[0].sources.map((s) => s.title), ['anthropic.com'])
  assert.deepEqual(items[1].sources.map((s) => s.uri), ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB'], 'فهرس ٧ غير موجود يُتجاهل')
  const out = formatNews('أخبار AI', items)
  assert.doesNotMatch(out, /fake\.example/, 'رابط مخترع ظهر')
  assert.doesNotMatch(out, /مخترع/)
  for (const url of out.match(/https?:\/\/\S+/g) ?? []) {
    assert.ok(g.chunks.some((c) => c.uri === url), `رابط ليس من نتائج البحث: ${url}`)
  }
  assert.match(formatNews('x', []), /ما طلعت نتائج لها مصادر موثوقة/)
})

// ───── تكامل ─────
let db: Db, store: Store
const waSent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { waSent.push(text); return { id: `g${waSent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
let seq = 0
const payload = (text: string | null, extra: Partial<InboundPayload> = {}): InboundPayload => ({
  event: 'message', session_phone: ASSISTANT, message_id: `H${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
  timestamp: Math.floor(Date.now() / 1000) + seq, type: 'text', text, media: null, quoted_message_id: null, ...extra,
} as InboundPayload)

/** قناة تيليجرام مزيّفة تسجّل كل شيء */
function fakeTelegram() {
  const log: { op: 'send' | 'edit' | 'typing'; text?: string; id?: string }[] = []
  let n = 0
  const ch: OwnerChannel = {
    name: 'telegram', available: () => true,
    async send(text) { const id = `tg:${++n}`; log.push({ op: 'send', text, id }); return { id, quoteKey: id } },
    async typing() { log.push({ op: 'typing' }) },
    async edit(ref: SentRef, text: string) { log.push({ op: 'edit', text, id: ref.id ?? undefined }); return true },
  }
  return { ch, log }
}

function make(llm: LlmClient, opts: { ackAfterMs?: number; stillWorkingMs?: number } = {}) {
  return new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github: null, projects: new ProjectRegistry([]), ...opts })
}
const answer = (text: string) => JSON.stringify({ actions: [{ type: 'answer', text }], reply: '' })

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
})
after(async () => { await db.close() })
beforeEach(() => { waSent.length = 0 })

test('فيديو يوتيوب في الخلفية: رد فوري، والطابور يرد على الرسائل التالية قبل جهوز الملخص', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const a = make({
    async complete() { return answer('x') },
    async summarizeVideo() { await gate; return JSON.stringify({ title: 'فيديو طويل', summary: 'ملخص.', points: [] }) },
  })
  await a.accept(payload('https://youtu.be/dQw4w9WgXcQ'))
  await a.idleQueue()
  assert.equal(waSent.at(-1), '🎬 جالس أشوف الفيديو، أرسل لك الملخص بعد شوي')

  await a.accept(payload('مهامي'))
  await a.idleQueue()
  assert.match(waSent.at(-1)!, /مهام|ما عندك/, 'الرسالة الثانية رُدّ عليها والفيديو لسه شغال')
  assert.ok(!waSent.some((m) => m.includes('فيديو طويل')))

  release()
  await a.idle()
  assert.match(waSent.at(-1)!, /🎬 فيديو طويل/)
})

test('فشل الفيديو (TimeoutError): رد واضح بالسبب، ويُسجَّل العطل الحقيقي، والنموذج لا يخترع سبباً', async () => {
  const systems: string[] = []
  const a = make({
    async complete(system) { systems.push(system); return answer('ما أعرف السبب بالضبط') },
    async summarizeVideo() { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e },
  })
  await a.accept(payload('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
  await a.idle()
  assert.equal(waSent.at(-1), 'ما قدرت ألخص الفيديو (السبب: الفيديو طويل وأخذ وقت أكثر من المسموح) — جرب فيديو أقصر أو أرسل لي عنوانه')

  await a.accept(payload('ليش ما لخصت الفيديو؟'))
  await a.idle()
  const sys = systems.at(-1)!
  assert.match(sys, /آخر الأعطال الحقيقية/)
  assert.match(sys, /تلخيص فيديو يوتيوب: TimeoutError: The operation was aborted due to timeout/)
  assert.match(sys, /لا تخمّن أسباباً غير مكتوبة هناك/)
  assert.match(sys, /ما أعرف السبب بالضبط، الخطأ كان/)
})

test('شبكة أمان: أي خطأ غير متوقع في المعالجة = رد قصير، لا صمت', async () => {
  const a = make({ async complete() { return answer('x') } })
  ;(a as any).handleText = async () => { throw new Error('boom: قاعدة البيانات') }
  await a.accept(payload('هلا'))
  await a.idle()
  assert.match(waSent.at(-1)!, /^معليش، صار خطأ عندي وما قدرت أكمل 😕 \(boom: قاعدة البيانات\)/)
})

test('تيليجرام: "يكتب…" فوراً، "✅ استلمت" بعد المهلة، ثم يُعدَّل الإشعار للرد النهائي (بلا رسالة ثانية)', async () => {
  const a = make({ async complete() { await sleep(120); return answer('الرد النهائي') } }, { ackAfterMs: 20 })
  const tg = fakeTelegram()
  a.attachTelegram(tg.ch)
  await a.acceptTelegram(payload('سؤال يحتاج تفكير'))
  await a.idle()
  assert.equal(tg.log[0].op, 'typing')
  const sends = tg.log.filter((l) => l.op === 'send')
  assert.equal(sends.length, 1)
  assert.equal(sends[0].text, '✅ استلمت، جاري العمل…')
  const edit = tg.log.find((l) => l.op === 'edit')!
  assert.equal(edit.text, 'الرد النهائي')
  assert.equal(edit.id, sends[0].id)
  assert.equal(waSent.length, 0)
})

test('أمر فوري (<٣ث): لا إشعار استلام', async () => {
  const a = make({ async complete() { return answer('x') } }, { ackAfterMs: 200 })
  const tg = fakeTelegram()
  a.attachTelegram(tg.ch)
  await a.acceptTelegram(payload('مهامي'))
  await a.idle()
  await sleep(250)
  assert.ok(!tg.log.some((l) => l.text === '✅ استلمت، جاري العمل…'))
  assert.equal(tg.log.filter((l) => l.op === 'send').length, 1)
})

test('طال العمل: "لحظة، أشتغل عليها…"، وواتساب يأخذ إشعاراً نصياً ثم الرد', async () => {
  const a = make({ async complete() { await sleep(150); return answer('خلصت') } }, { ackAfterMs: 20, stillWorkingMs: 60 })
  await a.accept(payload('طلب طويل'))
  await a.idle()
  assert.deepEqual(waSent, ['✅ استلمت، جاري العمل…', 'لحظة، أشتغل عليها… ⏳', 'خلصت'])
})

test('web_search: رد فوري ثم نتائج بروابط من البحث فقط؛ والفشل يُذكر بخطئه الحقيقي', async () => {
  let fail = false
  const a = make({
    async complete() { return JSON.stringify({ actions: [{ type: 'web_search', query: 'أخبار AI اليوم', purpose: 'تفيد شغلي' }], reply: '' }) },
    async searchWeb(prompt) {
      assert.match(prompt, /أخبار AI اليوم/)
      assert.match(prompt, /Claude Code/)
      if (fail) { const e: any = new Error('Gemini gemini-3.8-flash HTTP 503: overloaded'); e.status = 503; throw e }
      return parseGrounded(GROUNDED)
    },
  })
  await a.accept(payload('عطني اخبار ال AI اليوم من النت'))
  await a.idle()
  assert.ok(waSent.includes('🔎 جالس أدور لك عن «أخبار AI اليوم»، أرسل لك النتائج بعد شوي'))
  const res = waSent.at(-1)!
  assert.match(res, /1\. Anthropic تطلق Claude Code agents SDK/)
  assert.match(res, /🔗 anthropic\.com: https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/AAA/)
  assert.doesNotMatch(res, /fake\.example|مخترع/)

  fail = true
  await a.accept(payload('ابحث مرة ثانية'))
  await a.idle()
  assert.match(waSent.at(-1)!, /^ما قدرت أكمل البحث \(الخطأ: Error: Gemini gemini-3\.8-flash HTTP 503: overloaded\)/)
  const failures = await a.lastFailures()
  assert.match(failures[0].error, /HTTP 503/)
})
