/**
 * النماذج للتقييم — من البيئة:
 *  - fromEnv: نفس سلسلة الإنتاج (buildLlm) إن وُجد أي مفتاح، وإلا null (التقييم يتخطى برسالة واضحة)
 *  - pair: الأساسي (NVIDIA) والاحتياطي (Gemini) كلٌّ منفرداً — للمقارنة، فقط إن وُجد المفتاحان
 *  - scripted: نموذج مبرمج (للاختبارات بلا شبكة)
 */
import { buildLlm, geminiLlm, nvidiaLlm, type LlmClient } from '../ai/providers.js'
import { loadConfig } from '../config.js'
import { buildUnderstandLlm } from '../ai/understand-provider.js'
import { ownerName } from '../profile.js'

export interface NamedLlm { name: string; llm: LlmClient }

export function hasAnyKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.GEMINI_API_KEY || env.NVIDIA_API_KEY || env.GROQ_API_KEY)
}

export function fromEnv(env: NodeJS.ProcessEnv = process.env): NamedLlm | null {
  if (!hasAnyKey(env)) return null
  const cfg = loadConfig(env)
  // نفس ما يفهم به الإنتاج النص: LLM_UNDERSTAND_PROVIDER إن ضُبط
  const und = buildUnderstandLlm(cfg, undefined, env)
  if (und) return { name: und.provider === 'gemini' ? `gemini:${cfg.geminiModel} (understand override)` : `nvidia:${cfg.nvidiaModel} (understand override)`, llm: und.llm }
  const name = cfg.llmProvider === 'nvidia' && cfg.nvidiaApiKey ? `nvidia:${cfg.llmModel || cfg.nvidiaModel} (+fallback)`
    : cfg.llmProvider === 'groq' && cfg.groqApiKey ? `groq:${cfg.llmModel || cfg.groqModel} (+fallback)` : `gemini:${cfg.llmModel || cfg.geminiModel}`
  return { name, llm: buildLlm(cfg) }
}

/** الأساسي مقابل الاحتياطي، كلٌّ بلا سلسلة احتياط (لقياس كل نموذج وحده) */
export function pair(env: NodeJS.ProcessEnv = process.env): { primary: NamedLlm; fallback: NamedLlm } | null {
  if (!env.NVIDIA_API_KEY || !env.GEMINI_API_KEY) return null
  const cfg = loadConfig(env)
  const nvModel = cfg.llmProvider === 'nvidia' && cfg.llmModel ? cfg.llmModel : cfg.nvidiaModel
  return {
    primary: { name: `nvidia:${nvModel}`, llm: nvidiaLlm(cfg.nvidiaApiKey, nvModel, cfg.nvidiaBaseUrl) },
    fallback: { name: `gemini:${cfg.geminiModel}`, llm: { complete: geminiLlm(cfg.geminiApiKey, { primary: cfg.geminiModel }).complete } },
  }
}

/** نموذج مبرمج: رسالة المالك ← JSON جاهز. غير المبرمج يرمي (يظهر كخطأ لا كنجاح) */
export function scripted(map: Record<string, unknown>): LlmClient {
  return {
    async complete(_system, user) {
      const msg = (user.split(`رسالة ${ownerName()} الجديدة:\n`)[1] ?? '').split('\n\nتنبيه:')[0].trim()
      if (!(msg in map)) throw new Error(`لا يوجد رد مبرمج لـ: ${msg.slice(0, 60)}`)
      const v = map[msg]
      return typeof v === 'string' ? v : JSON.stringify(v)
    },
  }
}
