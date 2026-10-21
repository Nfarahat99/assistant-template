/**
 * المراجعة الذاتية: التجميع بالنموذج والرجوع للقواعد، إنشاء طلبات الإصلاح (بموافقة فقط)،
 * المجدول، وحفظ حالة "هذا غلط، المفروض …". PGlite في الذاكرة، بلا شبكة.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../config.js'
import { createDb, type Db } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { Store } from '../store.js'
import { Settings } from '../settings.js'
import { Assistant } from '../assistant.js'
import { ProjectRegistry } from '../projects.js'
import type { GatewayClient } from '../clients/gateway.js'
import type { GitHubClient } from '../clients/github.js'
import type { LlmClient } from '../ai/providers.js'
import { SelfReview, REVIEW_CLAIM_KEY, type SelfReviewDeps } from './review.js'
import { listCases } from './cases.js'
import { SAMPLE_TRANSCRIPT } from './fixtures.js'
import { parseTranscript } from './signals.js'
import { selfReviewSnapshot } from './dashboard.js'
import { SEED_CASES } from '../evals/seed-cases.js'
import { ownerName, assistantName, profile } from '../profile.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)
const settings = new Settings(cfg)

// 23:40 بالرياض يوم ٥ أكتوبر (المحادثة المصطنعة 18:04–19:13 بالرياض)
let clock = new Date('2026-10-05T20:40:00Z')
let db: Db
let store: Store

const CLUSTER_OK = (ids: number[]) => JSON.stringify({ items: ids.map((id) => ({
  incident: id, title: `عنوان ${id}`, what_went_wrong: 'سألت أسئلة متتالية', fix: 'سؤال واحد كحد أقصى', needs_code: true, code_request: 'حد أقصى لسؤال توضيح واحد',
})) })

let llmMode: 'throw' | 'garbage' | 'ok' = 'throw'
const llm: LlmClient = {
  async complete(system) {
    if (llmMode === 'throw') throw new Error('HTTP 503 من المزوّد')
    if (llmMode === 'garbage') return 'مو JSON أبداً'
    // يرد بأرقام الحوادث المذكورة في الطلب
    void system
    return CLUSTER_OK(lastIds)
  },
}
let lastIds: number[] = []
const spyLlm: LlmClient = { async complete(s, u) { lastIds = [...u.matchAll(/### حادثة (\d+)/g)].map((m) => +m[1]); return llm.complete(s, u) } }

const proposed: string[] = []
const said: { text: string; ids: number[] }[] = []
let seq = 0
const claims = new Set<string>()
function deps(over: Partial<SelfReviewDeps> = {}): SelfReviewDeps {
  return {
    db, llm: spyLlm, now: () => clock, tz: 'Asia/Riyadh',
    say: async (text, ids) => { said.push({ text, ids }) },
    proposeCode: async (request) => { proposed.push(request); seq++; return { id: seq, no: 900 + seq } },
    claim: async (k, v) => { const key = `${k}=${v}`; if (claims.has(key)) return false; claims.add(key); return true },
    ...over,
  }
}

async function seedTurns() {
  await db.query('DELETE FROM turns')
  for (const t of parseTranscript(SAMPLE_TRANSCRIPT)) await db.query('INSERT INTO turns (role, text, created_at) VALUES ($1,$2,$3)', [t.role, t.text, t.at])
}

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  await seedTurns()
  // الافتراضي في القالب: موقف — هذه الاختبارات عن المراجعة الليلية وهي مفعّلة
  await settings.update({ features: { self_review: true } })
})
after(async () => { await db.close() })
beforeEach(() => { proposed.length = 0; said.length = 0; llmMode = 'throw'; clock = new Date('2026-10-05T20:40:00Z') })

test('النموذج فشل ← التجميع بالقواعد، والرسالة «🪞 مراجعة اليوم: X محادثات، Y تعثّرات» + أهم ٣', async () => {
  const r = await new SelfReview(deps()).run()
  assert.equal(r.clusteredBy, 'rules')
  assert.match(r.message, /^🪞 مراجعة اليوم: [٠-٩]+ محادثات، [٠-٩]+ تعثّرات/)
  assert.ok(r.failures >= 5, `تعثّرات: ${r.failures}`)
  assert.ok(r.items.length >= 1 && r.items.length <= 3)
  for (const it of r.items) { assert.ok(it.quote && it.what_went_wrong && it.fix) }
  assert.match(r.message, /«.+»\n❌ .+\n💡 .+/)
  assert.equal(said.length, 1, 'رسالة واحدة للمالك')
})

test('مخرج نموذج غير صالح ← القواعد؛ ومخرج صالح ← عناوين النموذج', async () => {
  llmMode = 'garbage'
  assert.equal((await new SelfReview(deps()).run({ notify: false })).clusteredBy, 'rules')
  llmMode = 'ok'
  const r = await new SelfReview(deps()).run({ notify: false })
  assert.equal(r.clusteredBy, 'llm')
  assert.ok(r.items.every((i) => /^عنوان \d+$/.test(i.title)))
})

test('ما يحتاج كوداً ← طلب معلّق بدليل من المحادثة، ورقمه في الرسالة مع «نعم N» (لا تنفيذ)', async () => {
  llmMode = 'ok'
  const r = await new SelfReview(deps()).run()
  assert.ok(proposed.length >= 1)
  assert.ok([ownerName(), assistantName()].some((n) => proposed[0].includes(`الدليل (مقتطف المحادثة):\n${n}: `)), proposed[0])
  assert.match(proposed[0], /seed-cases\.ts/)
  for (const no of r.pendingNos) assert.match(r.message, new RegExp(`«نعم ${no}» لتنفيذه`))
  assert.deepEqual(said.at(-1)!.ids, r.pendingIds, 'الطلبات تُربط برسالة المراجعة (معاينة قبل الموافقة)')
})

test('تعديلات الكود غير متاحة (proposeCode=null) ← اقتراح نصي فقط بلا طلبات', async () => {
  llmMode = 'ok'
  const r = await new SelfReview(deps({ proposeCode: async () => null })).run({ notify: false })
  assert.equal(r.pendingIds.length, 0)
  assert.doesNotMatch(r.message, /نعم \d+/)
})

test('كل حادثة تصير حالة تقييم (selfreview) — بلا تكرار عند إعادة المراجعة، والبذور مزروعة', async () => {
  const sr = new SelfReview(deps())
  await sr.run({ notify: false })
  const n1 = (await listCases(db, { status: 'all' })).filter((c) => c.source === 'selfreview').length
  const again = await sr.run({ notify: false })
  const all = await listCases(db, { status: 'all', limit: 500 })
  assert.ok(n1 >= 3)
  assert.equal(again.casesSaved, 0)
  assert.equal(all.filter((c) => c.source === 'selfreview').length, n1)
  assert.equal(all.filter((c) => c.source === 'seed').length, SEED_CASES.length)
  const loop = all.find((c) => c.source === 'selfreview' && c.owner_message === 'نفّذ السكريبت هذا الحين')
  assert.ok(loop, 'حلقة السكربت محفوظة كحالة')
  assert.ok(loop!.expected.must_not?.includes('action:clarify'))
  assert.ok(loop!.context_turns.length > 0)
})

test('المجدول: قبل الوقت لا شيء، ٢٣:٤٠ مرة واحدة فقط، والإيقاف من الإعدادات يمنعه', async () => {
  const sr = new SelfReview(deps())
  clock = new Date('2026-10-05T19:00:00Z')   // 22:00 بالرياض
  assert.equal(await sr.tick(), null)
  clock = new Date('2026-10-05T20:40:00Z')
  assert.ok(await sr.tick())
  assert.equal(await sr.tick(), null, 'مطالبة اليوم أُخذت')
  assert.ok(claims.has(`${REVIEW_CLAIM_KEY}=2026-10-5`))
  claims.clear()
  await settings.update({ features: { self_review: false } })
  assert.equal(await sr.tick(), null)
  await settings.update({ features: { self_review: true }, self_review_at: '23:50' })
  assert.equal(await sr.tick(), null, '23:40 قبل الوقت الجديد')
  await settings.update({ self_review_at: '23:30' })
})

test('«هذا غلط، المفروض …» بعد رد سيئ ← حالة يدوية بتوقّعه', async () => {
  const sr = new SelfReview(deps())
  const recent = async () => [
    { role: 'user' as const, text: 'فين ألاقي زر syncseason في مشروع نجوم بلس؟' },
    { role: 'assistant' as const, text: 'دوّر على syncseason داخل مستودع نجوم بلس في GitHub، وغالباً تحت src/components' },
    { role: 'user' as const, text: 'هذا غلط، المفروض تخلي كلود يفتش الكود بدون بحث' },
  ]
  const reply = await sr.command('هذا غلط، المفروض تخلي كلود يفتش الكود بدون بحث', recent)
  assert.match(reply!, /📌 حفظتها حالة تقييم #/)
  const c = (await listCases(db, { status: 'all' })).find((x) => x.source === 'manual')!
  assert.equal(c.owner_message, 'فين ألاقي زر syncseason في مشروع نجوم بلس؟')
  assert.ok(c.expected.action_types?.includes('code_change'))
  assert.ok(c.expected.must_not?.includes('action:web_search'))
  assert.match(c.expected.bad_reply!, /src\/components/)
  assert.match(c.expected.notes!, /كلود/)
  assert.match((await sr.command('هذا غلط، المفروض تخلي كلود يفتش الكود بدون بحث', recent))!, /محفوظة من قبل/)
  assert.match((await sr.command('هذا غلط، المفروض كذا', async () => [{ role: 'user', text: 'هذا غلط، المفروض كذا' }]))!, /ما لقيت رداً سابقاً/)
  assert.equal(await sr.command('وش مهامي', recent), null)
})

test('«قارن النماذج» بلا المفتاحين ← رسالة واضحة بلا تشغيل', async () => {
  const sr = new SelfReview(deps({ env: { GEMINI_API_KEY: 'x' } as any }))
  assert.match((await sr.command('قارن النماذج', async () => []))!, /تحتاج مفتاحي NVIDIA و Gemini/)
})

test('لوحة التحكم: آخر المراجعات + حالات التقييم + نسبة رفض النموذج (قراءة فقط)', async () => {
  const snap = await selfReviewSnapshot(db, { now: clock })
  assert.ok(snap.reviews.length >= 1)
  assert.ok(Array.isArray(snap.reviews[0].items))
  assert.ok(snap.counts.cases >= SEED_CASES.length)
  assert.equal(snap.counts.by_source.seed, SEED_CASES.length)
  assert.ok(Array.isArray(snap.llm_rejections))
})

// ───── تكامل مع البوت الحقيقي: طلب الإصلاح لا يُنفَّذ إلا بـ "نعم N" ─────
test('البوت: المراجعة الليلية تنشئ طلب code_change على البوت — GitHub لا يُلمس قبل «نعم N»', async () => {
  const sent: string[] = []
  const gateway: GatewayClient = {
    async sendText(_f, _to, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued', eta_seconds: 1, fast_lane: true } },
    async getMessage(id) { return { id, status: 'sent' } as any },
  }
  const gh: string[] = []
  const github = {
    async dispatchWorkflow(repo: string, _wf: string, _ref: string, inputs: Record<string, string>) { gh.push(`dispatch ${repo} ${inputs.prompt.slice(0, 600)}`) },
    async listRuns() { return [] }, async findPrByBranch() { return null }, async getPr() { return null }, async prFiles() { return [] },
    async mergePr() {}, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
  } as unknown as GitHubClient
  llmMode = 'ok'
  const a = new Assistant({ cfg, store, llm: spyLlm, stt: { async transcribe() { return '' } }, gateway, github, projects: new ProjectRegistry([]), now: () => clock, settings })
  await a.tick()
  await a.idle()
  const review = sent.find((t) => t.startsWith('🪞 مراجعة اليوم'))
  assert.ok(review, `رسالة المراجعة: ${sent.join(' || ').slice(0, 300)}`)
  const open = (await store.openPending(clock)).filter((p) => p.kind === 'code_change' && p.payload.repo === profile().github.self_repo)
  assert.ok(open.length >= 1, 'طلب إصلاح معلّق')
  assert.equal(gh.length, 0, 'لا تنفيذ تلقائي')
  assert.ok(open[0].preview_sent_at, 'المعاينة مربوطة برسالة المراجعة')
  // "نعم" بلا رقم لا تكفي لطلب كود
  await a.process({ event: 'message', message_id: 'sr-1', from: OWNER, type: 'text', text: 'نعم', media: null, timestamp: Math.floor(clock.getTime() / 1000) + 60 } as any)
  await a.idle()
  assert.equal(gh.length, 0)
  await a.process({ event: 'message', message_id: 'sr-2', from: OWNER, type: 'text', text: `نعم ${open[0].short_no}`, media: null, timestamp: Math.floor(clock.getTime() / 1000) + 120 } as any)
  await a.idle()
  assert.equal(gh.length, 1, sent.at(-1) ?? '')
  assert.ok(gh[0].startsWith(`dispatch ${profile().github.self_repo} `), gh[0])
  assert.match(gh[0], /إصلاح تعثّر كشفته المراجعة الذاتية/)
})
