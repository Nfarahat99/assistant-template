import type { Store } from './store.js'
import type { UsageEvent } from './usage.js'
import { localParts, zonedToDate, formatClock } from './lib/time.js'
import { logger } from './logger.js'
import type { ProviderId, RoleModel } from './ai/roles.js'

/**
 * حصة Gemini اليومية. Google لا تعرض المتبقي، فنحسب محلياً من usage_events.
 * يوم الحصة يتجدد منتصف الليل بتوقيت المحيط الهادئ (America/Los_Angeles) حسب Google.
 *
 * الحدود الافتراضية = حدود الطبقة المجانية المعروفة وقت الكتابة — **تحقق منها** في
 * https://aistudio.google.com/rate-limit وعدّلها بالبيئة:
 *   GEMINI_DAILY_REQUEST_LIMIT='{"gemini-3.8-flash":250,"gemini-3.5-flash-lite":1000}'
 *   GEMINI_DAILY_TOKEN_LIMIT='{"gemini-3.8-flash":null}'
 * (أو رقم واحد يُطبق على كل النماذج)
 */
export const QUOTA_TZ = 'America/Los_Angeles'
export const DEFAULT_REQUEST_LIMITS: Record<string, number> = { 'gemini-3.8-flash': 250, 'gemini-3.5-flash-lite': 1000 }

export interface QuotaLimits { requests: Record<string, number | null>; tokens: Record<string, number | null> }

function parseLimit(raw: string | undefined, defaults: Record<string, number | null>): Record<string, number | null> {
  if (!raw) return defaults
  try {
    const j = JSON.parse(raw)
    if (typeof j === 'number') return new Proxy({}, { get: () => j }) as Record<string, number>
    return { ...defaults, ...j }
  } catch { return defaults }
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaLimits {
  return { requests: parseLimit(env.GEMINI_DAILY_REQUEST_LIMIT, DEFAULT_REQUEST_LIMITS), tokens: parseLimit(env.GEMINI_DAILY_TOKEN_LIMIT, {}) }
}

/** بداية يوم الحصة الحالي ونهايته (لحظات UTC) */
export function quotaDay(now: Date): { start: Date; resetsAt: Date; key: string } {
  const p = localParts(now, QUOTA_TZ)
  return {
    start: zonedToDate(p.y, p.mo, p.d, 0, 0, QUOTA_TZ),
    resetsAt: zonedToDate(p.y, p.mo, p.d + 1, 0, 0, QUOTA_TZ),
    key: `${p.y}-${p.mo}-${p.d}`,
  }
}

export const isQuotaError = (e: string | null | undefined) => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e ?? '')

export interface QuotaSnapshot { model: string; used_requests: number; limit_requests: number | null; used_tokens: number; limit_tokens: number | null; resets_at: string; exhausted: boolean }

/** أدوار النص التي تحدد «هل يقدر المساعد يرد؟» — من settings.models */
export type QuotaRoles = { understand: RoleModel; general: RoleModel }
const QUOTA_ROLES = ['understand', 'general'] as const

/** نماذج Gemini في سلسلتي الفهم والعام بالترتيب وبلا تكرار — هي ما تُقاس حصته */
export function quotaModels(models: QuotaRoles): string[] {
  const out: string[] = []
  for (const r of QUOTA_ROLES) {
    const m = models[r]
    for (const t of [m, m.fallback]) if (t?.provider === 'gemini' && !out.includes(t.model)) out.push(t.model)
  }
  return out
}

export class QuotaTracker {
  /** نموذج ← مفتاح اليوم الذي خلصت فيه حصته (ذاكرة + kv) */
  private exhausted = new Map<string, string>()

  constructor(
    private store: Store,
    private models: () => QuotaRoles,
    private notify: (text: string) => Promise<unknown>,
    private tz: string,
    private now: () => Date,
    private limits: QuotaLimits = limitsFromEnv(),
    /** هل لمزوّد غير Gemini مفتاح؟ (مزوّد بمفتاح في سلسلة الفهم = المساعد يقدر يرد رغم نفاد حصة Gemini) */
    private hasKey: (p: ProviderId) => boolean = () => false,
  ) {}

  /** أول نموذجين Gemini في سلسلتي الفهم/العام (للتنبيهات واللقطة) */
  private pair(): { primary: string | null; fallback: string | null } {
    const g = quotaModels(this.models())
    return { primary: g[0] ?? null, fallback: g[1] ?? null }
  }

  /** الدور يقدر يرد: مزوّد غير Gemini بمفتاح، أو نموذج Gemini لم تخلص حصته اليوم */
  private roleAvailable(role: keyof QuotaRoles): boolean {
    const m = this.models()[role]
    return [m, m.fallback].some((t) => !!t && (t.provider === 'gemini' ? !this.isExhausted(t.model) : this.hasKey(t.provider)))
  }

  async load() {
    const raw = await this.store.getKv('quota_exhausted')
    if (raw) try { this.exhausted = new Map(Object.entries(JSON.parse(raw))) } catch { /* تجاهل */ }
  }

  isExhausted(model: string): boolean { return this.exhausted.get(model) === quotaDay(this.now()).key }
  primaryExhausted(): boolean { const { primary } = this.pair(); return !!primary && this.isExhausted(primary) }
  /** لا يقدر يفهم أي رسالة الآن: كل سلسلة الفهم إما Gemini خالص اليوم أو مزوّد بلا مفتاح */
  allExhausted(): boolean { return !this.roleAvailable('understand') }
  resetsAtRiyadh(): string { return formatClock(quotaDay(this.now()).resetsAt, this.now(), this.tz) }

  private async markExhausted(model: string) {
    this.exhausted.set(model, quotaDay(this.now()).key)
    await this.store.setKv('quota_exhausted', JSON.stringify(Object.fromEntries(this.exhausted)))
  }

  /** يُستدعى بعد تسجيل كل استدعاء Gemini */
  async onUsage(e: UsageEvent) {
    if (e.provider !== 'gemini') return
    const day = quotaDay(this.now())
    const { primary, fallback } = this.pair()

    if (!e.ok && isQuotaError(e.error)) {
      if (!this.isExhausted(e.model)) await this.markExhausted(e.model)
      if (this.allExhausted()) {
        if (await this.store.claimKv('quota_all_alert', day.key)) {
          await this.notify(`❌ خلصت حصة الذكاء اليوم. ترجع الساعة ${this.resetsAtRiyadh()} بتوقيت الرياض. أقدر أسجل رسائلك وأرد عليها بعدين.`)
        }
      } else if (e.model === primary && fallback && (await this.store.claimKv(`quota_switch_${e.model}`, day.key))) {
        await this.notify(`⚠️ حصة النموذج الأساسي (${primary}) خلصت، حولت للاحتياطي (${fallback}) لين ${this.resetsAtRiyadh()}.`)
      }
      return
    }

    const limit = this.limits.requests[e.model] ?? null
    const tokLimit = this.limits.tokens[e.model] ?? null
    if (!limit && !tokLimit) return
    const used = await this.store.modelUsageSince(e.model, day.start)
    const ratio = Math.max(limit ? used.requests / limit : 0, tokLimit ? used.tokens / tokLimit : 0)
    for (const pct of [95, 80]) {
      if (ratio * 100 < pct) continue
      if (!(await this.store.claimKv(`quota_${pct}_${e.model}`, day.key))) break
      const left = limit ? Math.max(0, limit - used.requests) : null
      await this.notify(pct === 95
        ? `🚨 حصة الذكاء (${e.model}) قربت تخلص: ${used.requests} من ${limit ?? '—'} طلب اليوم${left !== null ? ` — باقي ${left} فقط` : ''}. تتجدد ${this.resetsAtRiyadh()}.`
        : `⚠️ استهلكت 80% من حصة الذكاء اليوم (${used.requests} من ${limit ?? '—'}). باقي تقريباً ${left ?? '؟'} طلب.`)
      break
    }
  }

  async snapshot(): Promise<QuotaSnapshot[]> {
    const day = quotaDay(this.now())
    const { primary, fallback } = this.pair()
    const out: QuotaSnapshot[] = []
    for (const model of [primary, fallback].filter((m): m is string => !!m)) {
      const u = await this.store.modelUsageSince(model, day.start)
      out.push({
        model, used_requests: u.requests, limit_requests: this.limits.requests[model] ?? null,
        used_tokens: u.tokens, limit_tokens: this.limits.tokens[model] ?? null,
        resets_at: day.resetsAt.toISOString(), exhausted: this.isExhausted(model),
      })
    }
    return out
  }
}

/**
 * Claude Code (خطة Max): هل فشل التشغيل بسبب حد الاستخدام؟ ومتى يرجع؟
 * يقرأ نص الأخطاء (annotations) مثل: "Claude usage limit reached. Your limit will reset at 3pm (Asia/Riyadh)"
 * أو طابعاً زمنياً ISO/يونكس.
 */
export function claudeLimitInfo(text: string, now: Date): { limited: boolean; resetsAt: Date | null } {
  if (!/usage limit|rate[_ ]?limit|\b429\b|limit will reset/i.test(text)) return { limited: false, resetsAt: null }
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2}))/.exec(text)
  if (iso) return { limited: true, resetsAt: new Date(iso[1]) }
  const unix = /\|(\d{10})\b/.exec(text) ?? /reset[^\d]{0,20}(\d{10})\b/i.exec(text)
  if (unix) return { limited: true, resetsAt: new Date(Number(unix[1]) * 1000) }
  const hm = /reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([\w/_+-]+)\))?/i.exec(text)
  if (hm) {
    let h = Number(hm[1]) % 12
    if (hm[3]?.toLowerCase() === 'pm') h += 12
    if (!hm[3]) h = Number(hm[1])
    const tz = hm[4] || 'UTC'
    try {
      const p = localParts(now, tz)
      let at = zonedToDate(p.y, p.mo, p.d, h, Number(hm[2] ?? 0), tz)
      if (at.getTime() <= now.getTime()) at = zonedToDate(p.y, p.mo, p.d + 1, h, Number(hm[2] ?? 0), tz)
      return { limited: true, resetsAt: at }
    } catch (err) {
      logger.warn({ err: String(err) }, 'تعذّر فهم وقت تجدد حد Claude')
    }
  }
  return { limited: true, resetsAt: null }
}
