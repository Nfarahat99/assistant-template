/**
 * حارس الاتصال: وسيط ومزوّد ntfy مزيّفان، وساعة يدوية.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { Watchdog, QR_MESSAGE } from './watchdog.js'
import { rfc2047 } from './clients/ntfy.js'
import type { GatewayClient, WaStatus } from './clients/gateway.js'
import type { NtfyMessage } from './clients/ntfy.js'

const MIN = 60_000
const cfg = loadConfig({ ASSISTANT_PHONE: '966500000002', GATEWAY_URL: 'https://gw.example', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

function setup(initial: WaStatus) {
  let clock = new Date('2026-10-01T08:00:00Z').getTime()
  const state = { status: initial as WaStatus, reason: 'connection closed' }
  const calls: string[] = []
  const pushes: NtfyMessage[] = []
  const images: { png: Buffer; m: NtfyMessage & { filename?: string } }[] = []
  const recovered: string[] = []
  const gateway: GatewayClient = {
    async sendText() { throw new Error('الحارس لا يرسل واتساب') },
    async getMessage() { throw new Error('x') },
    async getStatus(from) { calls.push(`status ${from}`); return { status: state.status, last_disconnect_reason: state.reason } },
    async resume() { calls.push('resume') },
    async relink() { calls.push('relink'); state.status = 'qr' },
    async qrPng() { calls.push('qr'); return Buffer.from('PNG') },
  }
  const wd = new Watchdog(cfg, gateway, {
    async send(m) { pushes.push(m) },
    async sendImage(png, m) { images.push({ png, m }) },
  }, { async onRecovered(s) { recovered.push(s) } }, () => new Date(clock))
  const at = async (minutes: number) => { clock += minutes * MIN; await wd.check() }
  return { wd, state, calls, pushes, images, recovered, at }
}

test('تذبذب أقل من دقيقتين: لا استئناف ولا تنبيه، لكن الرسائل تُحجز', async () => {
  const s = setup('disconnected')
  await s.at(0)
  assert.equal(s.wd.isDown, true)
  s.state.status = 'connected'
  await s.at(1)
  assert.equal(s.wd.isDown, false)
  assert.ok(!s.calls.includes('resume'))
  assert.equal(s.pushes.filter((p) => p.title.includes('مقطوع')).length, 0)
})

test('مقطوع: استئناف بعد دقيقتين، تنبيه ntfy إن بقي مقطوعاً، تباعد ٢/٥/١٥، وإعادة تنبيه كل ٣٠ د', async () => {
  const s = setup('disconnected')
  await s.at(0)
  await s.at(2)                                            // t=2: أول استئناف، بلا تنبيه
  assert.equal(s.calls.filter((c) => c === 'resume').length, 1)
  assert.equal(s.pushes.length, 0)
  await s.at(1)                                            // t=3: ما زال مقطوعاً ← تنبيه
  assert.equal(s.pushes.length, 1)
  assert.equal(s.pushes[0].title, '⚠️ واتساب البوت مقطوع!')
  assert.equal(s.pushes[0].priority, 5)
  assert.equal(s.pushes[0].click, 'https://gw.example')
  await s.at(1)                                            // t=4: الاستئناف الثاني (بعد ٢ د)
  assert.equal(s.calls.filter((c) => c === 'resume').length, 2)
  await s.at(4)                                            // t=8: قبل ٥ د من الثاني
  assert.equal(s.calls.filter((c) => c === 'resume').length, 2)
  await s.at(1)                                            // t=9: الثالث
  assert.equal(s.calls.filter((c) => c === 'resume').length, 3)
  await s.at(10)                                           // t=19: لا تنبيه (أقل من ٣٠ د)
  assert.equal(s.pushes.length, 1)
  await s.at(15)                                           // t=34: إعادة تنبيه
  assert.equal(s.pushes.length, 2)

  s.state.status = 'connected'
  await s.at(1)
  assert.equal(s.wd.isDown, false)
  assert.equal(s.pushes.at(-1)!.title, '✅ رجع البوت متصل')
  assert.equal(s.recovered.length, 1)
  assert.match(s.recovered[0], /✅ رجع البوت متصل \(انقطع 35 دقيقة\)/)
  assert.match(s.recovered[0], /محاولة استئناف 1/)
})

test('logged_out: relink مرة في الساعة، وصورة QR مرفقة في ntfy بالنص المطلوب', async () => {
  const s = setup('logged_out')
  await s.at(0)
  await s.at(2)
  assert.deepEqual(s.calls.filter((c) => c !== 'status 966500000002'), ['relink', 'qr'])
  assert.equal(s.images.length, 1)
  assert.equal(s.images[0].m.message, QR_MESSAGE)
  assert.equal(s.images[0].m.filename, 'qr.png')
  assert.equal(s.images[0].png.toString(), 'PNG')
  assert.ok(!s.calls.includes('resume'), 'لا استئناف لجلسة تحتاج QR')

  s.state.status = 'logged_out'
  await s.at(10)
  assert.equal(s.calls.filter((c) => c === 'relink').length, 1, 'relink مرة في الساعة فقط')
  await s.at(55)
  assert.equal(s.calls.filter((c) => c === 'relink').length, 2)
})

test('الوسيط لا يرد: تنبيه بعد دقيقتين بدون استئناف', async () => {
  const s = setup('connected')
  ;(s as any).wd['gateway'].getStatus = async () => { throw new Error('ECONNREFUSED') }
  await s.at(0)
  assert.equal(s.wd.status, 'unreachable')
  await s.at(2)
  assert.equal(s.pushes.length, 1)
  assert.match(s.pushes[0].message, /الوسيط لا يرد/)
})

test('ترميز RFC 2047 للترويسات العربية', () => {
  const enc = rfc2047(QR_MESSAGE)
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  assert.equal(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8'), QR_MESSAGE)
})

// ───── حمولات الوسيط الحقيقية (بلاغ عمر) ─────
import { isBan } from './watchdog.js'
import { REAL_BAN_STATUS, REAL_CIRCUIT_BREAKER_STATUS } from './test-fixtures.js'

function setupPayload(initial: any) {
  let clock = new Date('2026-10-01T08:00:00Z').getTime()
  let payload = initial
  const calls: string[] = []
  const pushes: NtfyMessage[] = []
  const gateway: GatewayClient = {
    async sendText() { throw new Error('x') },
    async getMessage() { throw new Error('x') },
    async getStatus() { return payload },
    async resume() { calls.push('resume') },
    async relink() { calls.push('relink') },
    async qrPng() { calls.push('qr'); return Buffer.from('PNG') },
  }
  const wd = new Watchdog(cfg, gateway, { async send(m) { pushes.push(m) }, async sendImage() {} },
    { async onRecovered() {} }, () => new Date(clock))
  return { wd, calls, pushes, set: (p: any) => { payload = p }, at: async (m: number) => { clock += m * MIN; await wd.check() } }
}

test('isBan: الحمولة الحقيقية لرقم محظور، و last_disconnect_reason=ban، وقاطع الدائرة ليس حظراً', () => {
  assert.equal(isBan(REAL_BAN_STATUS), true)
  assert.equal(isBan({ status: 'disconnected', last_disconnect_reason: 'ban', paused_reason: null }), true)
  assert.equal(isBan({ status: 'paused', paused_reason: 'حظر مؤقت' }), true)
  assert.equal(isBan(REAL_CIRCUIT_BREAKER_STATUS), false)
  assert.equal(isBan({ status: 'disconnected', last_disconnect_reason: 'connection closed' }), false)
})

test('رقم محظور (حمولة حقيقية): تنبيه حظر واحد، ولا استئناف ولا relink أبداً', async () => {
  const s = setupPayload(REAL_BAN_STATUS)
  for (const m of [0, 2, 1, 5, 15, 30, 60]) await s.at(m)
  assert.deepEqual(s.calls, [], 'لا resume ولا relink لرقم محظور')
  const bans = s.pushes.filter((p) => p.title.includes('محظور'))
  assert.equal(bans.length, 1)
  assert.match(bans[0].message, /حظره واتساب \(403\)/)
  assert.equal(s.pushes.length, 1, 'لا تنبيهات انقطاع إضافية')
  assert.equal(s.wd.snapshot().banned, true)
})

test('paused (قاطع الدائرة): تنبيه واحد بالسبب، ولا استئناف تلقائي مهما طال', async () => {
  const s = setupPayload(REAL_CIRCUIT_BREAKER_STATUS)
  for (const m of [0, 2, 1, 5, 15, 30, 60]) await s.at(m)
  assert.ok(!s.calls.includes('resume'), 'لا استئناف لرقم موقوف')
  assert.equal(s.pushes.length, 1)
  assert.equal(s.pushes[0].title, '⏸️ رقم البوت موقوف في الوسيط')
  assert.match(s.pushes[0].message, /فشل متتالٍ 3 مرات/)
})

test('disconnected / connecting فقط تُستأنف تلقائياً', async () => {
  for (const status of ['disconnected', 'connecting']) {
    const s = setupPayload({ status, last_disconnect_reason: 'connection closed', paused_reason: null })
    await s.at(0); await s.at(2)
    assert.deepEqual(s.calls, ['resume'], status)
  }
})
