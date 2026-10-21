import type { Config } from '../config.js'
import { logger } from '../logger.js'
import { recordUsage, currentUsage, type UsageEvent } from '../usage.js'

/** يقيس الاستدعاء ويسجّل الاستهلاك — نجاحاً أو فشلاً */
export async function metered<T>(provider: UsageEvent['provider'], model: string, fn: () => Promise<{ value: T; input_tokens?: number; output_tokens?: number }>): Promise<T> {
  const t0 = Date.now()
  try {
    const r = await fn()
    recordUsage({ provider, model, input_tokens: r.input_tokens ?? 0, output_tokens: r.output_tokens ?? 0, latency_ms: Date.now() - t0, ok: true })
    const ctx = currentUsage()
    ctx.served = { provider, model, fellBack: ctx.served?.fellBack ?? false }
    return r.value
  } catch (err) {
    recordUsage({ provider, model, input_tokens: 0, output_tokens: 0, latency_ms: Date.now() - t0, ok: false, error: String((err as any)?.message ?? err).slice(0, 300) })
    throw err
  }
}
import { parseGrounded, type GroundedResponse } from './websearch.js'

/**
 * عملاء المزوّدين المجانيين — fetch مباشر بلا SDK (اعتماديات أقل).
 * Groq   : واجهة متوافقة مع OpenAI — https://api.groq.com/openai/v1
 * Gemini : Google AI Studio — generativelanguage.googleapis.com/v1beta
 */

export interface SttClient { transcribe(base64: string, mimetype: string): Promise<string> }
export interface LlmClient {
  complete(system: string, user: string): Promise<string>
  /** اختياري: فهم رسالة صوتية مباشرة (بدون تفريغ منفصل) */
  completeWithAudio?(system: string, user: string, audio: { base64: string; mimetype: string }): Promise<string>
  /** اختياري: نص + وسائط (صورة لقطة شاشة مثلاً) — Gemini فقط */
  completeWithMedia?(system: string, user: string, media: { base64: string; mimetype: string }): Promise<string>
  /** اختياري: فهم فيديو يوتيوب عام برابطه (Gemini فقط) — يرجع نص الرد (JSON حسب التعليمات) */
  summarizeVideo?(url: string, instruction: string): Promise<string>
  /** اختياري: بحث ويب مؤسَّس على Google Search (Gemini) — يرجع النص والمصادر الحقيقية */
  searchWeb?(prompt: string): Promise<GroundedResponse>
}

const GROQ = 'https://api.groq.com/openai/v1'
const NVIDIA = 'https://integrate.api.nvidia.com/v1'
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'

/** خطأ HTTP يحمل الحالة — لنقرر هل نجرب النموذج الاحتياطي أو نعتبره خطأ مصادقة */
export class HttpError extends Error {
  constructor(msg: string, public status: number) { super(msg) }
}

async function asError(res: Response, who: string): Promise<HttpError> {
  const body = await res.text().catch(() => '')
  return new HttpError(`${who} HTTP ${res.status}: ${body.slice(0, 300)}`, res.status)
}

/** مفتاح مرفوض/منتهٍ: 401/403، أو 400 من Gemini برسالة API key not valid */
export function isAuthError(err: unknown): boolean {
  const s = (err as any)?.status
  if (s === 401 || s === 403) return true
  return s === 400 && /api[_ ]?key (not valid|invalid)|API_KEY_INVALID/i.test(String((err as any)?.message ?? ''))
}

/** بعد خطأ مصادقة لا نكرر الاستدعاء الفاشل لهذا المزوّد خلال هذه المدة */
const AUTH_COOLDOWN_MS = 10 * 60_000

function extFor(mime: string): string {
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  return 'ogg'
}

// ─────────────── Groq ───────────────

export function groqStt(apiKey: string, model: string): SttClient {
  return {
    async transcribe(base64, mimetype) {
      const mime = mimetype.split(';')[0].trim() || 'audio/ogg'
      const form = new FormData()
      form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), `voice.${extFor(mime)}`)
      form.append('model', model)
      form.append('language', 'ar')
      form.append('response_format', 'json')
      form.append('temperature', '0')
      return metered('groq', model, async () => {
        const res = await fetch(`${GROQ}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw await asError(res, 'Groq STT')
        const j = (await res.json()) as { text?: string }
        return { value: (j.text || '').trim() }
      })
    },
  }
}

export function groqLlm(apiKey: string, model: string): LlmClient {
  return {
    async complete(system, user) {
      return metered('groq', model, async () => {
      const res = await fetch(`${GROQ}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw await asError(res, 'Groq LLM')
      const j = (await res.json()) as any
      return { value: String(j.choices?.[0]?.message?.content ?? ''), input_tokens: j.usage?.prompt_tokens, output_tokens: j.usage?.completion_tokens }
      })
    },
  }
}

// ─────────────── Nvidia (build.nvidia.com — واجهة متوافقة مع OpenAI) ───────────────

export function nvidiaLlm(apiKey: string, model: string, baseUrl = NVIDIA): LlmClient {
  return {
    async complete(system, user) {
      return metered('nvidia', model, async () => {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            top_p: 0.7,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw await asError(res, 'Nvidia LLM')
        const j = (await res.json()) as any
        return { value: String(j.choices?.[0]?.message?.content ?? '').trim(), input_tokens: j.usage?.prompt_tokens, output_tokens: j.usage?.completion_tokens }
      })
    },
  }
}

// ─────────────── Gemini ───────────────

async function geminiOnce(apiKey: string, model: string, body: unknown, timeoutMs = 90_000): Promise<string> {
  return metered('gemini', model, async () => {
  const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const e = await asError(res, `Gemini ${model}`)
    throw new HttpError(e.message, res.status)
  }
  const j = (await res.json()) as any
  const parts = j.candidates?.[0]?.content?.parts ?? []
  // usageMetadata: promptTokenCount (يشمل الصوت/الصورة) و candidatesTokenCount (+ thoughtsTokenCount إن وُجد)
  const um = j.usageMetadata ?? {}
  return {
    value: parts.map((p: any) => p.text ?? '').join('').trim() as string,
    input_tokens: um.promptTokenCount ?? 0,
    output_tokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
  }
  })
}

/** عند 429 (نفاد الحصة المجانية) أو 5xx ننتقل لنموذج أخف (flash-lite) بحصة مستقلة؛ و451 = رفض المزوّد للمحتوى → المزوّد التالي */
export function shouldFallback(err: unknown): boolean {
  const s = (err as any)?.status
  return s === 429 || s === 451 || (typeof s === 'number' && s >= 500) || (err as any)?.name === 'TimeoutError'
}

export interface GeminiModels { primary: string; fallback?: string }

async function geminiGenerate(apiKey: string, models: GeminiModels, body: unknown, timeoutMs?: number): Promise<string> {
  try {
    return await geminiOnce(apiKey, models.primary, body, timeoutMs)
  } catch (err) {
    if (!models.fallback || models.fallback === models.primary || !shouldFallback(err)) throw err
    logger.warn({ err: String(err) }, `Gemini ${models.primary} مشغول/نفدت حصته — نجرب ${models.fallback}`)
    return geminiOnce(apiKey, models.fallback, body, timeoutMs)
  }
}

/** استدعاء يعيد JSON الخام (للبحث المؤسَّس) — نفس سياسة الاحتياط عند 429/5xx */
async function geminiRaw(apiKey: string, models: GeminiModels, body: unknown, timeoutMs = 90_000): Promise<any> {
  const once = (model: string) => metered<any>('gemini', model, async () => {
    const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) { const e = await asError(res, `Gemini ${model}`); throw new HttpError(e.message, res.status) }
    const j = (await res.json()) as any
    const um = j.usageMetadata ?? {}
    return { value: j, input_tokens: um.promptTokenCount ?? 0, output_tokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0) }
  })
  try { return await once(models.primary) } catch (err) {
    if (!models.fallback || models.fallback === models.primary || !shouldFallback(err)) throw err
    logger.warn({ err: String(err) }, `Gemini ${models.primary} (بحث) — نجرب ${models.fallback}`)
    return once(models.fallback)
  }
}

const cleanMime = (m: string) => m.split(';')[0].trim() || 'audio/ogg'

export const TRANSCRIBE_INSTRUCTION =
  'فرّغ هذا التسجيل الصوتي حرفياً بالعربية كما قيل (لهجة سعودية غالباً) — بدون تصحيح ولا تلخيص ولا ترجمة. أعد النص فقط بلا أي تعليق.'

export function geminiStt(apiKey: string, models: GeminiModels): SttClient {
  return {
    async transcribe(base64, mimetype) {
      return geminiGenerate(apiKey, models, {
        contents: [{
          role: 'user',
          parts: [{ text: TRANSCRIBE_INSTRUCTION }, { inline_data: { mime_type: cleanMime(mimetype), data: base64 } }],
        }],
        generationConfig: { temperature: 0 },
      })
    },
  }
}

export function geminiLlm(apiKey: string, models: GeminiModels): LlmClient {
  return {
    async complete(system, user) {
      return geminiGenerate(apiKey, models, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      })
    },
    /**
     * يوتيوب: generateContent مع file_data {file_uri: <رابط يوتيوب>}؛ إن رُفض (400) نجرب Interactions API
     * بالشكل الموثّق حالياً {"type":"video","uri":...}. فيديوهات عامة فقط، وحد مجاني ٨ ساعات فيديو/يوم.
     */
    async summarizeVideo(url, instruction) {
      try {
        return await geminiGenerate(apiKey, models, {
          // الشكل الموثّق لروابط يوتيوب: file_uri فقط بلا mime_type (mime_type:'video/*' كان يُرفض 400)
          // https://ai.google.dev/gemini-api/docs/generate-content/video-understanding
          contents: [{ role: 'user', parts: [{ file_data: { file_uri: url } }, { text: instruction }] }],
          // دقة منخفضة: ~٧٠ توكن للإطار بدل ٢٥٨ — أسرع وأرخص بكثير، وكافية للتلخيص
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_LOW', maxOutputTokens: 1200 },
        }, VIDEO_TIMEOUT_MS)
      } catch (err) {
        if ((err as any)?.status !== 400) throw err
        logger.warn({ err: String(err) }, 'generateContent رفض رابط يوتيوب — نجرب Interactions API')
        const res = await fetch(`${GEMINI}/interactions`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: models.primary, input: [{ type: 'text', text: instruction }, { type: 'video', uri: url }] }),
          signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
        })
        if (!res.ok) throw new HttpError(`Gemini interactions ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
        return extractInteractionText(await res.json())
      }
    },
    /** بحث ويب: أداة google_search — الروابط من groundingMetadata فقط */
    async searchWeb(prompt) {
      return parseGrounded(await geminiRaw(apiKey, models, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
      }, 120_000))
    },
    /** نص + صورة/وسائط، والرد JSON */
    async completeWithMedia(system, user, media) {
      return geminiGenerate(apiKey, models, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }, { inline_data: { mime_type: media.mimetype.split(';')[0].trim(), data: media.base64 } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      })
    },
    /** تفريغ + فهم في استدعاء واحد: الصوت مرفق مع السياق، والرد JSON فيه transcript */
    async completeWithAudio(system, user, audio) {
      return geminiGenerate(apiKey, models, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [{ text: user }, { inline_data: { mime_type: cleanMime(audio.mimetype), data: audio.base64 } }],
        }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      })
    },
  }
}

/** الفيديو أبطأ بكثير من النص — مهلة مستقلة */
export const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 150_000)

/** نص الرد من استجابة Interactions API (الشكل قد يختلف — نقرأ دفاعياً) */
export function extractInteractionText(j: any): string {
  if (typeof j?.output_text === 'string') return j.output_text
  const outs = j?.outputs ?? j?.output ?? []
  const texts: string[] = []
  const walk = (x: any) => {
    if (!x) return
    if (Array.isArray(x)) return x.forEach(walk)
    if (typeof x.text === 'string') texts.push(x.text)
    if (x.content) walk(x.content)
    if (x.parts) walk(x.parts)
  }
  walk(outs)
  return texts.join('').trim()
}

// ─────────────── سلسلة احتياط ───────────────

/** سبب فشل مختصر وصادق للمالك (الحالة + أول جزء من التفاصيل) — بلا تخمين */
export function failureReason(err: unknown): string {
  const s = String((err as any)?.message ?? err)
  const status: number | null = (err as any)?.status ?? (Number(/HTTP (\d{3})/.exec(s)?.[1]) || null)
  const detail = /"detail"\s*:\s*"([^"]{0,160})/.exec(s)?.[1] ?? /"message"\s*:\s*"([^"]{0,160})/.exec(s)?.[1] ?? s.slice(0, 160)
  const hint = status === 410 ? 'النموذج انتهى دعمه' : status === 404 ? 'النموذج غير متاح لحسابك' : status === 401 || status === 403 ? 'المفتاح مرفوض' : status === 429 ? 'تجاوز حد الاستخدام' : null
  return [hint, status ? `(${status})` : null, detail].filter(Boolean).join(' ').slice(0, 220)
}

/** يجرّب كل عميل بالترتيب — أول نجاح يكسب */
function chain<T extends object, A>(label: string, items: { name: string; client: T }[], call: (c: T, arg: A) => Promise<string>) {
  const authFailedAt = new Map<string, number>()
  return async (arg: A) => {
    let last: unknown
    let firstFail: { name: string; reason: string } | null = null
    for (const [i, { name, client }] of items.entries()) {
      const failedAt = authFailedAt.get(name)
      // مفتاح مرفوض سابقاً: نتخطاه مؤقتاً ما دام هناك مزوّد بعده
      if (failedAt && Date.now() - failedAt < AUTH_COOLDOWN_MS && i < items.length - 1) continue
      try {
        const out = await call(client, arg)
        if (out) {
          const served = currentUsage().served
          if (served && i > 0) { served.fellBack = true; served.fallbackReason = firstFail ? `${firstFail.name}: ${firstFail.reason}` : undefined }
          return out
        }
        last = new Error(`${name}: رد فارغ`)
      } catch (err) {
        last = err
        firstFail ??= { name, reason: failureReason(err) }
        if (isAuthError(err)) {
          authFailedAt.set(name, Date.now())
          logger.error({ err: String(err) }, `${label}: مفتاح ${name} مرفوض (مصادقة ${(err as any).status}) — تحقق من المفتاح؛ ننتقل للاحتياط`)
          continue
        }
        logger.warn({ err: String(err) }, `${label}: فشل ${name}${items.length > 1 ? ' — ننتقل للاحتياط' : ''}`)
      }
    }
    throw last ?? new Error(`${label}: لا يوجد مزوّد مهيّأ`)
  }
}

/** Groq اختياري تماماً (غير متاح من السعودية): بدونه يذهب كل شيء لـ Gemini مباشرة */
export function buildStt(cfg: Config): SttClient {
  const items: { name: string; client: SttClient }[] = []
  if (cfg.groqApiKey) items.push({ name: `groq:${cfg.sttModel}`, client: groqStt(cfg.groqApiKey, cfg.sttModel) })
  if (cfg.geminiApiKey) {
    items.push({ name: `gemini:${cfg.sttFallbackModel}`,
      client: geminiStt(cfg.geminiApiKey, { primary: cfg.sttFallbackModel, fallback: cfg.geminiFallbackModel }) })
  }
  const run = chain('STT', items, (c, a: [string, string]) => c.transcribe(a[0], a[1]))
  return { transcribe: (b, m) => run([b, m]) }
}

/**
 * dyn: إعدادات وقت التشغيل من اللوحة (llm_model / llm_fallback_model) — تُقرأ في كل استدعاء.
 * useFallbackOnly: حين تخلص حصة الأساسي اليوم نذهب للاحتياطي مباشرة بلا محاولة فاشلة.
 */
export function buildLlm(cfg: Config, dyn?: () => { model?: string | null; fallback?: string | null; useFallbackOnly?: boolean }): LlmClient {
  const base = cfg.llmProvider === 'gemini' && cfg.llmModel ? cfg.llmModel : cfg.geminiModel
  const gemModels: GeminiModels = {
    get primary() {
      const d = dyn?.()
      const fb = d?.fallback || cfg.geminiFallbackModel
      return d?.useFallbackOnly && fb ? fb : d?.model || base
    },
    get fallback() { return dyn?.().fallback || cfg.geminiFallbackModel },
  }
  const gemClient = cfg.geminiApiKey ? geminiLlm(cfg.geminiApiKey, gemModels) : null
  const gem = gemClient ? { name: 'gemini', client: gemClient } : null
  const grq = cfg.groqApiKey
    ? { name: 'groq', client: groqLlm(cfg.groqApiKey, cfg.llmProvider === 'groq' && cfg.llmModel ? cfg.llmModel : cfg.groqModel) }
    : null
  const nv = cfg.nvidiaApiKey
    ? { name: 'nvidia', client: nvidiaLlm(cfg.nvidiaApiKey, cfg.llmProvider === 'nvidia' && cfg.llmModel ? cfg.llmModel : cfg.nvidiaModel, cfg.nvidiaBaseUrl) }
    : null
  // Nvidia أساسي فقط إن طُلب صراحة (LLM_PROVIDER=nvidia) — وعند أي خطأ/توقف ننتقل تلقائياً إلى Gemini
  const order = cfg.llmProvider === 'nvidia' ? [nv, gem, grq] : cfg.llmProvider === 'groq' ? [grq, gem, nv] : [gem, grq, nv]
  const items = order.filter((x): x is NonNullable<typeof x> => !!x)
  const run = chain('LLM', items, (c, a: [string, string]) => c.complete(a[0], a[1]))
  const client: LlmClient = { complete: (s, u) => run([s, u]) }
  // الصوت/الوسائط/الفيديو/البحث: Gemini فقط. الفهم النصي يمر عبر السلسلة.
  // بدون Groq: الصوتية تُفرّغ وتُفهم في استدعاء Gemini واحد (نصف الزمن والحصة)
  if (!cfg.groqApiKey && gemClient?.completeWithAudio) client.completeWithAudio = gemClient.completeWithAudio
  // قراءة لقطات الشاشة تحتاج رؤية — Gemini دائماً إن وُجد مفتاحه
  if (gemClient?.completeWithMedia) client.completeWithMedia = gemClient.completeWithMedia
  if (gemClient?.summarizeVideo) client.summarizeVideo = gemClient.summarizeVideo
  if (gemClient?.searchWeb) client.searchWeb = gemClient.searchWeb
  return client
}
