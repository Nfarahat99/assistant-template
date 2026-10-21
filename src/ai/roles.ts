import { z } from 'zod'
import type { Config } from '../config.js'

export const ROLES = ['understand', 'general', 'voice', 'vision', 'video', 'research'] as const
export type Role = typeof ROLES[number]
export const PROVIDERS = ['gemini', 'groq', 'nvidia', 'anthropic', 'openai'] as const
export type ProviderId = typeof PROVIDERS[number]
export type Capability = 'text' | 'audio' | 'vision' | 'video' | 'search'

export const ROLE_NEEDS: Record<Role, Capability> = {
  understand: 'text', general: 'text', voice: 'audio', vision: 'vision', video: 'video', research: 'search',
}
export const PROVIDER_CAPS: Record<ProviderId, Capability[]> = {
  gemini: ['text', 'audio', 'vision', 'video', 'search'],
  groq: ['text', 'audio'],
  nvidia: ['text'],
  anthropic: ['text', 'vision'],
  openai: ['text'],
}

const MODEL = z.string().trim().regex(/^[A-Za-z0-9._/:-]{3,80}$/, 'اسم نموذج غير صالح')
const Target = z.object({ provider: z.enum(PROVIDERS), model: MODEL })
const RoleModelSchema = Target.extend({ fallback: Target.optional() })
export type RoleModel = z.infer<typeof RoleModelSchema>
export type ModelsSettings = Record<Role, RoleModel>

const capable = (role: Role) => (t: { provider: ProviderId }) => PROVIDER_CAPS[t.provider].includes(ROLE_NEEDS[role])
const forRole = (role: Role) => RoleModelSchema.refine((v) => capable(role)(v) && (!v.fallback || capable(role)(v.fallback)), {
  message: `${role}: المزوّد ما يدعم ${ROLE_NEEDS[role]}`,
}).optional()

export const ModelsPatchSchema = z.object({
  understand: forRole('understand'),
  general: forRole('general'),
  voice: forRole('voice'),
  vision: forRole('vision'),
  video: forRole('video'),
  research: forRole('research'),
}).strict()

export function defaultModels(cfg: Config, legacy?: { llm_model?: string; llm_fallback_model?: string }): ModelsSettings {
  // llm_model القديم من اللوحة كان نموذج مزوّد LLM_PROVIDER: إن لم يكن Gemini فهو نموذج nvidia/groq لا يُرسل لأدوار Gemini
  const legacyModel = legacy?.llm_model?.trim() || ''
  const legacyGemini = /gemini/i.test(legacyModel) ? legacyModel : ''
  const legacyOther = legacyModel && !legacyGemini ? legacyModel : ''
  const main = legacyGemini || (cfg.llmProvider === 'gemini' && cfg.llmModel) || cfg.geminiModel
  const fb = legacy?.llm_fallback_model ?? cfg.geminiFallbackModel
  const gem = (model: string): RoleModel => ({ provider: 'gemini', model, ...(fb ? { fallback: { provider: 'gemini', model: fb } } : {}) })
  // LLM_PROVIDER=nvidia|groq القديم (مع مفتاحه): الفهم والمعرفة العامة على ذلك المزوّد وGemini احتياط — كما كانت السلسلة
  // احتياط Gemini لمزوّد آخر = نفس نموذج Gemini الذي كانت السلسلة القديمة تستخدمه (llm_model من اللوحة أو GEMINI_MODEL)
  const text = (): RoleModel =>
    cfg.llmProvider === 'nvidia' && cfg.nvidiaApiKey ? { provider: 'nvidia', model: legacyOther || cfg.llmModel || cfg.nvidiaModel, fallback: { provider: 'gemini', model: main } }
    : cfg.llmProvider === 'groq' && cfg.groqApiKey ? { provider: 'groq', model: legacyOther || cfg.llmModel || cfg.groqModel, fallback: { provider: 'gemini', model: main } }
    : gem(main)
  // LLM_UNDERSTAND_PROVIDER=gemini|nvidia القديم: خطوة الفهم وحدها على مزوّد آخر (نفس شروط buildUnderstandLlm: مزوّد مختلف + مفتاحه موجود)
  const up = cfg.understandProvider
  const understand = (): RoleModel =>
    up === 'gemini' && cfg.llmProvider !== 'gemini' && cfg.geminiApiKey ? gem(/gemini/i.test(main) ? main : cfg.geminiModel)
    : up === 'nvidia' && cfg.llmProvider !== 'nvidia' && cfg.nvidiaApiKey ? { provider: 'nvidia', model: cfg.nvidiaModel, fallback: { provider: 'gemini', model: main } }
    : text()
  return {
    understand: understand(), general: text(), voice: gem(cfg.sttFallbackModel),
    vision: gem(main), video: gem(main), research: gem(main),
  }
}
