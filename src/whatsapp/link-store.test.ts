import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createDb } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { Store } from '../store.js'
import { loadConfig } from '../config.js'
import { saveWaLink, loadWaLink, applyWaLink, clearWaLink, overlayWaLink, waLinkConnected, WELCOMED_KEY, type WaLink } from './link-store.js'

let store: Store
before(async () => {
  const db = await createDb({ pgliteDir: 'memory://' } as any)
  await migrate(db)
  store = new Store(db)
})

const K = randomBytes(32).toString('hex')
const link: WaLink = { assistantPhone: '966500000001', ownerPhone: '966500000002', apiKey: 'sk-test-secret-123', linkedAt: '2026-01-01T00:00:00Z' }

test('round trip; apiKey never plain in kv', async () => {
  await saveWaLink(store, link, K)
  const raw = (await store.getKv('wa_link'))!
  assert.ok(!raw.includes(link.apiKey))
  const r = await loadWaLink(store, K)
  assert.deepEqual(r, { ok: true, link })
})

test('no key → no_key; wrong key → bad_key; malformed → bad_key', async () => {
  await saveWaLink(store, link, K)
  assert.deepEqual(await loadWaLink(store, ''), { ok: false, reason: 'no_key' })
  assert.deepEqual(await loadWaLink(store, 'abc'), { ok: false, reason: 'no_key' })
  assert.deepEqual(await loadWaLink(store, randomBytes(32).toString('hex')), { ok: false, reason: 'bad_key' })
  await store.setKv('wa_link', '{not json')
  assert.deepEqual(await loadWaLink(store, K), { ok: false, reason: 'bad_key' })
})

test('clear → none', async () => {
  await saveWaLink(store, link, K)
  await clearWaLink(store)
  assert.deepEqual(await loadWaLink(store, K), { ok: false, reason: 'none' })
})

test('applyWaLink: env wins; enabled only with gatewayUrl', () => {
  const noUrl = loadConfig({} as any)
  applyWaLink(noUrl, link)
  assert.equal(noUrl.whatsappEnabled, false)
  assert.equal(noUrl.gatewayApiKey, link.apiKey)

  const withUrl = loadConfig({ GATEWAY_URL: 'https://g' } as any)
  applyWaLink(withUrl, link)
  assert.equal(withUrl.whatsappEnabled, true)

  const envWins = loadConfig({ GATEWAY_URL: 'https://g', GATEWAY_API_KEY: 'env-key', ASSISTANT_PHONE: '966511111111', OWNER_PHONE: '966500002222' } as any)
  applyWaLink(envWins, link)
  assert.equal(envWins.gatewayApiKey, 'env-key')
  assert.equal(envWins.assistantPhone, '966511111111')
  assert.equal(envWins.ownerPhone, '966500002222')
})

test('overlayWaLink: applies when ok; warns (no secret) on bad_key; silent on none', async () => {
  await saveWaLink(store, { ...link, connectedAt: '2026-01-01T00:05:00Z' }, K)
  const warns: any[] = []
  const cfg = loadConfig({ GATEWAY_URL: 'https://g', SECRETS_KEY: K } as any)
  await overlayWaLink(store, cfg, (...a) => warns.push(a))
  assert.equal(cfg.whatsappEnabled, true)
  assert.equal(warns.length, 0)

  const bad = loadConfig({ GATEWAY_URL: 'https://g' } as any)
  await overlayWaLink(store, bad, (...a) => warns.push(a))
  assert.equal(bad.whatsappEnabled, false)
  assert.deepEqual(warns[0][0], { reason: 'no_key' })
  assert.ok(!JSON.stringify(warns).includes(link.apiKey))

  await clearWaLink(store)
  await overlayWaLink(store, loadConfig({} as any), (...a) => warns.push(a))
  assert.equal(warns.length, 1)
})

test('connectedAt: round trip; ربط معلّق (لم يتصل) لا يُطبَّق عند الإقلاع، والمتصل يُطبَّق', async () => {
  await store.delKv(WELCOMED_KEY)
  const connected = { ...link, connectedAt: '2026-01-01T00:05:00Z' }
  await saveWaLink(store, connected, K)
  assert.deepEqual(await loadWaLink(store, K), { ok: true, link: connected })

  await saveWaLink(store, link, K)   // حُفظ قبل مسح الرمز ثم تُرك
  const pending = loadConfig({ GATEWAY_URL: 'https://g', SECRETS_KEY: K } as any)
  await overlayWaLink(store, pending, () => assert.fail('لا تحذير'))
  assert.equal(pending.whatsappEnabled, false)
  assert.equal(pending.gatewayApiKey, '')
  assert.deepEqual(pending.waLinkFilled, [])
  assert.equal(await waLinkConnected(store, link), false)

  await saveWaLink(store, connected, K)
  const ok = loadConfig({ GATEWAY_URL: 'https://g', SECRETS_KEY: K } as any)
  await overlayWaLink(store, ok, () => assert.fail('لا تحذير'))
  assert.equal(ok.whatsappEnabled, true)
  await clearWaLink(store)
})

test('connectedAt: ربط قديم بلا connectedAt لكن رُحّب به (wa_link_welcomed = linkedAt) يُعتبر متصلاً', async () => {
  await saveWaLink(store, link, K)
  await store.setKv(WELCOMED_KEY, link.linkedAt)
  assert.equal(await waLinkConnected(store, link), true)
  const cfg = loadConfig({ GATEWAY_URL: 'https://g', SECRETS_KEY: K } as any)
  await overlayWaLink(store, cfg, () => {})
  assert.equal(cfg.whatsappEnabled, true)
  await store.setKv(WELCOMED_KEY, 'ربط آخر')
  assert.equal(await waLinkConnected(store, link), false)
  await store.delKv(WELCOMED_KEY)
  await clearWaLink(store)
})
