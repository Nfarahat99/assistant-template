import type { Db } from '../db/index.js'
import type { Rejection } from '../ai/rejections.js'
import { ensureSelfReviewSchema } from './schema.js'

/** مصرف الرفض إلى جدول llm_rejections */
export function rejectionSink(db: Db) {
  return async (r: Rejection) => {
    await ensureSelfReviewSchema(db)
    await db.query(`INSERT INTO llm_rejections (provider, model, purpose, attempt, error, raw) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.provider, r.model, r.purpose, r.attempt, r.error, r.raw])
  }
}

/** نسبة الرفض لكل نموذج (آخر N يوم): المرفوض ÷ الاستدعاءات الناجحة لنفس النموذج في usage_events */
export async function rejectionRates(db: Db, since: Date): Promise<{ provider: string | null; model: string | null; rejected: number; calls: number; rate: number }[]> {
  await ensureSelfReviewSchema(db)
  const rej = await db.query<{ provider: string | null; model: string | null; c: number }>(
    `SELECT provider, model, COUNT(*)::int AS c FROM llm_rejections WHERE ts >= $1 GROUP BY provider, model`, [since])
  const calls = await db.query<{ provider: string; model: string; c: number }>(
    `SELECT provider, model, COUNT(*)::int AS c FROM usage_events WHERE ok AND ts >= $1 AND purpose IN ('chat','voice_chat') GROUP BY provider, model`, [since]).catch(() => [])
  return rej.map((r) => {
    const n = Number(calls.find((c) => c.provider === r.provider && c.model === r.model)?.c ?? 0)
    return { provider: r.provider, model: r.model, rejected: Number(r.c), calls: n, rate: n ? Math.round((Number(r.c) / n) * 1000) / 10 : 0 }
  })
}
