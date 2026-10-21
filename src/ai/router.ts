import type { Config } from '../config.js'
import { logger } from '../logger.js'
import { currentUsage } from '../usage.js'
import { failureReason, geminiLlm, geminiStt, groqLlm, groqStt, nvidiaLlm, shouldFallback, type GeminiModels, type LlmClient, type SttClient } from './providers.js'
import { anthropicLlm } from './anthropic.js'
import { openaiCompatibleLlm } from './openai-compatible.js'
import { ROLES, type ModelsSettings, type ProviderId, type Role } from './roles.js'

export type KeyStatus = { role: Role; provider: ProviderId; hasKey: boolean; fallbackProvider?: ProviderId; fallbackHasKey?: boolean }

export type RouterOpts = {
  /**
   * حصة اليوم: هل خلصت حصة هذا النموذج؟ (QuotaTracker.isExhausted — Gemini فقط).
   * يُطبَّق لكل دور على حدة: الدور الذي أساسيه نموذج Gemini خلصت حصته يذهب لاحتياطه مباشرة؛ بقية الأدوار لا تتأثر.
   */
  isExhausted?: (provider: ProviderId, model: string) => boolean
}

const keyFor = (cfg: Config, p: ProviderId): string =>
  ({ gemini: cfg.geminiApiKey, groq: cfg.groqApiKey, nvidia: cfg.nvidiaApiKey, anthropic: cfg.anthropicApiKey, openai: cfg.openaiApiKey })[p]

/** هل مفتاح هذا المزوّد مضبوط؟ */
export const hasProviderKey = (cfg: Config, p: ProviderId): boolean => !!keyFor(cfg, p)

type Slot = 'primary' | 'fallback'
type Link = { provider: ProviderId; model: () => string; client: LlmClient }
type Method = 'complete' | 'completeWithAudio' | 'completeWithMedia' | 'summarizeVideo' | 'searchWeb'

export function buildRoleClients(cfg: Config, models: () => ModelsSettings, opts: RouterOpts = {}) {
  const exhausted = opts.isExhausted ?? (() => false)
  const lite = cfg.geminiFallbackModel

  /**
   * نماذج Gemini لعميل واحد. withLite (Gemini كاحتياط لمزوّد آخر): يحتفظ بالنموذج الخفيف كاحتياط داخلي
   * كما كانت السلسلة القديمة، وإن خلصت حصة النموذج المطلوب اليوم يذهب للخفيف مباشرة.
   */
  const gemModels = (model: () => string, withLite: boolean): GeminiModels => ({
    get primary() { const m = model(); return withLite && lite && exhausted('gemini', m) ? lite : m },
    get fallback() { return withLite && lite ? lite : undefined },
  })

  /** عميل لكل (دور، خانة، مزوّد) يُبنى مرة واحدة — النموذج يُقرأ عند كل استدعاء (تغيير اللوحة يسري فوراً) */
  const cache = new Map<string, Link | null>()
  function link(role: Role, slot: Slot, p: ProviderId): Link | null {
    const id = `${role}:${slot}:${p}`
    if (cache.has(id)) return cache.get(id)!
    const key = keyFor(cfg, p)
    const model = () => (slot === 'primary' ? models()[role].model : models()[role].fallback?.model ?? '')
    let client: LlmClient | null = null
    if (key) {
      switch (p) {
        case 'gemini': client = geminiLlm(key, gemModels(model, slot === 'fallback')); break
        case 'groq': client = { complete: (s, u) => groqLlm(key, model()).complete(s, u) }; break
        case 'nvidia': client = { complete: (s, u) => nvidiaLlm(key, model(), cfg.nvidiaBaseUrl).complete(s, u) }; break
        case 'anthropic': client = anthropicLlm(key, model); break
        case 'openai': client = openaiCompatibleLlm(cfg.openaiBaseUrl, key, model); break
      }
    }
    const l = client ? { provider: p, model, client } : null
    cache.set(id, l)
    return l
  }

  /**
   * الأساسي ثم الاحتياطي لهذا الدور.
   * - احتياط بمزوّد مختلف: ننتقل عند أي خطأ أو رد فارغ (كالسلسلة القديمة).
   * - احتياط بنفس المزوّد: فقط عند خطأ قابل للاحتياط (429/451/5xx/مهلة) — 400 لا يتكرر.
   * - مفتاح ناقص: الخانة تُتخطّى. حصة الأساسي (Gemini) خالصة اليوم: نبدأ بالاحتياطي مباشرة.
   * عند الرد من احتياط بمزوّد مختلف نضبط served.fellBack + fallbackReason (يظهر للمالك) ونسجّل فشل الأساسي.
   */
  function roleCall(role: Role, method: Method) {
    return async (...args: any[]): Promise<any> => {
      const m = models()[role]
      const p = link(role, 'primary', m.provider)
      const fb = m.fallback ? link(role, 'fallback', m.fallback.provider) : null
      let chain = [p, fb].filter((l): l is Link => !!l && typeof (l.client as any)[method] === 'function')
      if (chain.length > 1 && chain[0] === p && m.provider === 'gemini' && exhausted('gemini', m.model)) chain = chain.slice(1)
      if (!chain.length) throw new Error(`لا يوجد مزوّد متاح للدور ${role} (المفتاح ناقص)`)
      let last: unknown
      let firstFail: { provider: ProviderId; name: string; reason: string } | null = null
      for (const [i, l] of chain.entries()) {
        const next = chain[i + 1]
        const name = `${l.provider}:${l.model()}`
        try {
          const out = await (l.client as any)[method](...args)
          if (next && typeof out === 'string' && !out.trim()) {
            last = new Error(`${name}: رد فارغ`)
            firstFail ??= { provider: l.provider, name, reason: 'رد فارغ' }
            logger.warn(`${role}: رد فارغ من ${name} — ننتقل للاحتياط ${next.provider}`)
            continue
          }
          // احتياط بنفس المزوّد (Gemini flash → lite) ليس «تعثّر النموذج الأساسي» — كما كان قبل الأدوار
          if (i > 0 && firstFail && firstFail.provider !== l.provider) {
            const served = currentUsage().served
            if (served) { served.fellBack = true; served.fallbackReason = `${firstFail.name}: ${firstFail.reason}` }
          }
          return out
        } catch (err) {
          last = err
          if (!next) break
          if (next.provider === l.provider && !shouldFallback(err)) throw err
          firstFail ??= { provider: l.provider, name, reason: failureReason(err) }
          logger.warn({ err: String(err) }, `${role}: فشل ${name} — ننتقل للاحتياط ${next.provider}`)
        }
      }
      throw last
    }
  }

  const llm: LlmClient = {
    complete: roleCall('general', 'complete'),
    completeWithMedia: roleCall('vision', 'completeWithMedia'),
    summarizeVideo: roleCall('video', 'summarizeVideo'),
    searchWeb: roleCall('research', 'searchWeb'),
  }
  const understandLlm: LlmClient = { ...llm, complete: roleCall('understand', 'complete') }
  // الصوت على Groq (Whisper): لا فهم صوتي باستدعاء واحد — المساعد يفرّغ عبر stt ثم يفهم النص.
  // غير ذلك (الافتراضي Gemini): تفريغ + فهم في استدعاء واحد كالسابق. يُقرأ عند كل رسالة.
  const audioCall = roleCall('voice', 'completeWithAudio')
  const sttOnly = () => models().voice.provider === 'groq' && !!cfg.groqApiKey
  for (const c of [llm, understandLlm]) {
    Object.defineProperty(c, 'completeWithAudio', { get: () => (sttOnly() ? undefined : audioCall), enumerable: true })
  }

  /** التفريغ: Groq Whisper إن اختير للصوت (وعند فشله Gemini)، وإلا Gemini مع احتياطه الخفيف */
  const stt: SttClient = {
    async transcribe(b64, mime) {
      const v = models().voice
      const gemFb = v.fallback?.provider === 'gemini' ? v.fallback.model : null
      const viaGemini = () => {
        if (!cfg.geminiApiKey) throw new Error('لا يوجد مزوّد للصوت (GEMINI_API_KEY ناقص)')
        const primary = v.provider === 'gemini' ? v.model : gemFb ?? cfg.sttFallbackModel
        const fallback = (v.provider === 'gemini' ? gemFb : null) || lite || undefined
        return geminiStt(cfg.geminiApiKey, { primary: fallback && exhausted('gemini', primary) ? fallback : primary, fallback }).transcribe(b64, mime)
      }
      if (v.provider === 'groq' && cfg.groqApiKey) {
        try { return await groqStt(cfg.groqApiKey, v.model).transcribe(b64, mime) } catch (err) {
          if (!cfg.geminiApiKey) throw err
          logger.warn({ err: String(err) }, `تفريغ Groq (${v.model}) فشل — ننتقل لـ Gemini`)
          return viaGemini()
        }
      }
      return viaGemini()
    },
  }

  const keyStatus = (): KeyStatus[] => ROLES.map((role) => {
    const m = models()[role]
    return {
      role, provider: m.provider, hasKey: !!keyFor(cfg, m.provider),
      ...(m.fallback ? { fallbackProvider: m.fallback.provider, fallbackHasKey: !!keyFor(cfg, m.fallback.provider) } : {}),
    }
  })

  return { llm, understandLlm, stt, keyStatus }
}
