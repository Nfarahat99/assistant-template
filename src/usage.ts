import { AsyncLocalStorage } from 'node:async_hooks'
import { logger } from './logger.js'

/**
 * تتبع استهلاك الذكاء الاصطناعي: كل استدعاء LLM/STT يُسجَّل (المزوّد، النموذج، الغرض، التوكنز من
 * usageMetadata، ثواني الصوت، الزمن، النجاح). الغرض والثواني يُمرَّران عبر AsyncLocalStorage
 * فلا نلوّث تواقيع الدوال: withUsage({purpose:'stt', audio_seconds:12}, () => stt.transcribe(...))
 */
export interface UsageContext {
  purpose: string
  audio_seconds?: number | null
  /** يُملأ تلقائياً: المزوّد/النموذج الذي أجاب فعلاً، وهل انتقلنا من المزوّد الأساسي لاحتياطي */
  served?: { provider: string; model: string; fellBack: boolean; fallbackReason?: string }
}
export interface UsageEvent {
  provider: 'gemini' | 'groq' | 'nvidia' | 'anthropic' | 'openai'
  model: string
  purpose: string
  input_tokens: number
  output_tokens: number
  audio_seconds: number | null
  latency_ms: number
  ok: boolean
  error?: string | null
}

const als = new AsyncLocalStorage<UsageContext>()
export function withUsage<T>(ctx: UsageContext, fn: () => Promise<T>): Promise<T> { return als.run(ctx, fn) }
export function currentUsage(): UsageContext { return als.getStore() ?? { purpose: 'other' } }

type Sink = (e: UsageEvent) => void | Promise<void>
let sink: Sink | null = null
export function setUsageSink(s: Sink | null) { sink = s }

/** يُستدعى من عملاء المزوّدين بعد كل استدعاء — لا يرمي أبداً */
export function recordUsage(e: Omit<UsageEvent, 'purpose' | 'audio_seconds'> & Partial<Pick<UsageEvent, 'purpose' | 'audio_seconds'>>) {
  if (!sink) return
  const c = currentUsage()
  const ev: UsageEvent = { ...e, purpose: e.purpose ?? c.purpose, audio_seconds: e.audio_seconds ?? c.audio_seconds ?? null }
  const p = Promise.resolve(sink(ev)).catch((err) => logger.warn({ err: String(err) }, 'تعذّر تسجيل الاستهلاك'))
  inflight.add(p)
  p.finally(() => inflight.delete(p))
}

const inflight = new Set<Promise<unknown>>()
/** ينتظر تسجيل كل الاستهلاك المعلّق (للاختبار والإيقاف) */
export async function flushUsage() { while (inflight.size) await Promise.allSettled([...inflight]) }

/**
 * أسعار القائمة (الطبقة المدفوعة) بالدولار — للتقدير فقط. مصادرها (سبتمبر ٢٠٢٦):
 *  Gemini: https://ai.google.dev/gemini-api/docs/pricing
 *  Groq  : أسعار منشورة (Whisper turbo $0.04/ساعة، gpt-oss-120b 0.15/0.60)
 * تُستبدل كلها أو بعضها بـ PRICES_JSON: {"model":{"in":<$/1M>,"out":<$/1M>,"audio_hour":<$>}}
 */
export interface Price { in?: number; out?: number; audio_hour?: number }
export const DEFAULT_PRICES: Record<string, Price> = {
  'gemini-3.8-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
  'whisper-large-v3-turbo': { audio_hour: 0.04 },
  'whisper-large-v3': { audio_hour: 0.111 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.60 },
}

export function priceTable(env: NodeJS.ProcessEnv = process.env): Record<string, Price> {
  try {
    return env.PRICES_JSON ? { ...DEFAULT_PRICES, ...JSON.parse(env.PRICES_JSON) } : DEFAULT_PRICES
  } catch {
    logger.warn('PRICES_JSON غير صالح — نستخدم الأسعار الافتراضية')
    return DEFAULT_PRICES
  }
}

/** سعر القائمة لاستدعاء واحد (دولار) */
export function listPrice(e: Pick<UsageEvent, 'model' | 'input_tokens' | 'output_tokens' | 'audio_seconds'>, prices = priceTable()): number {
  const p = prices[e.model]
  if (!p) return 0
  let usd = (e.input_tokens / 1e6) * (p.in ?? 0) + (e.output_tokens / 1e6) * (p.out ?? 0)
  if (p.audio_hour && e.audio_seconds) usd += (e.audio_seconds / 3600) * p.audio_hour
  return Math.round(usd * 1e6) / 1e6
}
