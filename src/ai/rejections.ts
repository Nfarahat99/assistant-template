import { currentUsage } from '../usage.js'
import { logger } from '../logger.js'

/**
 * مخرجات النموذج المرفوضة (JSON غير صالح / مخالف للعقد) — كانت تُكتب في السجل فقط فلا تُعد.
 * تُسجَّل عبر مصرف (sink) يضبطه الإقلاع (جدول llm_rejections) لقياس نسبة الرفض لكل نموذج.
 * لا يرمي أبداً ولا يبطئ الرد.
 */
export interface Rejection { provider: string | null; model: string | null; purpose: string; attempt: number; error: string; raw: string }
type Sink = (r: Rejection) => void | Promise<void>
let sink: Sink | null = null
export function setRejectionSink(s: Sink | null) { sink = s }

const inflight = new Set<Promise<unknown>>()
export async function flushRejections() { while (inflight.size) await Promise.allSettled([...inflight]) }

export function recordRejection(attempt: number, error: string, raw: string) {
  if (!sink) return
  const c = currentUsage()
  const r: Rejection = {
    provider: c.served?.provider ?? null, model: c.served?.model ?? null, purpose: c.purpose,
    attempt, error: error.slice(0, 500), raw: raw.slice(0, 1500),
  }
  const p = Promise.resolve().then(() => sink?.(r)).catch((err) => logger.warn({ err: String(err) }, 'تعذّر تسجيل رفض مخرج النموذج'))
  inflight.add(p)
  p.finally(() => inflight.delete(p))
}
