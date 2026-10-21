import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DbAccessError, type DbInfo, type ReadResult, type SchemaTable } from './clients/databases.js'
import { linkedRepos } from './lib/code-context.js'
import { CI_RATE_LIMITED, type Store } from './store.js'
import { logger } from './logger.js'

/**
 * بوابة قواعد البيانات لـ Claude Code في GitHub Actions — قراءة فقط.
 *
 * - التوثيق: Authorization: Bearer <HMAC-SHA256(CI_GATEWAY_SECRET, repo)> — توكن مستقل لكل مستودع،
 *   يُلغى للجميع بتدوير السر، أو لمستودع واحد بإضافته إلى CI_GATEWAY_DISABLED_REPOS.
 * - النطاق: المستودع يقرأ فقط القواعد المربوطة به (السجل: railway_project ↔ project في DB_CONNECTIONS،
 *   والخريطة الصريحة أدناه، والمستودعات المرتبطة من LINKED_REPOS).
 * - التنفيذ: عبر DatabaseRegistry.query فقط — نفس الحارس (SELECT واحدة) و READ ONLY والمهلة وحد الصفوف والحجب.
 *   لا مسار SQL ثانٍ هنا.
 * - الحدود: ٦٠ استدعاء لكل request_id، و٣٠٠ في الساعة لكل مستودع (العدّ من db_audit + الجاري الآن).
 * - السجل: كل استدعاء موثّق يُكتب في db_audit بـ source='ci' مع المستودع ورقم الطلب والغرض.
 * - الأخطاء: سبب الرفض فقط — لا تتبّع مكدّس ولا عناوين اتصال.
 */

export const CI_MAX_PER_REQUEST = 60
export const CI_MAX_PER_HOUR = 300
const HOUR_MS = 3600_000

const REPO_RE = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/
/** "Owner/MyRepo " ← "owner/myrepo" — null إن لم يكن owner/name */
export function canonicalRepo(repo: unknown): string | null {
  if (typeof repo !== 'string') return null
  const r = repo.trim().toLowerCase()
  return REPO_RE.test(r) && r.length <= 140 ? r : null
}

/** توكن المستودع: HMAC-SHA256(secret, repo بحروف صغيرة) بصيغة hex */
export function ciToken(secret: string, repo: string): string {
  const r = canonicalRepo(repo)
  if (!secret || !r) throw new Error('ciToken: سر أو مستودع غير صالح')
  return createHmac('sha256', secret).update(r).digest('hex')
}

/** مقارنة بزمن ثابت — الطول المختلف يُرفض دون تسريب */
export function verifyCiToken(secret: string, repo: string, given: string | null | undefined): boolean {
  if (!secret || !given) return false
  const r = canonicalRepo(repo)
  if (!r) return false
  const want = Buffer.from(ciToken(secret, r), 'utf8')
  const got = Buffer.from(given.trim(), 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * الخريطة الصريحة (مستودع ← مفاتيح قواعد): تضمن الربط حتى لو railway_project ناقص في السجل.
 * فارغة في القالب — تُضبط لكل مالك عبر CI_GATEWAY_SCOPES (JSON: {"owner/repo":["مفتاح-قاعدة"]}).
 */
export const DEFAULT_CI_SCOPES: Record<string, string[]> = {}

export function parseScopesEnv(raw: string | undefined): Record<string, string[]> | null {
  if (!raw?.trim()) return null
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object')
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(j)) {
      const r = canonicalRepo(k)
      if (r && Array.isArray(v)) out[r] = v.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    logger.warn('CI_GATEWAY_SCOPES ليس JSON صالحاً — نستخدم الخريطة الافتراضية')
    return null
  }
}

export interface ScopeProject { repo: string; railway_project?: string | null }

/**
 * نطاق كل مستودع = قواعده المباشرة (الخريطة الصريحة + railway_project ↔ project القاعدة)
 * + القواعد المباشرة للمستودعات المرتبطة به (غير متعدٍّ). فقط المفاتيح الموجودة فعلاً في DB_CONNECTIONS.
 */
export function buildCiScopes(opts: {
  projects: ScopeProject[]; dbs: Pick<DbInfo, 'key' | 'project'>[]
  explicit?: Record<string, string[]>; linked?: { repos: string[] }[]
}): Map<string, string[]> {
  const keys = new Set(opts.dbs.map((d) => d.key))
  const own = new Map<string, Set<string>>()
  const add = (repo: string, key: string) => {
    const r = canonicalRepo(repo)
    if (!r || !keys.has(key)) return
    if (!own.has(r)) own.set(r, new Set())
    own.get(r)!.add(key)
  }
  for (const [repo, ks] of Object.entries(opts.explicit ?? DEFAULT_CI_SCOPES)) for (const k of ks) add(repo, k)
  for (const p of opts.projects) {
    const rp = p.railway_project?.trim().toLowerCase()
    if (!rp) continue
    for (const d of opts.dbs) if (d.project && d.project.trim().toLowerCase() === rp) add(p.repo, d.key)
  }
  const out = new Map<string, Set<string>>([...own].map(([r, s]) => [r, new Set(s)]))
  for (const g of opts.linked ?? linkedRepos()) {
    const repos = g.repos.map(canonicalRepo).filter((x): x is string => !!x)
    for (const r of repos) for (const other of repos) {
      if (other === r) continue
      for (const k of own.get(other) ?? []) {
        if (!out.has(r)) out.set(r, new Set())
        out.get(r)!.add(k)
      }
    }
  }
  return new Map([...out].map(([r, s]) => [r, [...s].sort()]))
}

export function parseRepoList(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[\s,]+/).map(canonicalRepo).filter((x): x is string => !!x))
}

// ═════════════ البوابة ═════════════

export class CiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface CiDbs {
  list(): DbInfo[]
  query(key: string, sql: string): Promise<ReadResult>
  schemaTables(key: string): Promise<SchemaTable[]>
}

export interface CiGatewayDeps {
  secret: string
  dbs: CiDbs
  store: Pick<Store, 'addDbAudit' | 'ciCallCounts'>
  projects: () => ScopeProject[]
  disabledRepos?: Set<string>
  explicitScopes?: Record<string, string[]> | null
  /** مفتاح db_access في الإعدادات — إيقافه يوقف البوابة أيضاً */
  enabled?: () => boolean
  now?: () => Date
  limits?: { perRequest: number; perHour: number }
}

const QueryBody = z.object({
  repo: z.string().min(3).max(140),
  db: z.string().trim().min(1).max(40),
  sql: z.string().min(1).max(4000),
  purpose: z.string().trim().min(3, 'purpose مطلوب: سطر يشرح لماذا تحتاج هذا الاستعلام').max(300),
  request_id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,60}$/, 'request_id غير صالح'),
})
export type CiQuery = z.infer<typeof QueryBody>

export interface CiQueryResult { columns: string[]; rows: Record<string, unknown>[]; row_count: number; truncated: boolean; masked: string[] }

export class CiGateway {
  private inflight = new Map<string, number>()

  constructor(private d: CiGatewayDeps) {}

  private get limits() { return this.d.limits ?? { perRequest: CI_MAX_PER_REQUEST, perHour: CI_MAX_PER_HOUR } }

  private now() { return this.d.now?.() ?? new Date() }

  scopes(): Map<string, string[]> {
    return buildCiScopes({ projects: this.d.projects(), dbs: this.d.dbs.list(), explicit: this.d.explicitScopes ?? undefined })
  }
  allowedFor(repo: string): string[] { return this.scopes().get(repo) ?? [] }

  /** التوكن لهذا المستودع بالذات ← المستودع بصيغته القانونية. 401 بلا تفاصيل، 403 للمعطّل */
  authenticate(authHeader: string | undefined, repo: unknown): string {
    if (!this.d.secret || this.d.enabled?.() === false) throw new CiError(503, 'بوابة قواعد البيانات غير مفعّلة.')
    const r = canonicalRepo(repo)
    const token = /^Bearer\s+(\S+)$/i.exec(String(authHeader ?? '').trim())?.[1]
    if (!r || !verifyCiToken(this.d.secret, r, token)) throw new CiError(401, 'unauthorized')
    return r
  }

  private assertEnabledRepo(repo: string) {
    if (this.d.disabledRepos?.has(repo)) throw new CiError(403, `بوابة قواعد البيانات معطّلة لهذا المستودع (${repo}).`)
  }

  private assertScope(repo: string, db: string) {
    const allowed = this.allowedFor(repo)
    if (!allowed.includes(db)) {
      throw new CiError(403, allowed.length
        ? `المستودع ${repo} غير مسموح له بقراءة القاعدة «${db}». المسموح: ${allowed.join(', ')}.`
        : `المستودع ${repo} غير مربوط بأي قاعدة بيانات.`)
    }
  }

  /** يحجز مكاناً ضمن الحدين (العدّ من السجل + الجاري الآن) — يرجع دالة التحرير */
  private async reserve(repo: string, requestId: string): Promise<() => void> {
    const kReq = `req:${repo}:${requestId}`, kRepo = `repo:${repo}`
    const c = await this.d.store.ciCallCounts(repo, requestId, new Date(this.now().getTime() - HOUR_MS))
    const fReq = this.inflight.get(kReq) ?? 0, fRepo = this.inflight.get(kRepo) ?? 0
    if (c.request + fReq >= this.limits.perRequest) throw new CiError(429, `تجاوزت حد ${this.limits.perRequest} استدعاء لهذا الطلب (${requestId}).`)
    if (c.repoWindow + fRepo >= this.limits.perHour) throw new CiError(429, `تجاوزت حد ${this.limits.perHour} استدعاء في الساعة لهذا المستودع.`)
    this.inflight.set(kReq, fReq + 1)
    this.inflight.set(kRepo, fRepo + 1)
    return () => {
      for (const k of [kReq, kRepo]) {
        const n = (this.inflight.get(k) ?? 1) - 1
        if (n > 0) this.inflight.set(k, n); else this.inflight.delete(k)
      }
    }
  }

  private async audit(a: { repo: string; request_id: string; purpose: string | null; db: string; sql: string; row_count?: number | null; error?: string | null }) {
    try {
      await this.d.store.addDbAudit({
        db_key: a.db, kind: 'read', sql: a.sql, row_count: a.row_count ?? null, ok: !a.error, error: a.error ?? null, ts: this.now(),
        source: 'ci', repo: a.repo, request_id: a.request_id, purpose: a.purpose,
      })
    } catch (err) {
      logger.error({ err: String(err).slice(0, 200) }, 'بوابة CI: تعذّر تسجيل الاستدعاء في db_audit')
    }
  }

  /** POST /api/ci/db/query */
  async query(authHeader: string | undefined, body: unknown): Promise<CiQueryResult> {
    const repo = this.authenticate(authHeader, (body as any)?.repo)
    const parsed = QueryBody.safeParse(body)
    if (!parsed.success) throw new CiError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('؛ '))
    const q = parsed.data
    const base = { repo, request_id: q.request_id, purpose: q.purpose, db: q.db, sql: q.sql }
    try {
      this.assertEnabledRepo(repo)
      this.assertScope(repo, q.db)
    } catch (e) { await this.audit({ ...base, error: (e as Error).message }); throw e }
    let release: () => void
    try { release = await this.reserve(repo, q.request_id) } catch (e) {
      if (e instanceof CiError && e.status === 429) await this.audit({ ...base, error: CI_RATE_LIMITED })
      throw e
    }
    try {
      const r = await this.d.dbs.query(q.db, q.sql)
      await this.audit({ ...base, row_count: r.rowCount })
      return { columns: r.columns, rows: r.rows, row_count: r.rowCount, truncated: r.truncated, masked: r.masked }
    } catch (e) {
      // رفض الحارس أو خطأ Postgres (بلا عنوان اتصال) ← 400 بالسبب؛ غير ذلك ← 500 بلا تفاصيل
      const msg = e instanceof DbAccessError ? e.message : 'خطأ داخلي.'
      await this.audit({ ...base, error: msg })
      throw new CiError(e instanceof DbAccessError ? 400 : 500, msg)
    } finally { release() }
  }

  /** GET /api/ci/db/schema?repo=&db=&request_id= — بلا db: كل القواعد المسموحة لهذا المستودع */
  async schema(authHeader: string | undefined, qs: Record<string, unknown>): Promise<{ repo: string; dbs: { db: string; name: string; dialect: string; tables: SchemaTable[] }[] }> {
    const repo = this.authenticate(authHeader, qs.repo)
    const requestId = typeof qs.request_id === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(qs.request_id) ? qs.request_id : 'schema'
    const db = typeof qs.db === 'string' && qs.db.trim() ? qs.db.trim().slice(0, 40) : null
    const base = { repo, request_id: requestId, purpose: 'schema', db: db ?? '*', sql: `-- schema ${db ?? '*'}` }
    try {
      this.assertEnabledRepo(repo)
      if (db) this.assertScope(repo, db)
    } catch (e) { await this.audit({ ...base, error: (e as Error).message }); throw e }
    const keys = db ? [db] : this.allowedFor(repo)
    if (!keys.length) { await this.audit({ ...base, error: 'no scope' }); throw new CiError(403, `المستودع ${repo} غير مربوط بأي قاعدة بيانات.`) }
    let release: () => void
    try { release = await this.reserve(repo, requestId) } catch (e) {
      if (e instanceof CiError && e.status === 429) await this.audit({ ...base, error: CI_RATE_LIMITED })
      throw e
    }
    try {
      const out = []
      for (const k of keys) {
        const info = this.d.dbs.list().find((x) => x.key === k)
        // dialect: SQLite (مسار HTTP) لا يدعم ILIKE و ::cast — Claude في CI يكتب SQL بحسبها
        out.push({ db: k, name: info?.name_ar ?? k, dialect: info?.dialect ?? 'postgres', tables: await this.d.dbs.schemaTables(k) })
      }
      await this.audit({ ...base, row_count: out.reduce((s, x) => s + x.tables.length, 0) })
      return { repo, dbs: out }
    } catch (e) {
      const msg = e instanceof DbAccessError ? e.message : 'خطأ داخلي.'
      await this.audit({ ...base, error: msg })
      throw new CiError(e instanceof DbAccessError ? 400 : 500, msg)
    } finally { release() }
  }
}

/** المسارات: POST /api/ci/db/query و GET /api/ci/db/schema */
export function registerCiGateway(app: FastifyInstance, gw: CiGateway | null | undefined) {
  if (!gw) return
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof CiError) return reply.code(e.status).send({ error: e.message })
    logger.error({ err: String((e as any)?.message ?? e).slice(0, 200) }, 'بوابة CI: خطأ غير متوقع')
    return reply.code(500).send({ error: 'خطأ داخلي.' })
  }
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store')
  app.post('/api/ci/db/query', async (req: FastifyRequest, reply) => {
    noStore(reply)
    try { return reply.code(200).send(await gw.query(req.headers.authorization, req.body)) } catch (e) { return fail(reply, e) }
  })
  app.get('/api/ci/db/schema', async (req: FastifyRequest, reply) => {
    noStore(reply)
    try { return reply.code(200).send(await gw.schema(req.headers.authorization, (req.query ?? {}) as Record<string, unknown>)) } catch (e) { return fail(reply, e) }
  })
}
