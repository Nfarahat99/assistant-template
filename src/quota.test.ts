/**
 * حصة الذكاء: تنبيه ٨٠٪ و٩٥٪ مرة في اليوم، التحويل للاحتياطي عند 429، رسالة النفاد، وتأجيل الرسائل لما بعد التجدد.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry } from './projects.js'
import { QuotaTracker, quotaDay, claudeLimitInfo } from './quota.js'
import { setUsageSink, recordUsage, listPrice } from './usage.js'
import type { GatewayClient } from './clients/gateway.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

test('يوم الحصة: يتجدد منتصف الليل بتوقيت المحيط الهادئ (١٠ الصبح بالرياض صيفاً)', () => {
  const d = quotaDay(new Date('2026-10-01T12:00:00Z'))   // 05:00 PDT
  assert.equal(d.start.toISOString(), '2026-10-01T07:00:00.000Z')
  assert.equal(d.resetsAt.toISOString(), '2026-10-02T07:00:00.000Z')
})

test('حد Claude: يكشف "usage limit" ويستخرج وقت التجدد', () => {
  const now = new Date('2026-10-01T08:00:00Z')
  const a = claudeLimitInfo('Claude AI usage limit reached|1759312800', now)
  assert.equal(a.limited, true)
  assert.equal(a.resetsAt!.toISOString(), new Date(1759312800 * 1000).toISOString())
  const b = claudeLimitInfo('Error: Your usage limit will reset at 3pm (Asia/Riyadh)', now)
  assert.equal(b.resetsAt!.toISOString(), '2026-10-01T12:00:00.000Z')
  assert.equal(claudeLimitInfo('Process completed with exit code 1', now).limited, false)
})

test('سعر القائمة: gemini-3.8-flash بالتوكنز', () => {
  assert.equal(listPrice({ model: 'gemini-3.8-flash', input_tokens: 1_000_000, output_tokens: 100_000, audio_seconds: null }), 1.125)
  assert.equal(listPrice({ model: 'unknown', input_tokens: 5, output_tokens: 5, audio_seconds: null }), 0)
})

const gemOnly = (primary: string, fallback: string) => {
  const r = { provider: 'gemini' as const, model: primary, fallback: { provider: 'gemini' as const, model: fallback } }
  return { understand: r, general: r }
}

let db: Db, store: Store
let clock = new Date('2026-10-01T12:00:00Z')
before(async () => { db = await createDb({ pgliteDir: 'memory://' }); await migrate(db); store = new Store(db) })
after(async () => { setUsageSink(null); await db.close() })

test('التنبيهات: ٨٠٪ مرة واحدة، ثم ٩٥٪ مرة واحدة، ولا تكرار في نفس اليوم', async () => {
  const notes: string[] = []
  const q = new QuotaTracker(store, () => gemOnly('m-a', 'm-b'), async (t) => notes.push(t), 'Asia/Riyadh', () => clock,
    { requests: { 'm-a': 10 }, tokens: {} })
  const call = async () => {
    await store.addUsage({ ts: clock, provider: 'gemini', model: 'm-a', purpose: 'chat', input_tokens: 10, output_tokens: 5, audio_seconds: null, latency_ms: 1, ok: true, est_list_usd: 0, est_cost_usd: 0 })
    await q.onUsage({ provider: 'gemini', model: 'm-a', purpose: 'chat', input_tokens: 10, output_tokens: 5, audio_seconds: null, latency_ms: 1, ok: true })
  }
  for (let i = 0; i < 7; i++) await call()
  assert.equal(notes.length, 0)
  await call()                                            // 8/10
  assert.equal(notes.length, 1)
  assert.match(notes[0], /⚠️ استهلكت 80% من حصة الذكاء اليوم \(8 من 10\)\. باقي تقريباً 2 طلب/)
  await call()                                            // 9/10 — لا تكرار لـ٨٠
  assert.equal(notes.length, 1)
  await call()                                            // 10/10 → ٩٥٪
  assert.equal(notes.length, 2)
  assert.match(notes[1], /🚨 حصة الذكاء \(m-a\) قربت تخلص: 10 من 10/)
  await call()
  assert.equal(notes.length, 2)
  const snap = await q.snapshot()
  assert.equal(snap[0].used_requests, 11)
  assert.equal(snap[0].limit_requests, 10)
})

test('النماذج من settings.models: الفهم على Claude (بمفتاح) + نفاد حصة Gemini ← ليست «خالصة كلها»؛ Gemini فقط ← خالصة', async () => {
  const day = new Date('2026-11-01T12:00:00Z')
  const exhaust = async (q: QuotaTracker) => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      await q.onUsage({ provider: 'gemini', model, purpose: 'chat', input_tokens: 0, output_tokens: 0, audio_seconds: null, latency_ms: 1, ok: false, error: 'HTTP 429 RESOURCE_EXHAUSTED' })
    }
  }
  const gem = gemOnly('gemini-3.8-flash', 'gemini-3.5-flash-lite')
  const claudeUnderstand = { ...gem, understand: { provider: 'anthropic' as const, model: 'claude-opus-5-5', fallback: { provider: 'gemini' as const, model: 'gemini-3.8-flash' } } }
  const notes: string[] = []
  const withKey = new QuotaTracker(store, () => claudeUnderstand, async (t) => notes.push(t), 'Asia/Riyadh', () => day, { requests: {}, tokens: {} }, (p) => p === 'anthropic')
  await exhaust(withKey)
  assert.equal(withKey.isExhausted('gemini-3.8-flash'), true)
  assert.equal(withKey.allExhausted(), false, 'Claude بمفتاح في سلسلة الفهم')
  assert.ok(!notes.some((n) => n.includes('خلصت حصة الذكاء اليوم')))
  const noKey = new QuotaTracker(store, () => claudeUnderstand, async () => {}, 'Asia/Riyadh', () => day, { requests: {}, tokens: {} }, () => false)
  await noKey.load()
  assert.equal(noKey.allExhausted(), true, 'Claude بلا مفتاح لا يُحسب')
  const gemini = new QuotaTracker(store, () => gem, async () => {}, 'Asia/Riyadh', () => day, { requests: {}, tokens: {} }, () => true)
  await gemini.load()
  assert.equal(gemini.allExhausted(), true, 'Gemini فقط: السلوك القديم')
  assert.deepEqual((await gemini.snapshot()).map((x) => x.model), ['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
})

// ───── النفاد والتأجيل في المساعد ─────

const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
let exhausted = new Set<string>()
const calls: string[] = []
/** نموذج مزيّف يسجّل الاستهلاك كما يفعل العميل الحقيقي، ويرمي 429 للنموذج الخالص */
const llm: LlmClient = {
  async complete(_s, user) {
    for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      if (exhausted.has(model)) {
        recordUsage({ provider: 'gemini', model, input_tokens: 0, output_tokens: 0, latency_ms: 1, ok: false, error: 'Gemini HTTP 429: RESOURCE_EXHAUSTED' })
        continue
      }
      recordUsage({ provider: 'gemini', model, input_tokens: 100, output_tokens: 20, latency_ms: 1, ok: true })
      calls.push(model)
      const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
      return JSON.stringify({ actions: [{ type: 'answer', text: `رد على: ${msg}` }], reply: '' })
    }
    throw Object.assign(new Error('Gemini HTTP 429: RESOURCE_EXHAUSTED'), { status: 429 })
  },
}
let a: Assistant
let seq = 0
const say = async (text: string) => {
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `Q${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000) + seq, type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
}

beforeEach(() => { sent.length = 0 })

test('429 على الأساسي ← "حولت للاحتياطي" مرة؛ الاثنين ← رسالة النفاد، والرسائل تُحفظ مهاماً وتُعالج بعد التجدد', async () => {
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github: null, projects: new ProjectRegistry([]), now: () => clock })
  setUsageSink(a.usageSink())

  exhausted = new Set(['gemini-3.8-flash'])
  await say('هلا')
  assert.ok(sent.some((m) => /⚠️ حصة النموذج الأساسي \(gemini-3\.8-flash\) خلصت، حولت للاحتياطي \(gemini-3\.5-flash-lite\)/.test(m)))
  assert.ok(sent.some((m) => /رد على: هلا/.test(m)))
  assert.equal(a.quota.primaryExhausted(), true)
  await say('ثاني')
  assert.equal(sent.filter((m) => m.includes('حولت للاحتياطي')).length, 1, 'تنبيه التحويل مرة واحدة')

  exhausted = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
  await say('ذكرني أراجع العقد بكرة')
  assert.ok(sent.some((m) => /❌ خلصت حصة الذكاء اليوم\. ترجع الساعة .* بتوقيت الرياض\. أقدر أسجل رسائلك وأرد عليها بعدين\./.test(m)))
  assert.equal(a.quota.allExhausted(), true)

  // الرسالة التالية لا تستدعي النموذج — تُسجل مهمة خاماً وتُؤجل
  const before = calls.length
  await say('أرسل التقرير لسامي الساعة ٥')
  assert.equal(calls.length, before, 'النموذج استُدعي والحصة خالصة')
  assert.match(sent.at(-1)!, /سجلت رسالتك كمهمة \(\d+\) وبرد عليها بعد ما ترجع الحصة/)
  const raw = (await store.openTasks()).find((t) => t.title.includes('أرسل التقرير لسامي'))!
  assert.equal(raw.source, 'deferred')

  // قبل التجدد: لا معالجة
  await a.tick()
  assert.ok(!sent.some((m) => m.startsWith('↩️')))

  // بعد منتصف الليل (PT): الحصة رجعت ← المؤجل يُعالج، والمهمة الخام تُغلق
  exhausted = new Set()
  clock = new Date('2026-10-02T07:05:00Z')
  await a.tick()
  await a.idle()
  const replied = sent.find((m) => m.startsWith('↩️ ردي على رسالتك'))!
  assert.match(replied, /«أرسل التقرير لسامي الساعة ٥»/)
  assert.match(replied, /رد على: أرسل التقرير لسامي الساعة ٥/)
  assert.equal((await store.getTask(raw.id))!.status, 'done')
})

test('المساعد: الفهم على Claude (بمفتاح) وحصة Gemini خالصة ← يرد عادي بلا تأجيل', async () => {
  const cfgC = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh', ANTHROPIC_API_KEY: 'a' } as any)
  const claude: LlmClient = {
    async complete(_s, user) {
      recordUsage({ provider: 'anthropic', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, latency_ms: 1, ok: true })
      const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
      return JSON.stringify({ actions: [{ type: 'answer', text: `كلود: ${msg}` }], reply: '' })
    },
  }
  clock = new Date('2026-10-05T12:00:00Z')
  const c = new Assistant({ cfg: cfgC, store, llm: claude, stt: { async transcribe() { return '' } }, gateway, github: null, projects: new ProjectRegistry([]), now: () => clock })
  const r = await c.settings.update({ models: { understand: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } } })
  assert.equal(r.ok, true)
  for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
    await c.quota.onUsage({ provider: 'gemini', model, purpose: 'chat', input_tokens: 0, output_tokens: 0, audio_seconds: null, latency_ms: 1, ok: false, error: 'HTTP 429 RESOURCE_EXHAUSTED' })
  }
  assert.equal(c.quota.isExhausted('gemini-3.5-flash-lite'), true)
  assert.equal(c.quota.allExhausted(), false)
  a = c
  setUsageSink(c.usageSink())
  await say('هلا كلود')
  assert.ok(sent.some((m) => /كلود: هلا كلود/.test(m)), sent.join(' | '))
  assert.ok(!sent.some((m) => /سجلت رسالتك كمهمة|خلصت حصة الذكاء/.test(m)), sent.join(' | '))
})
