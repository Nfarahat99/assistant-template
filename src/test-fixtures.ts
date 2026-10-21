/**
 * حمولات حقيقية من الوسيط (واتساب سراج) — GET /api/v1/status — كما التقطها فريق الجودة.
 * لا تُعدّل لتناسب الكود: الكود هو الذي يجب أن يفهمها.
 */

/** رقم محظور من واتساب: الحالة paused والسبب في paused_reason (لا في last_disconnect_reason) */
export const REAL_BAN_STATUS = {
  status: 'paused',
  paused_reason: 'حظره واتساب (403) — لا تُعاد المحاولة. يلزم رقم جديد أو مراجعة واتساب',
  last_disconnect_reason: null,
} as const

/** إيقاف بقاطع الدائرة (ليس حظراً) — النص من dispatcher.ts في الوسيط (FAILURE_THRESHOLD=3) */
export const REAL_CIRCUIT_BREAKER_STATUS = {
  status: 'paused',
  paused_reason: 'فشل متتالٍ 3 مرات — أُوقف الرقم تلقائياً للحماية',
  last_disconnect_reason: null,
} as const

/** PGlite خلف واجهة pg.Pool (لاختبارات قواعد المشاريع) — كل استعلام يُسجَّل في log */
export function pglitePool(pg: import('@electric-sql/pglite').PGlite, log: string[] = []): import('./clients/databases.js').PoolFactory {
  return () => ({
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          log.push(sql)
          const r = await pg.query<any>(sql, params as any[])
          return { rows: r.rows, fields: r.fields.map((f) => ({ name: f.name })) }
        },
        release() {},
      }
    },
    async end() {},
  })
}
