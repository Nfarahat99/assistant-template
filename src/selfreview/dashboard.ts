import type { Db } from '../db/index.js'
import { ensureSelfReviewSchema } from './schema.js'
import { listCases } from './cases.js'
import { rejectionRates } from './rejections.js'

/** GET /api/dash/selfreview — قراءة فقط: آخر المراجعات الليلية + حالات التقييم (الواجهة لاحقاً) */
export async function selfReviewSnapshot(db: Db, o: { reviews?: number; cases?: number; now?: Date } = {}) {
  await ensureSelfReviewSchema(db)
  const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v)
  const reviews = (await db.query<any>(
    `SELECT id, day, created_at, conversations, failures, items, message, pending_nos, clustered_by FROM self_reviews ORDER BY id DESC LIMIT $1`,
    [o.reviews ?? 14])).map((r) => ({ ...r, items: parse(r.items), pending_nos: parse(r.pending_nos) }))
  const cases = await listCases(db, { status: 'all', limit: o.cases ?? 200 })
  const count = (f: (c: (typeof cases)[number]) => boolean) => cases.filter(f).length
  // نسبة رفض مخرجات النموذج (JSON/schema) لكل نموذج — آخر ٧ أيام
  const llm_rejections = await rejectionRates(db, new Date((o.now ?? new Date()).getTime() - 7 * 86_400_000))
  return {
    reviews,
    cases,
    llm_rejections,
    counts: {
      cases: cases.length,
      active: count((c) => c.status === 'active'),
      draft: count((c) => c.status === 'draft'),
      by_source: { seed: count((c) => c.source === 'seed'), selfreview: count((c) => c.source === 'selfreview'), manual: count((c) => c.source === 'manual') },
    },
  }
}
