import { z } from 'zod'
import type { Config } from './config.js'
import type { Store } from './store.js'
import { defaultModels, ModelsPatchSchema, type ModelsSettings } from './ai/roles.js'

/**
 * إعدادات وقت التشغيل — تعلو على البيئة وتُعدَّل من لوحة التحكم (kv: settings).
 * كل مفتاح هنا مربوط فعلاً بسلوك في البوت (لا مفاتيح شكلية).
 */
const HHMM = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'الوقت بصيغة HH:MM')
const MODEL = z.string().trim().regex(/^[A-Za-z0-9._/-]{3,80}$/, 'اسم نموذج غير صالح')

export const FeaturesSchema = z.object({
  voice: z.boolean(),
  reminders: z.boolean(),
  briefs: z.boolean(),
  youtube: z.boolean(),
  third_party_replies: z.boolean(),
  code_changes: z.boolean(),
  web_research: z.boolean(),
  ai_news_digest: z.boolean(),
  /** الوصول لقواعد بيانات المشاريع (قراءة + تعديل بموافقة) */
  db_access: z.boolean(),
  /** موجز المشاريع اليومي (بزنس) — والأحد أسبوعي أوفى */
  project_status_daily: z.boolean(),
  /** تقرير الإنتاجية الأسبوعي (الجمعة) */
  weekly_insights: z.boolean(),
  /** تذكيرات الورد القرآني بأوقات عشوائية متفرقة خلال اليوم */
  quran_wird: z.boolean(),
  /** المراجعة الذاتية الليلية: كشف التعثّرات + حالات تقييم + اقتراح إصلاحات (بموافقة) */
  self_review: z.boolean(),
})
export type Features = z.infer<typeof FeaturesSchema>

export interface RuntimeSettings {
  features: Features
  models: ModelsSettings
  morning_brief_at: string
  evening_review_at: string
  ai_news_at: string
  send_mode: 'link' | 'direct'
  owner_signature: string
  llm_model: string
  llm_fallback_model: string
  project_status_at: string
  weekly_insights_at: string
  wird_count: number
  wird_from: string
  wird_to: string
  self_review_at: string
  /**
   * قناة الرسائل الاستباقية (تذكيرات، ورد، ملخصات): auto = آخر قناة راسلني منها المالك (افتراضياً واتساب)،
   * أو قناة ثابتة. الأخرى احتياط تلقائي إن تعذّرت.
   */
  primary_channel: 'auto' | 'whatsapp' | 'telegram'
}

/** PUT جزئي — كل الحقول اختيارية؛ direct يتطلب confirm_direct: true صراحةً */
export const SettingsPatchSchema = z.object({
  features: FeaturesSchema.partial().strict().optional(),
  models: ModelsPatchSchema.optional(),
  morning_brief_at: HHMM.optional(),
  evening_review_at: HHMM.optional(),
  ai_news_at: HHMM.optional(),
  send_mode: z.enum(['link', 'direct']).optional(),
  confirm_direct: z.boolean().optional(),
  owner_signature: z.string().max(80).optional(),
  llm_model: MODEL.optional(),
  llm_fallback_model: z.union([MODEL, z.literal('')]).optional(),
  project_status_at: HHMM.optional(),
  weekly_insights_at: HHMM.optional(),
  wird_count: z.number().int().min(1).max(10).optional(),
  wird_from: HHMM.optional(),
  wird_to: HHMM.optional(),
  self_review_at: HHMM.optional(),
  primary_channel: z.enum(['auto', 'whatsapp', 'telegram']).optional(),
}).strict().refine((p) => p.send_mode !== 'direct' || p.confirm_direct === true, {
  message: 'الإرسال المباشر يعرّض الرقم للحظر — يلزم confirm_direct: true للتأكيد',
  path: ['send_mode'],
})

const pad = (t: { h: number; m: number }) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`

export function defaultsFromConfig(cfg: Config): RuntimeSettings {
  return {
    features: { voice: true, reminders: true, briefs: true, youtube: true, third_party_replies: true, code_changes: true, web_research: true, ai_news_digest: false, db_access: false, project_status_daily: false, weekly_insights: false, quran_wird: false, self_review: false },
    models: defaultModels(cfg),
    morning_brief_at: pad(cfg.morningBriefAt),
    evening_review_at: pad(cfg.eveningReviewAt),
    ai_news_at: '18:00',
    send_mode: cfg.thirdPartySendMode,
    owner_signature: cfg.ownerSignature,
    llm_model: cfg.llmModel || cfg.geminiModel,
    llm_fallback_model: cfg.geminiFallbackModel,
    project_status_at: '09:00',
    weekly_insights_at: '17:00',
    wird_count: 3,
    wird_from: '08:00',
    wird_to: '21:00',
    self_review_at: '23:30',
    primary_channel: 'auto',
  }
}

/** آخر نسخة Settings أُنشئت (نسخة التشغيل) — لـ getSetting() من أي مكان دون تمرير الكائن */
let active: Settings | null = null

/**
 * قراءة إعداد واحد من أي وحدة: getSetting('send_mode')، getSetting('features').web_research
 * قبل إنشاء Settings (أو في اختبار معزول) ترجع null.
 */
export function getSetting<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] | null {
  return active ? active.get()[key] : null
}

export class Settings {
  private current: RuntimeSettings

  constructor(private cfg: Config, private store: Store | null = null) {
    this.current = defaultsFromConfig(cfg)
    active = this
  }

  /** يدمج المحفوظ في القاعدة فوق الافتراضي — القيم غير الصالحة تُتجاهل */
  async load() {
    if (!this.store) return
    const raw = await this.store.getKv('settings')
    if (!raw) return
    try {
      const saved = JSON.parse(raw)
      if (!saved.models && saved.llm_model) saved.models = defaultModels(this.cfg, { llm_model: saved.llm_model, llm_fallback_model: saved.llm_fallback_model })
      const d = defaultsFromConfig(this.cfg)
      const p = SettingsPatchSchema.safeParse({ ...saved, ...(saved.send_mode === 'direct' ? { confirm_direct: true } : {}) })
      if (p.success) this.current = merge(d, p.data)
    } catch { /* نبقى على الافتراضي */ }
  }

  get(): RuntimeSettings { return this.current }
  get features(): Features { return this.current.features }

  /** يتحقق ويحفظ؛ يرجع الإعدادات الكاملة الجديدة أو أخطاء التحقق */
  async update(patch: unknown): Promise<{ ok: true; value: RuntimeSettings } | { ok: false; error: string }> {
    const p = SettingsPatchSchema.safeParse(patch)
    if (!p.success) return { ok: false, error: p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('؛ ') }
    this.current = merge(this.current, p.data)
    if (this.store) await this.store.setKv('settings', JSON.stringify(this.current))
    return { ok: true, value: this.current }
  }

  /** "07:30" ← {h,m} للمجدول */
  static hm(s: string): { h: number; m: number } {
    const [h, m] = s.split(':').map(Number)
    return { h, m }
  }
}

function merge(base: RuntimeSettings, p: z.infer<typeof SettingsPatchSchema>): RuntimeSettings {
  const { confirm_direct: _c, features, models, ...rest } = p
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<RuntimeSettings>
  const mergedModels = { ...base.models, ...Object.fromEntries(Object.entries(models ?? {}).filter(([, v]) => v !== undefined)) } as ModelsSettings
  // توافق رجعي: llm_model / llm_fallback_model (حقول Gemini القديمة) تُزامَن مع understand/general
  // فقط حين يكون مزوّد الدور (أو احتياطيه) Gemini وما لم يُحدَّد الدور صراحةً — لا نكتب اسم نموذج Gemini على Claude مثلاً
  for (const role of ['understand', 'general'] as const) {
    if (models?.[role]) continue
    const m = mergedModels[role]
    if (clean.llm_model && m.provider === 'gemini') mergedModels[role] = { ...mergedModels[role], model: clean.llm_model }
    if (clean.llm_fallback_model && m.fallback?.provider === 'gemini') mergedModels[role] = { ...mergedModels[role], fallback: { provider: 'gemini', model: clean.llm_fallback_model } }
  }
  return { ...base, ...clean, features: { ...base.features, ...(features ?? {}) }, models: mergedModels }
}
