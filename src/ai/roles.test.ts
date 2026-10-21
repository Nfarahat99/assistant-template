import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../config.js'
import { defaultModels, ModelsPatchSchema } from './roles.js'
import { Settings } from '../settings.js'

const cfg = loadConfig({ GEMINI_API_KEY: 'g' } as any)

test('defaults mirror today: gemini everywhere, flash primary + lite fallback', () => {
  const m = defaultModels(cfg)
  for (const r of ['understand', 'general', 'voice', 'vision', 'video', 'research'] as const) assert.equal(m[r].provider, 'gemini')
  assert.equal(m.general.model, 'gemini-3.8-flash')
  assert.deepEqual(m.general.fallback, { provider: 'gemini', model: 'gemini-3.5-flash-lite' })
})

test('legacy llm_model / llm_fallback_model migrate into general + understand', () => {
  const m = defaultModels(cfg, { llm_model: 'gemini-x', llm_fallback_model: 'gemini-y' })
  assert.equal(m.general.model, 'gemini-x')
  assert.equal(m.understand.model, 'gemini-x')
  assert.equal(m.general.fallback?.model, 'gemini-y')
})

test('legacy LLM_PROVIDER=nvidia maps understand + general to nvidia with gemini fallback', () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'n' } as any)
  const m = defaultModels(nv)
  for (const r of ['understand', 'general'] as const) {
    assert.deepEqual(m[r], { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } })
  }
  for (const r of ['voice', 'vision', 'video', 'research'] as const) assert.equal(m[r].provider, 'gemini')
  assert.equal(defaultModels(loadConfig({ GEMINI_API_KEY: 'g', LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'n', LLM_MODEL: 'nv/x' } as any)).general.model, 'nv/x')
})

test('legacy non-Gemini llm_model (dashboard NVIDIA choice) stays on NVIDIA; Gemini roles keep the Gemini model', () => {
  const nv = loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n' } as any)
  const m = defaultModels(nv, { llm_model: 'nvidia/x', llm_fallback_model: 'gemini-3.5-flash-lite' })
  for (const r of ['understand', 'general'] as const) {
    assert.deepEqual(m[r], { provider: 'nvidia', model: 'nvidia/x', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } })
  }
  for (const r of ['vision', 'video', 'research'] as const) {
    assert.deepEqual(m[r], { provider: 'gemini', model: 'gemini-3.8-flash', fallback: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } })
  }
  assert.equal(m.voice.provider, 'gemini')
  // groq بنفس المنطق
  const gq = defaultModels(loadConfig({ GEMINI_API_KEY: 'g', LLM_PROVIDER: 'groq', GROQ_API_KEY: 'q' } as any), { llm_model: 'llama-x' })
  assert.equal(gq.general.model, 'llama-x')
  assert.equal(gq.general.fallback?.model, 'gemini-3.8-flash')
  assert.equal(gq.vision.model, 'gemini-3.8-flash')
  // Gemini فقط + نموذج غير Gemini محفوظ: لا يُرسل لـ Gemini
  assert.equal(defaultModels(cfg, { llm_model: 'nvidia/x' }).general.model, 'gemini-3.8-flash')
})

test('legacy LLM_PROVIDER=groq maps understand + general to groq with gemini fallback', () => {
  const m = defaultModels(loadConfig({ GEMINI_API_KEY: 'g', LLM_PROVIDER: 'groq', GROQ_API_KEY: 'q' } as any))
  assert.deepEqual(m.general, { provider: 'groq', model: 'openai/gpt-oss-120b', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } })
  assert.equal(m.understand.provider, 'groq')
  assert.equal(m.voice.provider, 'gemini')
})

test('LLM_PROVIDER=nvidia without NVIDIA_API_KEY stays on gemini', () => {
  const m = defaultModels(loadConfig({ GEMINI_API_KEY: 'g', LLM_PROVIDER: 'nvidia' } as any))
  assert.equal(m.general.provider, 'gemini')
})

test('legacy LLM_UNDERSTAND_PROVIDER maps the understand role only', () => {
  const nvU = defaultModels(loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', LLM_PROVIDER: 'gemini', LLM_UNDERSTAND_PROVIDER: 'nvidia' } as any))
  assert.deepEqual(nvU.understand, { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } })
  assert.equal(nvU.general.provider, 'gemini')

  const gemU = defaultModels(loadConfig({ GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', LLM_UNDERSTAND_PROVIDER: 'gemini' } as any))
  assert.deepEqual(gemU.understand, { provider: 'gemini', model: 'gemini-3.8-flash', fallback: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } })
  assert.equal(gemU.general.provider, 'nvidia')

  // بلا مفتاح المزوّد: تجاهل (كما كان buildUnderstandLlm)
  assert.equal(defaultModels(loadConfig({ GEMINI_API_KEY: 'g', LLM_UNDERSTAND_PROVIDER: 'nvidia' } as any)).understand.provider, 'gemini')
  assert.equal(loadConfig({ LLM_UNDERSTAND_PROVIDER: 'openai' } as any).understandProvider, null)
})

test('patch rejects a provider without the role capability', () => {
  const r = ModelsPatchSchema.safeParse({ voice: { provider: 'anthropic', model: 'claude-opus-5-5' } })
  assert.equal(r.success, false)
  assert.match(JSON.stringify(r.error!.issues), /voice/)
})

test('patch accepts anthropic for understand and general', () => {
  const r = ModelsPatchSchema.safeParse({ understand: { provider: 'anthropic', model: 'claude-opus-5-5' }, general: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } })
  assert.equal(r.success, true)
})

test('settings.update persists models and get() returns them', async () => {
  const s = new Settings(cfg, null)
  const r = await s.update({ models: { understand: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
  assert.equal(r.ok, true)
  assert.equal(s.get().models.understand.provider, 'anthropic')
  assert.equal(s.get().models.general.provider, 'gemini')
})

test('settings.update rejects voice → anthropic with a 400-style error naming the role', async () => {
  const s = new Settings(cfg, null)
  const r = await s.update({ models: { voice: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /voice/)
})

test('legacy llm_model PUT only syncs roles whose provider is gemini', async () => {
  const s = new Settings(cfg, null)
  await s.update({ models: { understand: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
  const r = await s.update({ llm_model: 'gemini-x' })
  assert.equal(r.ok, true)
  assert.deepEqual(s.get().models.understand, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(s.get().models.general.provider, 'gemini')
  assert.equal(s.get().models.general.model, 'gemini-x')
  assert.equal(s.get().llm_model, 'gemini-x')
})

test('legacy llm_fallback_model PUT only syncs gemini fallbacks', async () => {
  const s = new Settings(cfg, null)
  await s.update({ models: { understand: { provider: 'gemini', model: 'gemini-3.8-flash', fallback: { provider: 'anthropic', model: 'claude-haiku-5-5' } } } })
  const r = await s.update({ llm_fallback_model: 'gemini-y' })
  assert.equal(r.ok, true)
  assert.deepEqual(s.get().models.understand.fallback, { provider: 'anthropic', model: 'claude-haiku-5-5' })
  assert.deepEqual(s.get().models.general.fallback, { provider: 'gemini', model: 'gemini-y' })
  // a role with no fallback does not gain one
  await s.update({ models: { general: { provider: 'gemini', model: 'gemini-3.8-flash' } } })
  await s.update({ llm_fallback_model: 'gemini-z' })
  assert.equal(s.get().models.general.fallback, undefined)
})
