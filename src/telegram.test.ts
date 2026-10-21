/**
 * تيليجرام: ربط المالك برمز، تجاهل غيره، الصوت عبر getFile، التحويل التلقائي عند انقطاع واتساب،
 * أزرار مربوطة برقم الطلب، ورفض الويبهوك بسر خاطئ. Bot API مزيّف — لا شبكة.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant } from './assistant.js'
import { ProjectRegistry } from './projects.js'
import { buildServer } from './server.js'
import { TelegramBot, telegramSecrets } from './telegram/bot.js'
import { Watchdog } from './watchdog.js'
import { REAL_BAN_STATUS } from './test-fixtures.js'
import type { TelegramApi, TgUpdate, TgMessage } from './telegram/client.js'
import type { GatewayClient } from './clients/gateway.js'
import type { LlmClient, SttClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const OWNER_CHAT = 222
const CODE = 'link-code-7f3a9c'

const cfg = loadConfig({
  WEBHOOK_SECRET: 's', OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k',
  TZ: 'Asia/Riyadh', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_LINK_CODE: CODE,
} as any)

let clock = new Date('2026-10-12T08:00:00Z')
let uid = 0, mid = 0

// ───── Bot API مزيّف ─────
const tgSent: { chat: string; text: string; markup?: any }[] = []
const tgPhotos: { chat: string; caption: string }[] = []
const downloads: string[] = []
const tgActions: string[] = []
const tgEdits: { chat: string; id: number; text: string }[] = []
const api: TelegramApi = {
  async sendMessage(chat, text, markup) { tgSent.push({ chat: String(chat), text, markup }); return { message_id: ++mid, date: 0, chat: { id: +chat } } },
  async sendPhoto(chat, _png, caption) { tgPhotos.push({ chat: String(chat), caption }); return { message_id: ++mid, date: 0, chat: { id: +chat } } },
  async downloadFile(fileId) { downloads.push(fileId); return { base64: `B64:${fileId}`, path: 'voice/file.oga' } },
  async answerCallbackQuery() {},
  async sendChatAction(chat) { tgActions.push(String(chat)) },
  async editMessageText(chat, id, text) { tgEdits.push({ chat: String(chat), id, text }) },
  async editMessageReplyMarkup() {},
  async setWebhook() {},
  async deleteWebhook() {},
  async getUpdates() { return [] },
}

const waSent: { to: string; text: string }[] = []
const gateway: GatewayClient = {
  async sendText(_f, to, text) { waSent.push({ to, text }); return { id: `g${waSent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const ownerLlm: string[] = []
const llm: LlmClient = {
  async complete(system, user) {
    if (system.includes('رسالة من طرف ثالث')) {
      return JSON.stringify({ summary_ar: 'يسأل', intent: 'question', urgency: 'normal', suggested_replies: ['تمام', 'بعدين'] })
    }
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    ownerLlm.push(msg)
    if (msg === 'احفظ رقم فهد 0500003456') return JSON.stringify({ actions: [{ type: 'save_contact', name: 'فهد', phone: '0500003456' }], reply: '' })
    if (msg === 'احفظ رقم سعد 0500009888') return JSON.stringify({ actions: [{ type: 'save_contact', name: 'سعد', phone: '0500009888' }], reply: '' })
    return JSON.stringify({ actions: [], reply: `وصلت: ${msg}` })
  },
}
const sttSeen: string[] = []
const stt: SttClient = { async transcribe(b64) { sttSeen.push(b64); return 'مهامي' } }

let db: Db, store: Store, assistant: Assistant, bot: TelegramBot
const down = { isDown: false }

const msg = (chat: number, extra: Partial<TgMessage>): TgUpdate => ({
  update_id: ++uid,
  message: { message_id: ++mid, date: Math.floor(clock.getTime() / 1000) + uid, chat: { id: chat }, from: { id: chat, first_name: 'X' }, ...extra },
})
const send = async (u: TgUpdate) => { await bot.handleUpdate(u); await assistant.idle() }
const lastTg = () => tgSent.at(-1)!

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  await store.upsertContact('أحمد سالم', '0500003456')
  await store.upsertContact('أحمد الغامدي', '0500009888')
  assistant = new Assistant({ cfg, store, llm, stt, gateway, github: null, projects: new ProjectRegistry([]), now: () => clock })
  assistant.attachWatchdog(down)
  bot = new TelegramBot(cfg, api, store, assistant)
  await bot.init()
  assistant.attachTelegram(bot.channel())
})
after(async () => { await db.close() })
beforeEach(() => { tgSent.length = 0; waSent.length = 0; ownerLlm.length = 0 })

test('ربط المالك: رمز خاطئ يُتجاهل، "/start <الرمز>" يربط ويُحفظ، وأي محادثة أخرى تُتجاهل', async () => {
  assert.equal(bot.bound, false)
  await send(msg(111, { text: '/start wrong-code' }))
  await send(msg(111, { text: 'مهامي' }))
  assert.equal(bot.bound, false)
  assert.equal(tgSent.length, 0)
  assert.equal(ownerLlm.length, 0)

  await send(msg(OWNER_CHAT, { text: `/start ${CODE}` }))
  assert.equal(bot.ownerChat, String(OWNER_CHAT))
  assert.equal(await store.getKv('tg_owner_chat'), String(OWNER_CHAT))
  assert.match(lastTg().text, /تم ربطك/)

  // بعد الربط: محادثة ثالثة (حتى بنفس الرمز) لا تُسمع
  tgSent.length = 0
  await send(msg(333, { text: `/start ${CODE}` }))
  await send(msg(333, { text: 'قل لأحمد أي شي' }))
  assert.equal(tgSent.length, 0)
  assert.equal(ownerLlm.length, 0)

  // إعادة إقلاع: الربط محفوظ
  const again = new TelegramBot(cfg, api, store, assistant)
  await again.init()
  assert.equal(again.ownerChat, String(OWNER_CHAT))
})

test('المالك يكلّم البوت على تيليجرام: الرد يعود على تيليجرام لا واتساب', async () => {
  await send(msg(OWNER_CHAT, { text: 'هلا' }))
  assert.equal(waSent.length, 0)
  assert.equal(lastTg().chat, String(OWNER_CHAT))
  assert.match(lastTg().text, /وصلت: هلا/)
})

test('صوتية تيليجرام: getFile ← تنزيل ← تفريغ، والرد على تيليجرام', async () => {
  await send(msg(OWNER_CHAT, { voice: { file_id: 'VOICE-1', mime_type: 'audio/ogg', duration: 3 } }))
  assert.deepEqual(downloads.slice(-1), ['VOICE-1'])
  assert.deepEqual(sttSeen.slice(-1), ['B64:VOICE-1'])
  assert.match(lastTg().text, /^🎤 «مهامي»/)
  assert.equal(waSent.length, 0)
})

test('رسالة محوّلة على تيليجرام: اسم المرسل الأصلي يحدد الجهة، وأزرار الاقتراحات ← رابط wa.me', async () => {
  await send(msg(OWNER_CHAT, { text: 'متى تجي؟', forward_origin: { type: 'user', sender_user: { id: 9, first_name: 'أحمد', last_name: 'سالم' } } }))
  const m = lastTg()
  assert.match(m.text, /💬 أحمد سالم: «متى تجي؟»/)
  const buttons = m.markup.inline_keyboard.flat()
  const b1 = buttons.find((b: any) => b.text === '1')
  assert.match(b1.callback_data, /^r:\d+:1$/)
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: 'cq1', from: { id: OWNER_CHAT }, message: { message_id: 1, date: 0, chat: { id: OWNER_CHAT } }, data: b1.callback_data } })
  await assistant.idle()
  assert.ok(lastTg().text.includes('https://wa.me/966500003456?text=' + encodeURIComponent('تمام')))
  assert.equal(waSent.length, 0, 'لا شيء من رقم البوت')
})

test('أزرار الموافقة مربوطة برقم الطلب: ضغط زر الأول ينفّذ الأول فقط، والضغطة الثانية لا تكرر', async () => {
  await send(msg(OWNER_CHAT, { text: 'احفظ رقم فهد 0500003456' }))
  const first = lastTg().markup.inline_keyboard[0]
  const yes1 = first.find((b: any) => b.text.startsWith('✅')).callback_data
  await send(msg(OWNER_CHAT, { text: 'احفظ رقم سعد 0500009888' }))
  const second = lastTg().markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('✅')).callback_data
  assert.notEqual(yes1, second)
  assert.match(yes1, /^p:\d+:yes$/)

  // ضغطة من محادثة أخرى بنفس البيانات: تُتجاهل
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: 'x', from: { id: 333 }, message: { message_id: 1, date: 0, chat: { id: 333 } }, data: yes1 } })
  await assistant.idle()
  assert.equal((await store.contactByPhone('0500003456'))!.name, 'أحمد سالم')

  const press = async (data: string) => {
    await bot.handleUpdate({ update_id: ++uid, callback_query: { id: `cq${uid}`, from: { id: OWNER_CHAT }, message: { message_id: 1, date: 0, chat: { id: OWNER_CHAT } }, data } })
    await assistant.idle()
  }
  await press(yes1)
  assert.equal((await store.contactByPhone('0500003456'))!.name, 'فهد')
  assert.equal((await store.contactByPhone('0500009888'))!.name, 'أحمد الغامدي', 'الطلب الثاني لم يُمس')
  await press(yes1)
  assert.match(lastTg().text, /انحسم/)
  await press(second.replace(':yes', ':no'))
  assert.equal((await store.contactByPhone('0500009888'))!.name, 'أحمد الغامدي')
})

test('التحويل التلقائي: واتساب مقطوع ← التذكيرات تذهب لتيليجرام فوراً (بلا طابور)؛ متصل ← واتساب', async () => {
  await store.addTask({ title: 'تذكير أثناء الانقطاع', remind_at: new Date(clock.getTime() - 1000) })
  down.isDown = true
  await assistant.tick()
  assert.equal(waSent.length, 0)
  assert.ok(tgSent.some((m) => m.text.includes('⏰ تذكير: تذكير أثناء الانقطاع')))
  assert.equal((await store.claimOwnerOutbox(clock)).length, 0, 'لا شيء في الطابور المحلي')

  down.isDown = false
  tgSent.length = 0
  clock = new Date(clock.getTime() + 60_000)
  // القناة الأساسية واتساب صراحةً (auto = آخر قناة راسل منها المالك — هنا تيليجرام؛ انظر الاختبار التالي)
  await assistant.settings.update({ primary_channel: 'whatsapp' })
  await store.addTask({ title: 'تذكير والواتساب شغال', remind_at: new Date(clock.getTime() - 1000) })
  await assistant.tick()
  assert.ok(waSent.some((m) => m.to === OWNER && m.text.includes('تذكير والواتساب شغال')))
  assert.equal(tgSent.length, 0)
  await assistant.settings.update({ primary_channel: 'auto' })
})

test('القناة الأساسية (auto): المالك يراسل من تيليجرام ← التذكير يروح تيليجرام حتى وواتساب متصل', async () => {
  down.isDown = false
  await store.setKv('owner_last_channel', 'telegram')
  waSent.length = 0; tgSent.length = 0
  clock = new Date(clock.getTime() + 60_000)
  await store.addTask({ title: 'تذكير للقناة الأساسية', remind_at: new Date(clock.getTime() - 1000) })
  await assistant.tick()
  assert.ok(tgSent.some((m) => m.chat === String(OWNER_CHAT) && m.text.includes('تذكير للقناة الأساسية')))
  assert.ok(!waSent.some((m) => m.text.includes('تذكير للقناة الأساسية')))
})

test('فشل إرسال واتساب (متصل ظاهرياً) ← التذكير يصل عبر تيليجرام ولا يضيع', async () => {
  const orig = gateway.sendText
  gateway.sendText = async () => { throw new Error('gateway 502') }
  try {
    clock = new Date(clock.getTime() + 60_000)
    tgSent.length = 0
    await store.addTask({ title: 'تذكير وواتساب يفشل', remind_at: new Date(clock.getTime() - 1000) })
    await assistant.tick()
    assert.ok(tgSent.some((m) => m.text.includes('تذكير وواتساب يفشل')))
  } finally { gateway.sendText = orig }
})

test('الحارس + تيليجرام: تنبيه فوري بالسبب، حظر 403 برسالة واضحة، وQR كصورة', async () => {
  let payload: any = { status: 'disconnected', last_disconnect_reason: 'device_removed' }
  const gw: GatewayClient = {
    ...gateway,
    async getStatus() { return payload },
    async resume() {}, async relink() {}, async qrPng() { return Buffer.from('PNG') },
  }
  let t = clock.getTime()
  const wd = new Watchdog(cfg, gw, bot.alerter(), { async onRecovered() {} }, () => new Date(t))
  await wd.check()
  assert.match(lastTg().text, /⚠️ واتساب البوت انقطع\nالحالة: مقطوع \(device_removed\)/)

  // الحمولة الحقيقية من الوسيط لرقم محظور
  payload = REAL_BAN_STATUS
  t += 60_000
  await wd.check()
  assert.match(lastTg().text, /⛔ رقم البوت محظور من واتساب/)
  assert.match(lastTg().text, /تيليجرام الآن هو القناة الأساسية/)
  const n = tgSent.length
  t += 60_000
  await wd.check()
  assert.equal(tgSent.length, n, 'رسالة الحظر مرة واحدة')

  const wd2 = new Watchdog(cfg, { ...gw, async getStatus() { return { status: 'logged_out' } } }, bot.alerter(), { async onRecovered() {} }, () => new Date(t))
  await wd2.check()
  t += 3 * 60_000
  await wd2.check()
  assert.match(tgPhotos.at(-1)!.caption, /امسح هذا الرمز من جوال البوت/)
})

test('ويبهوك تيليجرام: سر أو مسار خاطئ ← 401، والصحيح ← 200 ويُعالج', async () => {
  const handled: any[] = []
  const s = telegramSecrets(cfg)
  assert.ok(s.path.length >= 32 && s.token.length >= 32 && !s.path.includes('123:abc'))
  const app = buildServer({ assistant, webhookSecret: 's', telegram: { path: s.path, secretToken: s.token, handle: async (u) => { handled.push(u) } } })
  const hit = (path: string, token?: string) => app.inject({
    method: 'POST', url: `/webhook/tg/${path}`, payload: JSON.stringify({ update_id: 1 }),
    headers: { 'content-type': 'application/json', ...(token !== undefined ? { 'x-telegram-bot-api-secret-token': token } : {}) },
  })
  assert.equal((await hit(s.path)).statusCode, 401)
  assert.equal((await hit(s.path, 'wrong')).statusCode, 401)
  assert.equal((await hit('wrong-path', s.token)).statusCode, 401)
  assert.equal(handled.length, 0)
  assert.equal((await hit(s.path, s.token)).statusCode, 200)
  assert.equal(handled.length, 1)
  await app.close()
})

// ───── لا قناة للمالك: ntfy بدل الطابور الصامت ─────

test('واتساب مقطوع وتيليجرام غير مربوط: التذكير يصل عبر ntfy؛ وبدون ntfy يُخزّن محلياً', async () => {
  const pushes: any[] = []
  const lonely = new Assistant({ cfg, store, llm, stt, gateway, github: null, projects: new ProjectRegistry([]), now: () => clock })
  lonely.attachWatchdog({ isDown: true })
  lonely.attachFallbackNotifier({ async send(m) { pushes.push(m) }, async sendImage() {} })
  clock = new Date(clock.getTime() + 5 * 60_000)
  await store.addTask({ title: 'تذكير عبر ntfy', remind_at: new Date(clock.getTime() - 1000) })
  await lonely.tick()
  assert.equal(waSent.length, 0)
  assert.equal(tgSent.length, 0)
  assert.ok(pushes.some((p) => p.message.includes('⏰ تذكير: تذكير عبر ntfy')))
  assert.equal((await store.claimOwnerOutbox(clock)).length, 0, 'لم يُخزّن بصمت')

  const noNtfy = new Assistant({ cfg, store, llm, stt, gateway, github: null, projects: new ProjectRegistry([]), now: () => clock })
  noNtfy.attachWatchdog({ isDown: true })
  clock = new Date(clock.getTime() + 60_000)
  await store.addTask({ title: 'تذكير بلا قنوات', remind_at: new Date(clock.getTime() - 1000) })
  await noNtfy.tick()
  const queued = await store.claimOwnerOutbox(clock)
  assert.ok(queued.some((q) => q.text.includes('تذكير بلا قنوات')))
})
