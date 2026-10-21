import { buildLlm, type LlmClient } from './providers.js'
import { understandProviderFromEnv, type UnderstandProvider, type loadConfig } from '../config.js'
import { logger } from '../logger.js'

type Config = ReturnType<typeof loadConfig>
type Dyn = () => { model?: string | null; fallback?: string | null; useFallbackOnly?: boolean }
// المحلّل يعيش في config (مصدر واحد) — يُعاد تصديره هنا للتوافق
export { understandProviderFromEnv, type UnderstandProvider }

/**
 * نموذج خاص بخطوة الفهم النصي (understand) فقط — يُبدَّل بمتغير واحد إن وافق المالك
 * (تقييم عمر: Gemini أفضل في الإحالات السياقية على النص). بقية الخطوات (المعرفة العامة، التقارير…) والصوت لا تتغير.
 * null = لا تغيير: نفس سلسلة LLM_PROVIDER الحالية.
 */
export function buildUnderstandLlm(cfg: Config, dyn?: Dyn, env: NodeJS.ProcessEnv = process.env): { llm: LlmClient; provider: UnderstandProvider } | null {
  const p = understandProviderFromEnv(env)
  if (!p || p === cfg.llmProvider) return null
  if (p === 'gemini' && !cfg.geminiApiKey) { logger.warn('LLM_UNDERSTAND_PROVIDER=gemini بلا GEMINI_API_KEY — تجاهل'); return null }
  if (p === 'nvidia' && !cfg.nvidiaApiKey) { logger.warn('LLM_UNDERSTAND_PROVIDER=nvidia بلا NVIDIA_API_KEY — تجاهل'); return null }
  // LLM_MODEL يخص المزوّد الأساسي القديم — لا يُمرَّر لمزوّد آخر
  const c: Config = { ...cfg, llmProvider: p, llmModel: '' }
  // llm_model من اللوحة قد يكون اسم نموذج NVIDIA — لا يُعطى لـ Gemini
  const d: Dyn | undefined = dyn && p === 'gemini'
    ? () => { const x = dyn(); return { ...x, model: x.model && /gemini/i.test(x.model) ? x.model : null } }
    : dyn
  logger.info(`خطوة الفهم النصي على ${p} (LLM_UNDERSTAND_PROVIDER) — بقية الخطوات على ${cfg.llmProvider}`)
  return { llm: buildLlm(c, d), provider: p }
}
