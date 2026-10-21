/**
 * ربط واتساب من اللوحة: عميل التسجيل (§G3/§G5) + مسارات /api/dash/wa/link مع وسيط مزيّف حقيقي (Fastify على منفذ عشوائي).
 * أرقام وأسماء خيالية فقط.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadConfig } from '../config.js'
import { createDb, type Db } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { Store } from '../store.js'
import { Settings } from '../settings.js'
import { ProjectRegistry } from '../projects.js'
import { buildServer } from '../server.js'
import { assistantName } from '../profile.js'
import { provisionClient, numberClient, ProvisionError, linkStatusMessage } from './provision.js'
import { loadWaLink, saveWaLink, applyWaLink, overlayWaLink } from './link-store.js'

const PROVISION_KEY = 'wm_prov_fake_0000'
const NUMBER_KEY = 'wm_num_secret_9f8e7d6c'
const ASSISTANT = '966500000011'
const OWNER = '966500000012'
const SECRETS = randomBytes(32).toString('hex')
const WEBHOOK_SECRET = 'whsec-0123456789abcdef'

// ───── الوسيط المزيّف ─────
type Call = { method: string; url: string; auth?: string; body: any }
const gw = {
  calls: [] as Call[],
  provision: { code: 201, body: null as any },
  webhookCode: 200,
  deleteBody: { ok: true, session_id: 'sess-1', logged_out: true } as any,
  deleteCode: 200,
  status: { status: 'qr', last_disconnect_reason: null as string | null },
  qrJson: true,
  relinkCode: 200,
  statusCode: 200,
  statusDelayMs: 0,
  qrCode: 200,
}
const PNG = Buffer.from('FAKEPNG')
function resetGw() {
  gw.calls = []
  gw.provision = { code: 201, body: { session_id: 'sess-1', phone: ASSISTANT, mode: 'sender', status: 'connecting', api_key: NUMBER_KEY, api_key_prefix: 'wm_9f8e7d6c', warning: 'احفظه الآن', next: {} } }
  gw.webhookCode = 200
  gw.deleteBody = { ok: true, session_id: 'sess-1', logged_out: true }
  gw.deleteCode = 200
  gw.status = { status: 'qr', last_disconnect_reason: null }
  gw.qrJson = true
  gw.relinkCode = 200
  gw.statusCode = 200
  gw.statusDelayMs = 0
  gw.qrCode = 200
}
let fake: FastifyInstance
let gwUrl = ''
let deadUrl = ''

function startFake() {
  const f = Fastify()
  f.addHook('onRequest', async (req) => { gw.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: undefined }) })
  f.addHook('preHandler', async (req) => { gw.calls[gw.calls.length - 1].body = req.body })
  f.post('/api/v1/numbers', async (_req, reply) => reply.code(gw.provision.code).send(gw.provision.body))
  f.delete('/api/v1/numbers/:id', async (_req, reply) => reply.code(gw.deleteCode).send(gw.deleteBody))
  f.put('/api/v1/webhook', async (_req, reply) => reply.code(gw.webhookCode).send(gw.webhookCode < 300 ? { ok: true } : { error: 'url must be https' }))
  f.get('/api/v1/status', async (_req, reply) => {
    if (gw.statusDelayMs) await new Promise((r) => setTimeout(r, gw.statusDelayMs))
    if (gw.statusCode !== 200) return reply.code(gw.statusCode).send({ error: 'invalid api key' })
    return { connected: gw.status.status === 'connected', ...gw.status }
  })
  f.get('/api/v1/session/qr', async (_req, reply) => gw.qrCode !== 200 ? reply.code(gw.qrCode).send({ error: 'no qr' }) : gw.qrJson
    ? { status: 'qr', qr_png_base64: PNG.toString('base64'), expires_hint_s: 20 }
    : reply.type('image/png').send(PNG))
  f.post('/api/v1/session/relink', async (_req, reply) => reply.code(gw.relinkCode).send({ ok: gw.relinkCode < 300 }))
  f.post('/api/v1/messages', async (_req, reply) => reply.code(202).send({ id: 'm1', status: 'queued' }))
  return f
}

// ───── تطبيق المساعد ─────
let db: Db
let store: Store
const exits: number[] = []
const PASSWORD = 'pw-accounts-test'

function makeApp(env: Record<string, string>, waLink: Record<string, unknown> = {}) {
  const cfg = loadConfig({ TZ: 'Asia/Riyadh', PROJECTS_FILE: './projects.json', ...env } as any)
  const settings = new Settings(cfg, store)
  const app = buildServer({
    assistant: {} as any, webhookSecret: 'x',
    dashboard: {
      password: PASSWORD, db, store, cfg, settings, projects: new ProjectRegistry([]),
      waLink: { exit: (c) => { exits.push(c) }, restartDelayMs: 0, ...waLink },
    },
  })
  return { app, cfg, settings }
}
const fullEnv = () => ({ GATEWAY_URL: gwUrl, GATEWAY_PROVISION_KEY: PROVISION_KEY, SECRETS_KEY: SECRETS, PUBLIC_URL: 'https://bot.example.test', WEBHOOK_SECRET })

async function login(app: ReturnType<typeof buildServer>) {
  const r = await app.inject({ method: 'POST', url: '/api/dash/login', headers: { 'x-requested-with': 'dash', 'content-type': 'application/json' }, payload: JSON.stringify({ password: PASSWORD }) })
  return String(r.headers['set-cookie']).split(';')[0]
}
function caller(app: ReturnType<typeof buildServer>, cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie, 'x-requested-with': 'dash' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = await app.inject({ method: method as any, url, headers, payload: body !== undefined ? JSON.stringify(body) : undefined })
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r.body }
  }
}
const tick = () => new Promise((r) => setTimeout(r, 20))

before(async () => {
  fake = startFake()
  gwUrl = await fake.listen({ port: 0, host: '127.0.0.1' })
  const dead = Fastify()
  deadUrl = await dead.listen({ port: 0, host: '127.0.0.1' })
  await dead.close()
  db = await createDb({ pgliteDir: 'memory://' } as any)
  await migrate(db)
  store = new Store(db)
})
after(async () => { await fake.close(); await db.close() })
beforeEach(async () => {
  resetGw()
  exits.length = 0
  await store.delKv('wa_link')
  await store.delKv('wa_link_welcomed')
})

// ───── العميل ─────
test('provisionNumber: شكل §G3 بالضبط ويرجع id/apiKey', async () => {
  const r = await provisionClient(gwUrl, PROVISION_KEY).provisionNumber(ASSISTANT, 'سراج', { url: 'https://bot.example.test/webhook/wa', secret: WEBHOOK_SECRET })
  assert.deepEqual(r, { id: 'sess-1', apiKey: NUMBER_KEY, phone: ASSISTANT })
  const c = gw.calls.find((x) => x.method === 'POST' && x.url === '/api/v1/numbers')!
  assert.equal(c.auth, `Bearer ${PROVISION_KEY}`)
  assert.deepEqual(c.body, { phone: ASSISTANT, name: 'سراج', mode: 'sender', pairing: 'qr', webhook: { url: 'https://bot.example.test/webhook/wa', secret: WEBHOOK_SECRET } })
})

test('provisionNumber: تحويل الأخطاء (400/401/403 limit/403/409/429/500/unreachable)', async () => {
  const pc = provisionClient(gwUrl, PROVISION_KEY)
  const expectCode = async (code: number, body: any, want: string, msg?: RegExp) => {
    gw.provision = { code, body }
    await assert.rejects(pc.provisionNumber(ASSISTANT, 'سراج'), (e: any) => {
      assert.ok(e instanceof ProvisionError); assert.equal(e.code, want)
      if (msg) assert.match(e.message, msg)
      assert.ok(!e.message.includes(PROVISION_KEY))
      return true
    })
  }
  await expectCode(400, { error: 'invalid phone' }, 'bad_request', /رقم/)
  await expectCode(401, { error: 'bad key' }, 'unauthorized', /GATEWAY_PROVISION_KEY/)
  await expectCode(403, { error: 'limit reached', limit: 1, mode: 'sender' }, 'limit', /حد الأرقام/)
  await expectCode(403, { error: 'forbidden' }, 'unauthorized')
  await expectCode(409, { error: 'exists', session_id: 'old' }, 'conflict', /مسجّل عند الوسيط مسبقاً — كلّم صاحب الوسيط/)
  await expectCode(409, { error: 'exists' }, 'conflict', /حساب ثاني/)
  await expectCode(429, { error: 'slow down' }, 'rate_limited')
  await expectCode(500, {}, 'unknown', /500/)
  await assert.rejects(provisionClient(deadUrl, PROVISION_KEY).provisionNumber(ASSISTANT, 'سراج'), (e: any) => e instanceof ProvisionError && e.code === 'unreachable')
})

test('deleteNumber: logged_out من الرد؛ 404 = not_found', async () => {
  const pc = provisionClient(gwUrl, PROVISION_KEY)
  assert.deepEqual(await pc.deleteNumber('sess-1'), { loggedOut: true })
  gw.deleteBody = { ok: true, session_id: 'sess-1', logged_out: false }
  assert.deepEqual(await pc.deleteNumber('sess-1'), { loggedOut: false })
  gw.deleteCode = 404; gw.deleteBody = { error: 'not found' }
  await assert.rejects(pc.deleteNumber('sess-1'), (e: any) => e.code === 'not_found')
})

test('numberClient: الويبهوك بمفتاح الرقم + trusted_numbers؛ QR من JSON أو PNG خام', async () => {
  const nc = numberClient(gwUrl, NUMBER_KEY)
  await nc.setWebhook('https://bot.example.test/webhook/wa', WEBHOOK_SECRET, [OWNER])
  const c = gw.calls.find((x) => x.url === '/api/v1/webhook')!
  assert.equal(c.method, 'PUT'); assert.equal(c.auth, `Bearer ${NUMBER_KEY}`)
  assert.deepEqual(c.body, { url: 'https://bot.example.test/webhook/wa', secret: WEBHOOK_SECRET, trusted_numbers: [OWNER] })
  assert.deepEqual(await nc.qrPng(ASSISTANT), PNG)
  gw.qrJson = false
  assert.deepEqual(await nc.qrPng(ASSISTANT), PNG)
  gw.webhookCode = 400
  await assert.rejects(nc.setWebhook('http://x', 'short', []), (e: any) => e.code === 'bad_request' && /https/.test(e.message))
})

test('linkStatusMessage: phone_mismatch وqr_timeout بالعربي', () => {
  assert.match(linkStatusMessage({ status: 'logged_out', last_disconnect_reason: 'phone_mismatch' })!, /بجوال غير رقم المساعد/)
  assert.match(linkStatusMessage({ status: 'disconnected', last_disconnect_reason: 'qr_timeout' })!, /انتهت مهلة الرمز/)
  assert.equal(linkStatusMessage({ status: 'qr' }), null)
})

// ───── المسارات ─────
test('routes: بلا جلسة ← 401 لكل مسارات الربط', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  for (const [m, u] of [['GET', '/api/dash/wa/link'], ['POST', '/api/dash/wa/link'], ['GET', '/api/dash/wa/link/qr'], ['GET', '/api/dash/wa/link/status'], ['DELETE', '/api/dash/wa/link']]) {
    const r = await app.inject({ method: m as any, url: u, headers: { 'x-requested-with': 'dash' } })
    assert.equal(r.statusCode, 401, `${m} ${u}`)
  }
  assert.equal(gw.calls.length, 0)
  await app.close()
})

test('routes: available=false مع السبب لكل إعداد ناقص', async () => {
  const cases: [Record<string, string>, string][] = [
    [{ ...fullEnv(), GATEWAY_URL: '' }, 'no_gateway'],
    [{ ...fullEnv(), GATEWAY_PROVISION_KEY: '' }, 'no_provision_key'],
    [{ ...fullEnv(), SECRETS_KEY: '' }, 'no_secrets_key'],
    [{ ...fullEnv(), SECRETS_KEY: 'abc' }, 'no_secrets_key'],
    [{ ...fullEnv(), PUBLIC_URL: '' }, 'no_public_url'],
    [{ ...fullEnv(), WEBHOOK_SECRET: '' }, 'no_webhook_secret'],
    [{ ...fullEnv(), WEBHOOK_SECRET: 'short' }, 'no_webhook_secret'],
  ]
  for (const [env, reason] of cases) {
    const { app } = makeApp(env); await app.ready()
    const call = caller(app, await login(app))
    const g = await call('GET', '/api/dash/wa/link')
    assert.equal(g.status, 200)
    assert.equal(g.body.available, false, reason)
    assert.equal(g.body.reason, reason)
    assert.equal(g.body.linked, false)
    const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
    assert.equal(p.status, 409)
    assert.equal(p.body.reason, reason)
    await app.close()
  }
  const { app } = makeApp(fullEnv()); await app.ready()
  const g = await caller(app, await login(app))('GET', '/api/dash/wa/link')
  assert.deepEqual({ available: g.body.available, linked: g.body.linked }, { available: true, linked: false })
  await app.close()
  assert.equal(gw.calls.length, 0)
})

test('routes: المسار السعيد — تسجيل ← ويبهوك ← QR ← connected ← ترحيب ← exit مرة واحدة', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))

  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '٠٥٠٠٠٠٠٠١١', ownerPhone: '+966 50 000 0012', acceptRisk: true })
  assert.equal(p.status, 201)
  assert.deepEqual(p.body, { ok: true, numberId: 'sess-1' })
  assert.ok(!p.raw.includes(NUMBER_KEY))
  const prov = gw.calls.find((c) => c.url === '/api/v1/numbers')!
  assert.equal(prov.body.phone, ASSISTANT)
  assert.equal(prov.body.name, assistantName())
  const wh = gw.calls.find((c) => c.url === '/api/v1/webhook')!
  assert.equal(wh.auth, `Bearer ${NUMBER_KEY}`)
  assert.deepEqual(wh.body, { url: 'https://bot.example.test/webhook/wa', secret: WEBHOOK_SECRET, trusted_numbers: [OWNER] })

  // محفوظ مشفّراً
  const raw = (await store.getKv('wa_link'))!
  assert.ok(!raw.includes(NUMBER_KEY))
  const saved = await loadWaLink(store, SECRETS)
  assert.ok(saved.ok)
  assert.equal(saved.ok && saved.link.apiKey, NUMBER_KEY)
  assert.equal(saved.ok && saved.link.numberId, 'sess-1')

  const g = await call('GET', '/api/dash/wa/link')
  assert.equal(g.body.linked, true); assert.equal(g.body.status, 'qr'); assert.equal(g.body.assistantPhone, ASSISTANT)
  assert.ok(!g.raw.includes(NUMBER_KEY))

  const q = await call('GET', '/api/dash/wa/link/qr')
  assert.equal(q.status, 200)
  assert.equal(q.body.qr_png_base64, PNG.toString('base64'))

  const s1 = await call('GET', '/api/dash/wa/link/status')
  assert.deepEqual(s1.body, { status: 'qr', reason: null, message: null })
  assert.equal(exits.length, 0)

  gw.status = { status: 'connected', last_disconnect_reason: null }
  const s2 = await call('GET', '/api/dash/wa/link/status')
  assert.deepEqual(s2.body, { status: 'connected', restarting: true, message: null })
  const s3 = await call('GET', '/api/dash/wa/link/status')
  assert.equal(s3.body.restarting, true)
  await tick()
  assert.deepEqual(exits, [75])
  const welcome = gw.calls.filter((c) => c.url === '/api/v1/messages')
  assert.equal(welcome.length, 1, 'الترحيب مرة واحدة')
  assert.equal(welcome[0].auth, `Bearer ${NUMBER_KEY}`)
  assert.deepEqual({ from: welcome[0].body.from, to: welcome[0].body.to }, { from: ASSISTANT, to: OWNER })
  assert.equal(welcome[0].body.text, `تم ربط واتساب ✅ — أنا ${assistantName()}`)
  await app.close()
})

test('routes: بعد إعادة التشغيل (الربط مطبّق) connected لا يعيد التشغيل ولا يكرر الترحيب', async () => {
  const first = makeApp(fullEnv()); await first.app.ready()
  const c1 = caller(first.app, await login(first.app))
  await c1('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  gw.status = { status: 'connected', last_disconnect_reason: null }
  await c1('GET', '/api/dash/wa/link/status')
  await tick()
  await first.app.close()
  assert.deepEqual(exits, [75])

  // "الإقلاع الجديد": الربط مطبّق على الإعدادات
  const second = makeApp({ ...fullEnv(), GATEWAY_API_KEY: '' })
  const wl = await loadWaLink(store, SECRETS)
  assert.ok(wl.ok)
  if (wl.ok) applyWaLink(second.cfg, wl.link)
  assert.equal(second.cfg.whatsappEnabled, true)
  await second.app.ready()
  const c2 = caller(second.app, await login(second.app))
  const s = await c2('GET', '/api/dash/wa/link/status')
  assert.deepEqual(s.body, { status: 'connected', restarting: false, message: null })
  const g = await c2('GET', '/api/dash/wa/link')
  assert.equal(g.body.active, true)
  await tick()
  assert.deepEqual(exits, [75])
  assert.equal(gw.calls.filter((c) => c.url === '/api/v1/messages').length, 1)
  await second.app.close()
})

test('connectedAt: ربط حُفظ وتُرك قبل المسح ← لا يُطبَّق عند الإقلاع واللوحة تعرضه معلّقاً؛ أول connected يحفظ connectedAt قبل إعادة التشغيل', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  let wl = await loadWaLink(store, SECRETS)
  assert.ok(wl.ok && !wl.link.connectedAt)
  // «إعادة تشغيل» قبل المسح: الربط المعلّق لا يفعّل واتساب
  const boot1 = loadConfig({ TZ: 'Asia/Riyadh', ...fullEnv() } as any)
  await overlayWaLink(store, boot1, () => {})
  assert.equal(boot1.whatsappEnabled, false)
  // حتى لو الوسيط يقول connected (مسح بلا استطلاع): اللوحة تعرضه معلّقاً ← شاشة الرمز تكمل الربط
  gw.status = { status: 'connected', last_disconnect_reason: null }
  const g = await call('GET', '/api/dash/wa/link')
  assert.equal(g.body.linked, true); assert.equal(g.body.pending, true); assert.equal(g.body.active, false)
  assert.equal(exits.length, 0)

  let savedBeforeRestart: boolean | null = null
  const second = makeApp(fullEnv(), { restart: async () => { const r = await loadWaLink(store, SECRETS); savedBeforeRestart = r.ok && !!r.link.connectedAt } })
  await second.app.ready()
  const c2 = caller(second.app, await login(second.app))
  const s = await c2('GET', '/api/dash/wa/link/status')
  assert.deepEqual(s.body, { status: 'connected', restarting: true, message: null })
  wl = await loadWaLink(store, SECRETS)
  assert.ok(wl.ok && wl.link.connectedAt, 'connectedAt محفوظ')
  assert.equal(wl.ok && wl.link.apiKey, NUMBER_KEY)
  await tick()
  assert.equal(savedBeforeRestart, true)
  const g2 = await c2('GET', '/api/dash/wa/link')
  assert.equal(g2.body.pending, false)
  const boot2 = loadConfig({ TZ: 'Asia/Riyadh', ...fullEnv() } as any)
  await overlayWaLink(store, boot2, () => {})
  assert.equal(boot2.whatsappEnabled, true)
  await app.close(); await second.app.close()
})

test('routes: تسجيل 401 ← unauthorized (502) بلا كتابة في kv', async () => {
  gw.provision = { code: 401, body: { error: 'bad key' } }
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 502) // ليس 401 حتى لا تُطرد الجلسة في الواجهة
  assert.equal(p.body.code, 'unauthorized')
  assert.match(p.body.error, /GATEWAY_PROVISION_KEY/)
  assert.equal(await store.getKv('wa_link'), null)
  assert.ok(!gw.calls.some((c) => c.url === '/api/v1/webhook'))
  await app.close()
})

test('routes: فشل الويبهوك ← حذف الرقم (rollback) بمفتاح التسجيل، بلا كتابة في kv', async () => {
  gw.webhookCode = 400
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 400)
  assert.equal(p.body.code, 'bad_request')
  const del = gw.calls.find((c) => c.method === 'DELETE')!
  assert.equal(del.url, '/api/v1/numbers/sess-1')
  assert.equal(del.auth, `Bearer ${PROVISION_KEY}`)
  assert.equal(await store.getKv('wa_link'), null)
  assert.ok(!p.raw.includes(NUMBER_KEY))
  await app.close()
})

test('routes: 409 (نفس المستأجر) و403 limit و429 والوسيط لا يستجيب', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  const body = { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true }
  gw.provision = { code: 409, body: { error: 'exists', session_id: 'old' } }
  let p = await call('POST', '/api/dash/wa/link', body)
  assert.equal(p.status, 409); assert.equal(p.body.code, 'conflict'); assert.match(p.body.error, /مسجّل عند الوسيط مسبقاً — كلّم صاحب الوسيط/)
  gw.provision = { code: 403, body: { error: 'limit', limit: 1, mode: 'sender' } }
  p = await call('POST', '/api/dash/wa/link', body)
  assert.equal(p.status, 409); assert.equal(p.body.code, 'limit')
  gw.provision = { code: 429, body: {} }
  p = await call('POST', '/api/dash/wa/link', body)
  assert.equal(p.status, 429); assert.equal(p.body.code, 'rate_limited')
  assert.equal(await store.getKv('wa_link'), null)
  await app.close()

  const dead = makeApp({ ...fullEnv(), GATEWAY_URL: deadUrl }); await dead.app.ready()
  p = await caller(dead.app, await login(dead.app))('POST', '/api/dash/wa/link', body)
  assert.equal(p.status, 502); assert.equal(p.body.code, 'unreachable'); assert.match(p.body.error, /ما قدرت أوصل للوسيط/)
  assert.equal(await store.getKv('wa_link'), null)
  await dead.app.close()
})

test('routes: تحقق المدخلات — رقم غير سعودي، نفس الرقمين، بلا موافقة على الخطر', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  let p = await call('POST', '/api/dash/wa/link', { assistantPhone: '12345', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 400); assert.match(p.body.error, /رقم المساعد/)
  p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000011', acceptRisk: true })
  assert.equal(p.status, 400); assert.match(p.body.error, /يختلف/)
  p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012' })
  assert.equal(p.status, 400); assert.match(p.body.error, /تحذير الحظر/)
  assert.equal(gw.calls.length, 0)
  await app.close()
})

test('routes: ربط قائم ← 409 «فكّه أول»؛ واتساب من البيئة ← 409', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-01T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000013', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 409); assert.match(p.body.error, /فكّه أول/)
  await app.close()
  await store.delKv('wa_link')

  const env = makeApp({ ...fullEnv(), GATEWAY_API_KEY: 'wm_env', ASSISTANT_PHONE: ASSISTANT, OWNER_PHONE: OWNER }); await env.app.ready()
  const c2 = caller(env.app, await login(env.app))
  const g = await c2('GET', '/api/dash/wa/link')
  assert.equal(g.body.linked, true); assert.equal(g.body.source, 'env')
  const p2 = await c2('POST', '/api/dash/wa/link', { assistantPhone: '0500000013', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p2.status, 409); assert.match(p2.body.error, /متغيرات البيئة/)
  assert.equal(gw.calls.length, 0)
  await env.app.close()
})

test('routes: الحالة phone_mismatch/qr_timeout برسالة عربية + relink', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-01T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  gw.status = { status: 'logged_out', last_disconnect_reason: 'phone_mismatch' }
  let s = await call('GET', '/api/dash/wa/link/status')
  assert.equal(s.body.reason, 'phone_mismatch'); assert.match(s.body.message, /بجوال غير رقم المساعد/)
  gw.status = { status: 'disconnected', last_disconnect_reason: 'qr_timeout' }
  s = await call('GET', '/api/dash/wa/link/status')
  assert.match(s.body.message, /انتهت مهلة الرمز/)
  const r = await call('POST', '/api/dash/wa/link/relink')
  assert.deepEqual(r.body, { ok: true })
  assert.equal(gw.calls.find((c) => c.url === '/api/v1/session/relink')!.auth, `Bearer ${NUMBER_KEY}`)
  gw.relinkCode = 429
  const r2 = await call('POST', '/api/dash/wa/link/relink')
  assert.equal(r2.status, 429)
  assert.equal(exits.length, 0)
  await app.close()
})

test('routes: بلا ربط ← QR/الحالة/فك الربط 404', async () => {
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  assert.equal((await call('GET', '/api/dash/wa/link/qr')).status, 404)
  assert.equal((await call('GET', '/api/dash/wa/link/status')).status, 404)
  assert.equal((await call('DELETE', '/api/dash/wa/link')).status, 404)
  await app.close()
})

test('routes: فك الربط ← حذف من الوسيط + مسح kv + إعادة تشغيل؛ logged_out=false ← رسالة يدوية', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-01T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app, cfg } = makeApp(fullEnv())
  cfg.gatewayApiKey = NUMBER_KEY; cfg.assistantPhone = ASSISTANT; cfg.whatsappEnabled = true
  await app.ready()
  const call = caller(app, await login(app))
  gw.deleteBody = { ok: true, session_id: 'sess-1', logged_out: false }
  const d = await call('DELETE', '/api/dash/wa/link')
  assert.equal(d.status, 200)
  assert.equal(d.body.logged_out, false); assert.equal(d.body.restarting, true)
  assert.match(d.body.message, /الأجهزة المرتبطة/)
  const del = gw.calls.find((c) => c.method === 'DELETE')!
  assert.equal(del.url, '/api/v1/numbers/sess-1'); assert.equal(del.auth, `Bearer ${PROVISION_KEY}`)
  assert.equal(await store.getKv('wa_link'), null)
  await tick()
  assert.deepEqual(exits, [75])
  await app.close()
})

test('routes: فك الربط — الوسيط لا يستجيب ← لا مسح؛ 404 من الوسيط ← نكمل المسح', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-01T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const dead = makeApp({ ...fullEnv(), GATEWAY_URL: deadUrl }); await dead.app.ready()
  const d1 = await caller(dead.app, await login(dead.app))('DELETE', '/api/dash/wa/link')
  assert.equal(d1.status, 502)
  assert.ok(await store.getKv('wa_link'))
  await dead.app.close()

  const { app } = makeApp(fullEnv()); await app.ready()
  gw.deleteCode = 404; gw.deleteBody = { error: 'not found' }
  const d2 = await caller(app, await login(app))('DELETE', '/api/dash/wa/link')
  assert.equal(d2.status, 200)
  assert.equal(d2.body.restarting, false) // العملية الحالية لا تستخدم الربط
  assert.equal(await store.getKv('wa_link'), null)
  await tick()
  assert.deepEqual(exits, [])
  await app.close()
})

test('routes: SECRETS_KEY تغيّر ← linked+locked، وفك الربط يعمل بلا فك تشفير', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-01T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp({ ...fullEnv(), SECRETS_KEY: randomBytes(32).toString('hex') }); await app.ready()
  const call = caller(app, await login(app))
  const g = await call('GET', '/api/dash/wa/link')
  assert.equal(g.body.linked, true); assert.equal(g.body.locked, true)
  assert.equal((await call('GET', '/api/dash/wa/link/qr')).status, 409)
  const d = await call('DELETE', '/api/dash/wa/link')
  assert.equal(d.status, 200)
  assert.equal(await store.getKv('wa_link'), null)
  await app.close()
})

// ───── جولة الإصلاح 1 ─────
test('fix1: OWNER_PHONE من البيئة يغلب رقم النموذج (الربط والويبهوك والترحيب) + الواجهة تعرضه للقراءة', async () => {
  const { app } = makeApp({ ...fullEnv(), OWNER_PHONE: '966500000099' }); await app.ready()
  const call = caller(app, await login(app))
  const g = await call('GET', '/api/dash/wa/link')
  assert.equal(g.body.ownerFromEnv, true)
  assert.equal(g.body.defaults.ownerPhone, '966500000099')
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 201)
  const saved = await loadWaLink(store, SECRETS)
  assert.equal(saved.ok && saved.link.ownerPhone, '966500000099')
  assert.deepEqual(gw.calls.find((c) => c.url === '/api/v1/webhook')!.body.trusted_numbers, ['966500000099'])
  gw.status = { status: 'connected', last_disconnect_reason: null }
  await call('GET', '/api/dash/wa/link/status')
  const w = gw.calls.filter((c) => c.url === '/api/v1/messages')
  assert.equal(w.length, 1)
  assert.equal(w[0].body.to, '966500000099')
  await tick() // مؤقت إعادة التشغيل لا يتسرّب للاختبار التالي
  await app.close()
})

test('fix1: OWNER_PHONE من البيئة — النموذج بلا ownerPhone يكفي', async () => {
  const { app } = makeApp({ ...fullEnv(), OWNER_PHONE: '966500000099' }); await app.ready()
  const p = await caller(app, await login(app))('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', acceptRisk: true })
  assert.equal(p.status, 201)
  await app.close()
})

test('fix1: ASSISTANT_PHONE من البيئة ← غير متاح + POST 409 بالعربي، بلا اتصال بالوسيط', async () => {
  const { app } = makeApp({ ...fullEnv(), ASSISTANT_PHONE: '966500000011' }); await app.ready()
  const call = caller(app, await login(app))
  const g = await call('GET', '/api/dash/wa/link')
  assert.equal(g.body.available, false)
  assert.ok(g.body.missing.includes('env_assistant_phone'))
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 409)
  assert.equal(p.body.reason, 'env_assistant_phone')
  assert.match(p.body.error, /ASSISTANT_PHONE/)
  assert.equal(gw.calls.length, 0)
  await app.close()
})

test('fix1: قيم ملأها ربط اللوحة عند الإقلاع ليست «من البيئة»', async () => {
  const { app, cfg } = makeApp(fullEnv())
  applyWaLink(cfg, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: 'old', linkedAt: 'x' })
  await app.ready()
  const g = await caller(app, await login(app))('GET', '/api/dash/wa/link')
  assert.equal(g.body.available, true) // assistantPhone من الربط القديم، لا من البيئة
  assert.equal(g.body.ownerFromEnv, undefined)
  await app.close()
})

test('fix1: الترحيب للمالك الفعلي عبر الحارس (البيئة تغلب رقم الربط)', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: '966500000077', apiKey: NUMBER_KEY, linkedAt: '2026-10-02T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp({ ...fullEnv(), OWNER_PHONE: OWNER }); await app.ready()
  gw.status = { status: 'connected', last_disconnect_reason: null }
  await caller(app, await login(app))('GET', '/api/dash/wa/link/status')
  const w = gw.calls.filter((c) => c.url === '/api/v1/messages')
  assert.equal(w.length, 1)
  assert.equal(w[0].body.to, OWNER)
  await tick()
  await app.close()
})

test('fix1: استطلاعات متزامنة عند connected ← ترحيب واحد فقط', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-03T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  gw.status = { status: 'connected', last_disconnect_reason: null }
  const rs = await Promise.all([call('GET', '/api/dash/wa/link/status'), call('GET', '/api/dash/wa/link/status'), call('GET', '/api/dash/wa/link/status')])
  assert.ok(rs.every((r) => r.body.status === 'connected'))
  assert.equal(gw.calls.filter((c) => c.url === '/api/v1/messages').length, 1)
  await tick()
  assert.deepEqual(exits, [75])
  await app.close()
})

test('fix1: 201 بـ session_id بلا api_key ← حذف الرقم اليتيم ثم خطأ', async () => {
  gw.provision = { code: 201, body: { session_id: 'sess-orphan', phone: ASSISTANT, status: 'connecting' } }
  await assert.rejects(provisionClient(gwUrl, PROVISION_KEY).provisionNumber(ASSISTANT, 'سراج'), (e: any) => e.code === 'unknown')
  const del = gw.calls.find((c) => c.method === 'DELETE')!
  assert.equal(del.url, '/api/v1/numbers/sess-orphan')
  assert.equal(del.auth, `Bearer ${PROVISION_KEY}`)
})

test('fix1: مفتاح الرقم 401 ← رسالة «مفتاح رقم المساعد»؛ QR 401 يظهر خطأ و404 = لم يجهز', async () => {
  const nc = numberClient(gwUrl, NUMBER_KEY)
  gw.statusCode = 401
  await assert.rejects(nc.status(ASSISTANT), (e: any) => e.code === 'unauthorized' && /مفتاح رقم المساعد/.test(e.message) && !/GATEWAY_PROVISION_KEY/.test(e.message))
  gw.statusCode = 429
  await assert.rejects(nc.status(ASSISTANT), (e: any) => e.code === 'rate_limited')
  gw.qrCode = 404
  assert.equal(await nc.qrPng(ASSISTANT), null)
  gw.qrCode = 401
  await assert.rejects(nc.qrPng(ASSISTANT), (e: any) => e.code === 'unauthorized' && /مفتاح رقم المساعد/.test(e.message))
  await assert.rejects(numberClient(deadUrl, NUMBER_KEY).qrPng(ASSISTANT), (e: any) => e.code === 'unreachable')

  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-04T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  const call = caller(app, await login(app))
  const q = await call('GET', '/api/dash/wa/link/qr')
  assert.equal(q.status, 502); assert.match(q.body.error, /مفتاح رقم المساعد/)
  gw.qrCode = 404
  assert.deepEqual((await call('GET', '/api/dash/wa/link/qr')).body, { qr_png_base64: null })
  gw.statusCode = 401
  const s1 = await call('GET', '/api/dash/wa/link/status')
  assert.equal(s1.status, 502); assert.match(s1.body.error, /فك الربط واربطه من جديد/)
  await app.close()
})

test('fix1: restart المحقون (إيقاف نظيف) يُستدعى بدل exit', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-05T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  let restarts = 0
  const { app } = makeApp(fullEnv(), { restart: async () => { restarts++ } }); await app.ready()
  gw.status = { status: 'connected', last_disconnect_reason: null }
  const s = await caller(app, await login(app))('GET', '/api/dash/wa/link/status')
  assert.equal(s.body.restarting, true)
  await tick()
  assert.equal(restarts, 1)
  assert.deepEqual(exits, [])
  await app.close()
})

test('fix1: GET /wa/link — الوسيط بطيء ← status=unknown مع بيانات الربط بلا تعليق', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-06T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv(), { statusTimeoutMs: 100 }); await app.ready()
  const call = caller(app, await login(app))
  gw.statusDelayMs = 600
  const t0 = Date.now()
  const g = await call('GET', '/api/dash/wa/link')
  assert.ok(Date.now() - t0 < 500, 'رد قبل انتهاء طلب الوسيط')
  assert.equal(g.body.linked, true); assert.equal(g.body.status, 'unknown'); assert.equal(g.body.assistantPhone, ASSISTANT)
  await new Promise((r) => setTimeout(r, 700))
  await app.close()
})

// ───── المتابعة ─────
test('followup: GET /wa/link — مفتاح الرقم ملغى (401) ← status=error مع الرسالة العربية؛ الوسيط لا يستجيب ← unreachable مع رسالة', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-07T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  gw.statusCode = 401
  const g = await caller(app, await login(app))('GET', '/api/dash/wa/link')
  assert.equal(g.body.linked, true)
  assert.equal(g.body.status, 'error'); assert.equal(g.body.errorCode, 'unauthorized')
  assert.match(g.body.message, /مفتاح رقم المساعد/)
  await app.close()

  const dead = makeApp({ ...fullEnv(), GATEWAY_URL: deadUrl }); await dead.app.ready()
  const g2 = await caller(dead.app, await login(dead.app))('GET', '/api/dash/wa/link')
  assert.equal(g2.body.status, 'unreachable'); assert.match(g2.body.message, /ما قدرت أوصل للوسيط/)
  await dead.app.close()
})

test('followup: GET /wa/link يرجع disconnectReason (qr_timeout) لتوجيه الصفحة لشاشة الرمز', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-08T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app } = makeApp(fullEnv()); await app.ready()
  gw.status = { status: 'disconnected', last_disconnect_reason: 'qr_timeout' }
  const g = await caller(app, await login(app))('GET', '/api/dash/wa/link')
  assert.equal(g.body.disconnectReason, 'qr_timeout'); assert.match(g.body.message, /انتهت مهلة الرمز/)
  await app.close()
})

test('followup: 401 عند ضبط الويبهوك أثناء الربط ← رسالة الويبهوك (بلا «فك الربط») + تراجع بلا kv', async () => {
  gw.webhookCode = 401
  const { app } = makeApp(fullEnv()); await app.ready()
  const p = await caller(app, await login(app))('POST', '/api/dash/wa/link', { assistantPhone: '0500000011', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 502)
  assert.match(p.body.error, /رفض ضبط الويبهوك/)
  assert.doesNotMatch(p.body.error, /فك الربط/)
  assert.equal(gw.calls.find((c) => c.method === 'DELETE')!.url, '/api/v1/numbers/sess-1')
  assert.equal(await store.getKv('wa_link'), null)
  await app.close()
})

test('followup: POST مرفوض بينما إعادة التشغيل مجدولة', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-09T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app, cfg } = makeApp(fullEnv())
  cfg.gatewayApiKey = NUMBER_KEY; cfg.waLinkFilled.push('gatewayApiKey'); cfg.whatsappEnabled = true
  await app.ready()
  const call = caller(app, await login(app))
  const d = await call('DELETE', '/api/dash/wa/link')
  assert.equal(d.body.restarting, true)
  const p = await call('POST', '/api/dash/wa/link', { assistantPhone: '0500000013', ownerPhone: '0500000012', acceptRisk: true })
  assert.equal(p.status, 409); assert.match(p.body.error, /يعيد التشغيل/)
  assert.ok(!gw.calls.some((c) => c.url === '/api/v1/numbers' && c.method === 'POST'))
  await tick()
  await app.close()
})

test('followup: المالك الفعلي = البيئة أو رقم الربط (لا قيمة ملأها ربط قديم عند الإقلاع)', async () => {
  await saveWaLink(store, { assistantPhone: ASSISTANT, ownerPhone: OWNER, apiKey: NUMBER_KEY, linkedAt: '2026-10-10T00:00:00Z', numberId: 'sess-1' }, SECRETS)
  const { app, cfg } = makeApp(fullEnv())
  applyWaLink(cfg, { assistantPhone: '966500000055', ownerPhone: '966500000066', apiKey: 'older', linkedAt: 'x' })
  await app.ready()
  gw.status = { status: 'connected', last_disconnect_reason: null }
  await caller(app, await login(app))('GET', '/api/dash/wa/link/status')
  const w = gw.calls.filter((c) => c.url === '/api/v1/messages')
  assert.equal(w.length, 1); assert.equal(w[0].body.to, OWNER)
  await tick()
  await app.close()
})
