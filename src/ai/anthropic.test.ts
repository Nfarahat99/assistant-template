import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicLlm } from './anthropic.js'
import { HttpError, shouldFallback } from './providers.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function fake(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    const h: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { h[k] = v })
    calls.push({ url: String(url), headers: h, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } })
  }) as any
  return calls
}
const ok = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })

test('complete sends system + user to /v1/messages and returns joined text', async () => {
  const calls = fake(200, ok('{"actions":[],"reply":"هلا"}'))
  const llm = anthropicLlm('sk-test', () => 'claude-opus-5-5')
  assert.equal(await llm.complete('SYS', 'USER'), '{"actions":[],"reply":"هلا"}')
  assert.match(calls[0].url, /\/v1\/messages$/)
  assert.equal(calls[0].headers['x-api-key'], 'sk-test')
  assert.equal(calls[0].body.model, 'claude-opus-5-5')
  assert.equal(calls[0].body.system, 'SYS')
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'USER' }])
})

test('429 surfaces as HttpError that triggers fallback', async () => {
  fake(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
  const llm = anthropicLlm('sk-test', () => 'claude-opus-5-5')
  await assert.rejects(llm.complete('s', 'u'), (e: unknown) => e instanceof HttpError && e.status === 429 && shouldFallback(e))
})

test('refusal surfaces as HttpError 451 (fallback to next provider)', async () => {
  fake(200, { ...ok(''), content: [], stop_reason: 'refusal' })
  const llm = anthropicLlm('sk-test', () => 'claude-opus-5-5')
  await assert.rejects(llm.complete('s', 'u'), (e: unknown) => e instanceof HttpError && e.status === 451)
})

test('completeWithMedia sends an image block before the text', async () => {
  const calls = fake(200, ok('قراءة'))
  const llm = anthropicLlm('sk-test', () => 'claude-opus-5-5')
  await llm.completeWithMedia!('SYS', 'اقرأ', { base64: 'AAAA', mimetype: 'image/png' })
  const content = calls[0].body.messages[0].content
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].source.media_type, 'image/png')
  assert.equal(content[1].text, 'اقرأ')
})
