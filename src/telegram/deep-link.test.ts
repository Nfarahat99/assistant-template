import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { TelegramBot } from './bot.js'
import type { TelegramApi } from './client.js'
import { isStartPayload, telegramStartUrl, openUrlCommand, START_PAYLOAD } from './deep-link.js'

test('link code format used by the setup (24 hex, openssl rand -hex 12) fits Telegram start payload rules', () => {
  for (let i = 0; i < 50; i++) assert.ok(isStartPayload(randomBytes(12).toString('hex')))
  assert.match(readFileSync('docs/TEMPLATE.md', 'utf8'), /openssl rand -hex 12/)
})

test('start payload: only [A-Za-z0-9_-], 1..64 chars', () => {
  for (const ok of ['a', 'link-code_7f3a9c', 'A'.repeat(64)]) assert.ok(isStartPayload(ok), ok)
  for (const bad of ['', 'A'.repeat(65), 'has space', 'a+b', 'a/b', 'رمز', 'a=b', 'a&b']) assert.equal(isStartPayload(bad), false, bad)
  assert.equal(START_PAYLOAD.test('x'.repeat(64)), true)
})

test('telegramStartUrl builds t.me deep link and rejects unsafe parts', () => {
  assert.equal(telegramStartUrl('rafiq_test_bot', 'abc123'), 'https://t.me/rafiq_test_bot?start=abc123')
  assert.equal(telegramStartUrl('@rafiq_test_bot', 'abc123'), 'https://t.me/rafiq_test_bot?start=abc123')
  assert.throws(() => telegramStartUrl('rafiq_test_bot', 'a b'))
  assert.throws(() => telegramStartUrl('bad/bot', 'abc'))
})

test('openUrlCommand: no shell, url passed as a single argument', () => {
  const url = 'https://t.me/x_bot?start=abc'
  assert.deepEqual(openUrlCommand('win32', url), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  assert.deepEqual(openUrlCommand('darwin', url), { cmd: 'open', args: [url] })
  assert.deepEqual(openUrlCommand('linux', url), { cmd: 'xdg-open', args: [url] })
})

/** كائن مزيّف يقبل أي استدعاء (async no-op) — حتى لو صار الربط يستدعي دوال إضافية لاحقاً */
const anyAsync = (over: Record<string, unknown> = {}) => new Proxy(over, {
  get: (t, k) => (k in t ? (t as any)[k] : k === 'then' ? undefined : async () => null),
}) as any

test('deep link binds exactly like typing it: Telegram sends "/start <payload>" on Start', async () => {
  const code = randomBytes(12).toString('hex')
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_LINK_CODE: code } as any)
  const kv = new Map<string, string>()
  const store = anyAsync({ markSeen: async () => true, getKv: async (k: string) => kv.get(k) ?? null, setKv: async (k: string, v: string) => { kv.set(k, v) } })
  const sent: string[] = []
  const api = anyAsync({ sendMessage: async (_c: unknown, text: string) => { sent.push(text); return { message_id: 1, date: 0, chat: { id: 1 } } } }) as TelegramApi
  const bot = new TelegramBot(cfg, api, store, anyAsync())
  await bot.init()
  // الضغط على Start من رابط t.me/<bot>?start=<code> يرسل هذا النص بالضبط
  const url = new URL(telegramStartUrl('rafiq_test_bot', code))
  const text = `/start ${url.searchParams.get('start')}`
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 4242 }, from: { id: 4242, first_name: 'X' }, text } })
  assert.equal(bot.ownerChat, '4242')
  assert.equal(kv.get('tg_owner_chat'), '4242')
  assert.match(sent[0] ?? '', /تم ربطك/)
})
