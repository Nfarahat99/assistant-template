/**
 * المزوّدون بدون Groq (غير متاح من السعودية): كل شيء يذهب لـ Gemini،
 * و429/5xx ينقلنا للنموذج الأخف. fetch مُزيّف — لا شبكة.
 */
import { withUsage } from '../usage.js'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../config.js'
import { buildLlm, buildStt, shouldFallback, isAuthError } from './providers.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function fakeFetch(plan: (url: string) => { status: number; body: unknown }) {
  const calls: { url: string; body: any }[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body })
    const r = plan(u)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as any
  return calls
}
const geminiText = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })

const cfgNoGroq = loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: '' } as any)

test('بدون GROQ_API_KEY: الفهم Gemini فقط ولا محاولة Groq، والصوت المباشر متاح', async () => {
  const calls = fakeFetch(() => ({ status: 200, body: geminiText('{"actions":[],"reply":"هلا"}') }))
  const llm = buildLlm(cfgNoGroq)
  assert.equal(typeof llm.completeWithAudio, 'function')
  assert.equal(await llm.complete('s', 'u'), '{"actions":[],"reply":"هلا"}')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent/)
  assert.ok(calls.every((c) => !c.url.includes('groq.com')))
})

test('429 من النموذج الأساسي → النموذج الاحتياطي gemini-3.5-flash-lite', async () => {
  const calls = fakeFetch((url) => url.includes('gemini-3.8-flash:')
    ? { status: 429, body: { error: { message: 'quota' } } }
    : { status: 200, body: geminiText('{"actions":[],"reply":"تم"}') })
  const out = await buildLlm(cfgNoGroq).complete('s', 'u')
  assert.equal(out, '{"actions":[],"reply":"تم"}')
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /models\/gemini-3\.5-flash-lite:generateContent/)
})

test('400 (خطأ طلب) لا ينقل للاحتياط', async () => {
  const calls = fakeFetch(() => ({ status: 400, body: { error: { message: 'bad' } } }))
  await assert.rejects(buildLlm(cfgNoGroq).complete('s', 'u'))
  assert.equal(calls.length, 1)
  assert.equal(shouldFallback({ status: 503 }), true)
  assert.equal(shouldFallback({ status: 400 }), false)
})

test('451 (رفض المحتوى من المزوّد) ينقل للمزوّد الاحتياطي', () => {
  assert.equal(shouldFallback({ status: 451 }), true)
})

test('التفريغ بدون Groq: Gemini مباشرة مع الصوت inline وتعليمات التفريغ الحرفي', async () => {
  const calls = fakeFetch(() => ({ status: 200, body: geminiText('قل لأحمد إني بتأخر') }))
  const text = await buildStt(cfgNoGroq).transcribe('AAAA', 'audio/ogg; codecs=opus')
  assert.equal(text, 'قل لأحمد إني بتأخر')
  assert.equal(calls.length, 1)
  const parts = calls[0].body.contents[0].parts
  assert.match(parts[0].text, /حرفياً/)
  assert.deepEqual(parts[1].inline_data, { mime_type: 'audio/ogg', data: 'AAAA' })
})

test('مع GROQ_API_KEY: لا وضع صوت مباشر (Whisper يفرّغ أولاً)', () => {
  const llm = buildLlm(loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'x' } as any))
  assert.equal(llm.completeWithAudio, undefined)
})

test('(g) يوتيوب: file_data بالشكل الموثّق (file_uri فقط بلا mime_type) + دقة منخفضة، والخطأ الحقيقي يصعد', async () => {
  const calls = fakeFetch(() => ({ status: 200, body: geminiText('{"title":"t","summary":"s","points":[]}') }))
  const llm = buildLlm(cfgNoGroq)
  await llm.summarizeVideo!('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'لخص')
  const part = calls[0].body.contents[0].parts[0]
  assert.deepEqual(part, { file_data: { file_uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
  assert.equal(calls[0].body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW')

  fakeFetch(() => ({ status: 403, body: { error: { message: 'PERMISSION_DENIED: video is private' } } }))
  await assert.rejects(buildLlm(cfgNoGroq).summarizeVideo!('https://www.youtube.com/watch?v=x', 'لخص'), /403.*private/)
})

test('Nvidia أساسي: عند الخطأ ينتقل تلقائياً إلى Gemini', async () => {
  const calls = fakeFetch((url) => url.includes('nvidia.com')
    ? { status: 503, body: { error: 'down' } }
    : { status: 200, body: geminiText('{"actions":[],"reply":"من جيمناي"}') })
  const cfg = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', LLM_PROVIDER: 'nvidia' } as any)
  assert.equal(await buildLlm(cfg).complete('s', 'u'), '{"actions":[],"reply":"من جيمناي"}')
  assert.match(calls[0].url, /integrate\.api\.nvidia\.com\/v1\/chat\/completions/)
  assert.match(calls[1].url, /generativelanguage/)
})

test('Nvidia أساسي: النجاح بدون لمس Gemini', async () => {
  const calls = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: '{"reply":"nv"}' } }] } }))
  const cfg = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', LLM_PROVIDER: 'nvidia' } as any)
  assert.equal(await buildLlm(cfg).complete('s', 'u'), '{"reply":"nv"}')
  assert.equal(calls.length, 1)
})

test('Nvidia أساسي افتراضياً بمجرد وجود مفتاحه + تسجيل المزوّد الفعّال عند الرجوع إلى Gemini', async () => {
  const calls = fakeFetch((url) => url.includes('nvidia.com')
    ? { status: 503, body: { error: 'down' } }
    : { status: 200, body: geminiText('{"reply":"g"}') })
  const cfg = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  assert.equal(cfg.llmProvider, 'nvidia')
  const ctx: any = { purpose: 'chat' }
  await withUsage(ctx, () => buildLlm(cfg).complete('s', 'u'))
  assert.match(calls[0].url, /nvidia\.com/)
  assert.equal(ctx.served.provider, 'gemini')
  assert.equal(ctx.served.fellBack, true)

  const ctx2: any = { purpose: 'chat' }
  fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'x' } }] } }))
  await withUsage(ctx2, () => buildLlm(cfg).complete('s', 'u'))
  assert.equal(ctx2.served.provider, 'nvidia')
  assert.equal(ctx2.served.fellBack, false)
})

test('401 من Nvidia: ننتقل إلى Gemini ولا نكرر محاولة Nvidia خلال فترة التهدئة', async () => {
  const calls = fakeFetch((url) => url.includes('nvidia.com')
    ? { status: 401, body: { error: 'Unauthorized' } }
    : { status: 200, body: geminiText('{"reply":"g"}') })
  const llm = buildLlm(loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'bad' } as any))
  assert.equal(await llm.complete('s', 'u'), '{"reply":"g"}')
  assert.equal(await llm.complete('s', 'u'), '{"reply":"g"}')
  assert.equal(calls.filter((c) => c.url.includes('nvidia.com')).length, 1)
})

test('401 من المزوّد الوحيد: يصعد الخطأ، وGemini 401 لا يجرّب النموذج الاحتياطي بنفس المفتاح', async () => {
  const calls = fakeFetch(() => ({ status: 401, body: { error: 'bad key' } }))
  await assert.rejects(buildLlm(cfgNoGroq).complete('s', 'u'), /401/)
  assert.equal(calls.length, 1)
})

test('isAuthError', () => {
  const e = (status: number, message = '') => Object.assign(new Error(message), { status })
  assert.ok(isAuthError(e(401)) && isAuthError(e(403)) && isAuthError(e(400, 'API key not valid')))
  assert.ok(!isAuthError(e(400, 'bad request')) && !isAuthError(e(429)) && !isAuthError(new Error('x')))
})
