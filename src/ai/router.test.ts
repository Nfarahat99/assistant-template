import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../config.js'
import { buildRoleClients } from './router.js'
import { defaultModels, type ModelsSettings } from './roles.js'
import { withUsage, setUsageSink, flushUsage, type UsageContext, type UsageEvent } from '../usage.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
function route(plan: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = []
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url))
    const r = plan(String(url))
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as any
  return urls
}
const gem = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] })
const claude = (t: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })

const cfg = loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'https://or.example/v1' } as any)

test('understand → anthropic, general stays gemini', async () => {
  const models: ModelsSettings = { ...defaultModels(cfg), understand: { provider: 'anthropic', model: 'claude-opus-5-5' } }
  const urls = route((u) => u.includes('anthropic') ? { status: 200, body: claude('U') } : { status: 200, body: gem('G') })
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.understandLlm.complete('s', 'u'), 'U')
  assert.equal(await c.llm.complete('s', 'u'), 'G')
  assert.ok(urls[0].includes('api.anthropic.com'))
  assert.ok(urls[1].includes('generativelanguage'))
})

test('primary 429 → role fallback provider', async () => {
  const models: ModelsSettings = { ...defaultModels(cfg), general: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } }
  route((u) => u.includes('anthropic') ? { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'x' } } } : { status: 200, body: gem('G') })
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.llm.complete('s', 'u'), 'G')
})

test('missing key for role provider → falls back, keyStatus shows degraded', async () => {
  const noAnthropic = loadConfig({ GEMINI_API_KEY: 'g' } as any)
  const models: ModelsSettings = { ...defaultModels(noAnthropic), understand: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } }
  route(() => ({ status: 200, body: gem('G') }))
  const c = buildRoleClients(noAnthropic, () => models)
  assert.equal(await c.understandLlm.complete('s', 'u'), 'G')
  const ks = c.keyStatus().find((k) => k.role === 'understand')!
  assert.equal(ks.hasKey, false)
  assert.equal(ks.fallbackHasKey, true)
})

test('openai-compatible provider uses OPENAI_BASE_URL', async () => {
  const models: ModelsSettings = { ...defaultModels(cfg), general: { provider: 'openai', model: 'meta/llama-4' } }
  const urls = route(() => ({ status: 200, body: { choices: [{ message: { content: 'O' } }] } }))
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.llm.complete('s', 'u'), 'O')
  assert.equal(urls[0], 'https://or.example/v1/chat/completions')
})

test('settings change applies on the next call without rebuild', async () => {
  let models: ModelsSettings = defaultModels(cfg)
  route((u) => u.includes('anthropic') ? { status: 200, body: claude('C') } : { status: 200, body: gem('G') })
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.llm.complete('s', 'u'), 'G')
  models = { ...models, general: { provider: 'anthropic', model: 'claude-opus-5-5' } }
  assert.equal(await c.llm.complete('s', 'u'), 'C')
})

test('voice/vision/video/research methods are attached from their roles', () => {
  const c = buildRoleClients(cfg, () => defaultModels(cfg))
  assert.equal(typeof c.llm.completeWithAudio, 'function')
  assert.equal(typeof c.llm.completeWithMedia, 'function')
  assert.equal(typeof c.llm.summarizeVideo, 'function')
  assert.equal(typeof c.llm.searchWeb, 'function')
})

test('voice → groq: no one-call audio (assistant uses stt), stt goes to Groq Whisper', async () => {
  const withGroq = loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_PROVIDER: 'gemini' } as any)
  let models: ModelsSettings = { ...defaultModels(withGroq), voice: { provider: 'groq', model: 'whisper-large-v3-turbo' } }
  const urls = route(() => ({ status: 200, body: { text: 'نص' } }))
  const c = buildRoleClients(withGroq, () => models)
  assert.equal(c.llm.completeWithAudio, undefined)
  assert.equal(c.understandLlm.completeWithAudio, undefined)
  assert.equal(await c.stt.transcribe('AAAA', 'audio/ogg'), 'نص')
  assert.match(urls[0], /api\.groq\.com/)
  models = defaultModels(withGroq)
  assert.equal(typeof c.llm.completeWithAudio, 'function')
})

// ─────────── fix round 1: حصة لكل دور، احتياط بين المزوّدين، STT، الظهور والقياس ───────────

const nvOk = (t: string) => ({ choices: [{ message: { content: t } }] })
const flashExhausted = (p: string, m: string) => p === 'gemini' && m === 'gemini-3.8-flash'

test('quota: NVIDIA legacy + Gemini flash exhausted → understand still tries Nvidia first', async () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  const urls = route((u) => u.includes('nvidia') ? { status: 200, body: nvOk('NV') } : { status: 429, body: { error: { message: 'quota' } } })
  const c = buildRoleClients(nv, () => defaultModels(nv), { isExhausted: flashExhausted })
  assert.equal(await c.understandLlm.complete('s', 'u'), 'NV')
  assert.match(urls[0], /integrate\.api\.nvidia\.com/)
  assert.equal(urls.length, 1)
})

test('quota: Claude-primary role is not downgraded when Gemini flash is exhausted', async () => {
  const models: ModelsSettings = { ...defaultModels(cfg), general: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } }
  const urls = route((u) => u.includes('anthropic') ? { status: 200, body: claude('C') } : { status: 200, body: gem('G') })
  const c = buildRoleClients(cfg, () => models, { isExhausted: flashExhausted })
  assert.equal(await c.llm.complete('s', 'u'), 'C')
  assert.ok(urls[0].includes('api.anthropic.com'))
})

test('quota: gemini-only + flash exhausted → general/voice/vision go straight to lite', async () => {
  const g = loadConfig({ GEMINI_API_KEY: 'g' } as any)
  const urls = route(() => ({ status: 200, body: gem('{"x":1}') }))
  const c = buildRoleClients(g, () => defaultModels(g), { isExhausted: flashExhausted })
  await c.llm.complete('s', 'u')
  await c.llm.completeWithAudio!('s', 'u', { base64: 'A', mimetype: 'audio/ogg' })
  await c.llm.completeWithMedia!('s', 'u', { base64: 'A', mimetype: 'image/png' })
  assert.equal(urls.length, 3)
  for (const u of urls) assert.match(u, /gemini-3\.5-flash-lite:generateContent/)
})

test('quota: Gemini as cross-provider fallback skips the exhausted flash and reaches lite', async () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  const urls = route((u) => u.includes('nvidia') ? { status: 503, body: { detail: 'down' } } : u.includes('lite') ? { status: 200, body: gem('LITE') } : { status: 429, body: { error: { message: 'quota' } } })
  const c = buildRoleClients(nv, () => defaultModels(nv), { isExhausted: flashExhausted })
  assert.equal(await c.understandLlm.complete('s', 'u'), 'LITE')
  assert.deepEqual(urls.map((u) => (u.includes('nvidia') ? 'nv' : u.includes('lite') ? 'lite' : 'flash')), ['nv', 'lite'])
})

test('Gemini as fallback still reaches lite when flash returns 429 (not yet marked exhausted)', async () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  route((u) => u.includes('nvidia') ? { status: 500, body: {} } : u.includes('lite') ? { status: 200, body: gem('LITE') } : { status: 429, body: { error: { message: 'quota' } } })
  const c = buildRoleClients(nv, () => defaultModels(nv))
  assert.equal(await c.understandLlm.complete('s', 'u'), 'LITE')
})

test('cross-provider: Nvidia 410 (model retired) → Gemini answers', async () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  const urls = route((u) => u.includes('nvidia') ? { status: 410, body: { detail: 'model retired' } } : { status: 200, body: gem('G') })
  const c = buildRoleClients(nv, () => defaultModels(nv))
  assert.equal(await c.understandLlm.complete('s', 'u'), 'G')
  assert.ok(urls[1].includes('generativelanguage'))
})

test('cross-provider: empty reply from primary → fallback used', async () => {
  const models: ModelsSettings = { ...defaultModels(cfg), general: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } }
  route((u) => u.includes('anthropic') ? { status: 200, body: claude('   ') } : { status: 200, body: gem('G') })
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.llm.complete('s', 'u'), 'G')
})

test('same provider: 400 does not fall back (narrow rule kept)', async () => {
  const urls = route(() => ({ status: 400, body: { error: { message: 'bad' } } }))
  const c = buildRoleClients(cfg, () => defaultModels(cfg))
  await assert.rejects(c.llm.complete('s', 'u'))
  assert.equal(urls.length, 1)
})

test('stt: Gemini flash 429 → lite transcribes', async () => {
  const g = loadConfig({ GEMINI_API_KEY: 'g' } as any)
  const urls = route((u) => u.includes('lite') ? { status: 200, body: gem('LITE') } : { status: 429, body: { error: { message: 'quota' } } })
  const c = buildRoleClients(g, () => defaultModels(g))
  assert.equal(await c.stt.transcribe('AAAA', 'audio/ogg'), 'LITE')
  assert.equal(urls.length, 2)
})

test('stt: voice=groq and Groq fails → Gemini transcribes', async () => {
  const withGroq = loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_PROVIDER: 'gemini' } as any)
  const models: ModelsSettings = { ...defaultModels(withGroq), voice: { provider: 'groq', model: 'whisper-large-v3-turbo' } }
  const urls = route((u) => u.includes('groq') ? { status: 500, body: {} } : { status: 200, body: gem('GEM') })
  const c = buildRoleClients(withGroq, () => models)
  assert.equal(await c.stt.transcribe('AAAA', 'audio/ogg'), 'GEM')
  assert.match(urls[0], /api\.groq\.com/)
  assert.match(urls[1], /generativelanguage/)
})

test('visibility: fallback sets served.fellBack + reason naming the failed primary', async () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  route((u) => u.includes('nvidia') ? { status: 410, body: { detail: 'model retired' } } : { status: 200, body: gem('G') })
  const c = buildRoleClients(nv, () => defaultModels(nv))
  const ctx: UsageContext = { purpose: 'chat' }
  await withUsage(ctx, () => c.understandLlm.complete('s', 'u'))
  assert.equal(ctx.served?.provider, 'gemini')
  assert.equal(ctx.served?.fellBack, true)
  assert.match(ctx.served?.fallbackReason ?? '', /^nvidia:nvidia\/nemotron-3-super-120b-a12b: .*410/)
})

test('visibility: Gemini flash → lite (same provider) does NOT set served.fellBack (parity: no "النموذج الأساسي متعثّر" trailer)', async () => {
  const g = loadConfig({ GEMINI_API_KEY: 'g' } as any)
  const urls = route((u) => u.includes(g.geminiModel) ? { status: 503, body: { error: { message: 'overloaded' } } } : { status: 200, body: gem('L') })
  const c = buildRoleClients(g, () => defaultModels(g))
  const ctx: UsageContext = { purpose: 'chat' }
  assert.equal(await withUsage(ctx, () => c.llm.complete('s', 'u')), 'L')
  assert.ok(urls.some((u) => u.includes(g.geminiFallbackModel)), 'lite answered')
  assert.equal(ctx.served?.provider, 'gemini')
  assert.equal(ctx.served?.fellBack, false)
})

test('metering: Anthropic and OpenAI-compatible calls are recorded and set served (lastServed)', async () => {
  const events: UsageEvent[] = []
  setUsageSink((e) => { events.push(e) })
  try {
    const models: ModelsSettings = { ...defaultModels(cfg), understand: { provider: 'anthropic', model: 'claude-opus-5-5' }, general: { provider: 'openai', model: 'meta/llama-4' } }
    route((u) => u.includes('anthropic') ? { status: 200, body: claude('C') } : { status: 200, body: { choices: [{ message: { content: 'O' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } } })
    const c = buildRoleClients(cfg, () => models)
    const a: UsageContext = { purpose: 'chat' }
    await withUsage(a, () => c.understandLlm.complete('s', 'u'))
    assert.deepEqual(a.served, { provider: 'anthropic', model: 'claude-opus-5-5', fellBack: false })
    const o: UsageContext = { purpose: 'chat' }
    await withUsage(o, () => c.llm.complete('s', 'u'))
    assert.equal(o.served?.provider, 'openai')
    await flushUsage()
    assert.deepEqual(events.map((e) => [e.provider, e.model, e.ok, e.output_tokens]), [['anthropic', 'claude-opus-5-5', true, 1], ['openai', 'meta/llama-4', true, 4]])
  } finally { setUsageSink(null) }
})

test('anthropic image mimetype parameters are stripped', async () => {
  let body: any
  globalThis.fetch = (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify(claude('R')), { status: 200, headers: { 'content-type': 'application/json' } }) }) as any
  const models: ModelsSettings = { ...defaultModels(cfg), vision: { provider: 'anthropic', model: 'claude-opus-5-5' } }
  const c = buildRoleClients(cfg, () => models)
  assert.equal(await c.llm.completeWithMedia!('s', 'u', { base64: 'A', mimetype: 'image/jpeg; charset=binary' }), 'R')
  assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg')
})
