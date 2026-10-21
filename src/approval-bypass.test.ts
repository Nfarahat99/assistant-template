/**
 * حادثة حقيقية: البوت اقترح تعديلاً ← المالك "يلا" ← أُنشئ طلب الكود #8 ← وشُغّل بعد ٦ ثوانٍ بلا "نعم 8".
 * وقال البوت "تم، فتحت طلب كود" والطلب لم يُنفَّذ. هنا نمنع الاثنين.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, dispatchErrorAr, type InboundPayload } from './assistant.js'
import { ProjectRegistry } from './projects.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'
import type { OwnerChannel } from './channels.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

let clock = new Date('2026-10-20T08:00:00Z')
let db: Db, store: Store, a: Assistant
const sent: string[] = []
const dispatches: string[] = []
let failDispatch: Error | null = null
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const github: GitHubClient = {
  async dispatchWorkflow(repo) { if (failDispatch) throw failDispatch; dispatches.push(repo) },
  async listRuns() { return [] }, async findPrByBranch() { return null }, async getPr() { throw new Error('x') },
  async prFiles() { return [] }, async mergePr() {}, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
}
const script: Record<string, any> = {
  'الملخص الصباحي يجي متأخر': { actions: [{ type: 'answer', text: 'أقدر أجهز لك طلب تعديل على كودي يخلي الملخص ٧:٣٠ بالضبط. تبيه؟' }], reply: '' },
  // النموذج يدّعي التنفيذ في reply — لا يجب أن يصل للمالك
  'يلا': { actions: [{ type: 'code_change', project_query: 'البوت', request: 'اضبط الملخص الصباحي ٧:٣٠' }], reply: 'تم، فتحت طلب كود ✅' },
}
const llm: LlmClient = {
  async complete(_s, user) {
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: 'تمام' }], reply: '' })
  },
}
let seq = 0
const say = async (text: string, extra: Partial<InboundPayload> = {}) => {
  clock = new Date(clock.getTime() + 6_000)   // ٦ ثوانٍ بين الرسائل كما في الحادثة
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `B${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null, ...extra,
  } as InboundPayload)
  await a.idle()
}
const last = () => sent.at(-1) ?? ''

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects: new ProjectRegistry([]), now: () => clock })
})
after(async () => { await db.close() })

test('اقتراح البوت ← "يلا" ← طلب معلّق فقط، بلا تشغيل؛ والكلمات العابرة لا تشغّل كوداً أبداً', async () => {
  await say('الملخص الصباحي يجي متأخر')
  await say('يلا')
  const pend = await store.openPending(clock)
  assert.equal(pend.length, 1)
  assert.equal(pend[0].kind, 'code_change')
  assert.deepEqual(dispatches, [], 'شُغّل بدون "نعم N"!')

  // الصدق: لا "تم، فتحت طلب كود" — بل "جهزت الطلب، أنفذه؟"
  assert.doesNotMatch(last(), /تم، فتحت|فتحت طلب|شغّلته/)
  assert.match(last(), /جهزت الطلب \(ما نفّذته بعد\)/)
  assert.match(last(), new RegExp(`أنفّذه؟ رد: نعم ${pend[0].short_no}`))

  for (const w of ['يلا', 'تمام', 'اي', 'ok', '👍', '1', 'ارسل', 'نفذ']) {
    await say(w)
    assert.deepEqual(dispatches, [], `"${w}" شغّل الكود!`)
  }
  await say('نعم')   // طلب معلّق وحيد: «نعم» وحدها تكفي
  assert.deepEqual(dispatches, ['example-user/my-assistant'])
})

test('نفس الرسالة لا تُنشئ الطلب وتوافق عليه، والموافقة قبل إرسال المعاينة مرفوضة (حتى بالزر)', async () => {
  script['طوّر نفسك نعم 99'] = { actions: [{ type: 'code_change', project_query: 'البوت', request: 'x' }], reply: '' }
  await say('طوّر نفسك نعم 99')
  const [p] = await store.openPending(clock)
  // "نعم N" بوقت واتساب قبل إرسال المعاينة
  await say(`نعم ${p.short_no}`, { timestamp: Math.floor(p.created_at.getTime() / 1000) - 1 })
  assert.equal(dispatches.length, 1, 'رد أقدم من المعاينة اعتُمد')
  assert.match(last(), /ردك قبل ما توصلك معاينة الطلب/)

  // زر تيليجرام لطلب لم تُرسل معاينته
  await store.addPending('code_change', { folder: 'البوت', repo: 'example-user/my-assistant', branch: 'main', request: 'y' }, clock)
  const fresh = (await store.openPending(clock)).find((x) => x.payload.request === 'y')!
  const tg: OwnerChannel = { name: 'telegram', available: () => true, async send(t) { sent.push(t); return { id: 'tg:1', quoteKey: 'tg:1' } } }
  a.attachTelegram(tg)
  await a.onButton(`p:${fresh.id}:yes`)
  await a.idle()
  assert.equal(dispatches.length, 1)
  assert.match(last(), /ما وصلت بعد — ما اعتمدته/)
  await say(`لا ${p.short_no}`)
  await say(`لا ${fresh.short_no}`)
})

test('أخطاء التشغيل بعربي واضح (404 claude.yml)', async () => {
  assert.match(dispatchErrorAr(new Error('GitHub POST /repos/x/actions/workflows/claude.yml/dispatches → 404: Not Found'), 'claude.yml'), /ما لقيت ملف claude\.yml في المستودع .*HTTP 404/)
  assert.match(dispatchErrorAr(new Error('GitHub POST … → 403: Resource not accessible'), 'claude.yml'), /صلاحية Actions/)
  failDispatch = new Error('GitHub POST /repos/example-user/my-assistant/actions/workflows/claude.yml/dispatches → 404: Not Found')
  script['طوّر نفسك: شي'] = { actions: [{ type: 'code_change', project_query: 'البوت', request: 'شي' }], reply: '' }
  await say('طوّر نفسك: شي')
  const p = (await store.openPending(clock)).at(-1)!
  await say(`نعم ${p.short_no}`)
  assert.match(last(), /❌ ما قدرت أشغّل الطلب على example-user\/my-assistant: ما لقيت ملف claude\.yml/)
  failDispatch = null
})

test('رد (Reply) بـ "نعم" على رسالة معاينة الطلب ينفّذه بلا رقم؛ وبلا اقتباس يبقى الرقم مطلوباً', async () => {
  script['طوّر نفسك: بالاقتباس'] = { actions: [{ type: 'code_change', project_query: 'البوت', request: 'بالاقتباس' }], reply: '' }
  await say('طوّر نفسك: بالاقتباس')
  const p = (await store.openPending(clock)).at(-1)!
  await store.setPreviewWaId(p.id, 'WA-PREVIEW-1')
  const before = dispatches.length
  await say('نعم', { quoted_message_id: 'WA-OTHER' })
  assert.equal(dispatches.length, before, 'اقتباس رسالة أخرى شغّل الكود')
  await say('نعم', { quoted_message_id: 'WA-PREVIEW-1' })
  assert.equal(dispatches.length, before + 1)
})
