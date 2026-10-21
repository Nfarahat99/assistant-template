import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import type { Store } from '../store.js'
import type { Config } from '../config.js'
import type { Settings } from '../settings.js'
import type { ProjectRegistry } from '../projects.js'
import { projectLabel } from '../projects.js'
import type { GitHubClient } from '../clients/github.js'
import type { GatewayClient } from '../clients/gateway.js'
import type { BuildInfo } from '../version.js'
import { limitsFromEnv, quotaModels } from '../quota.js'
import { startOfLocalDay } from '../lib/time.js'
import { toLatinDigits } from '../lib/phone.js'
import { logger } from '../logger.js'
import {
  DASH_SCHEMA, LoginLimiter, SessionStore, SESSION_COOKIE, clearCookie, clientIp, passwordMatches, readCookie, sessionCookie,
} from './auth.js'
import * as data from './data.js'
import { ProjectItems } from '../projects/items.js'
import { ProjectDbClient, ProjectDbError } from '../clients/project-db.js'
import { RailwayCache, joinProjects, railwayInfoFromToken, type RailwayInfoFn } from './projects-info.js'
import { selfReviewSnapshot } from '../selfreview/dashboard.js'
import { ROLES, PROVIDERS, PROVIDER_CAPS, ROLE_NEEDS } from '../ai/roles.js'
import { assistantName } from '../profile.js'
import { resetInterview } from '../onboarding/interview.js'
import type { KeyStatus } from '../ai/router.js'
import { registerWaLinkRoutes, type WaLinkDeps } from './wa-link.js'

/**
 * لوحة تحكم المالك: الواجهة الثابتة على /dashboard/ و API على /api/dash/*.
 * بلا DASHBOARD_PASSWORD لا يُسجَّل شيء إطلاقاً (404).
 */
export interface DashboardDeps {
  password: string
  db: Db
  store: Store
  cfg: Config
  settings: Settings
  projects: ProjectRegistry
  github?: GitHubClient | null
  gateway?: GatewayClient | null
  watchdog?: { snapshot(): { status: string; reason: string | null; paused_reason?: string | null; banned: boolean; down_since: string | null } } | null
  telegram?: { readonly bound: boolean } | null
  version?: BuildInfo | null | (() => BuildInfo | null)
  /** للاختبار: بديل Railway؛ الافتراضي من cfg.railwayToken */
  railwayInfo?: RailwayInfoFn | null
  /** للاختبار: بديل عميل قواعد المشاريع (قراءة فقط)؛ الافتراضي من PROJECT_DB_<الاسم>_URL */
  projectDb?: ProjectDbClient | null
  now?: () => Date
  publicDir?: string
  /** حالة مفاتيح المزوّدين لكل دور (من buildRoleClients) — لشارات قسم النماذج */
  keyStatus?: () => KeyStatus[]
  /** ربط واتساب من صفحة الحسابات — للاختبار: بديل exit ومهلة إعادة التشغيل */
  waLink?: Pick<WaLinkDeps, 'exit' | 'restart' | 'restartDelayMs' | 'statusTimeoutMs'>
}

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PUBLIC = join(here, '..', '..', 'public', 'dashboard')
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version as string } catch { return null } })()

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' https://fonts.googleapis.com",
  // الصفحات تبني HTML فيه style="…" (عرض المقياس، تخطيط البطاقات) — نسمح بسمات النمط فقط، لا وسوم <style> ولا سكربتات
  "style-src-attr 'unsafe-inline'",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const AR = {
  unauthorized: 'غير مصرّح — سجّل الدخول أولاً.',
  csrf: 'طلب مرفوض: ترويسة X-Requested-With مفقودة.',
  badPassword: 'كلمة المرور غير صحيحة.',
  locked: 'محاولات كثيرة خاطئة. انتظر قليلاً ثم أعد المحاولة.',
  notFound: 'غير موجود.',
  phoneTaken: 'هذا الرقم مسجّل لجهة أخرى.',
  knowledgeTooBig: 'ملف المعرفة أكبر من الحد المسموح (30 كيلوبايت).',
  knowledgeEmpty: 'لا يمكن حفظ ملف معرفة فارغ.',
  waBanned: 'رقم واتساب محظور — إعادة الربط لن تنجح حتى يُرفع الحظر.',
  waUnsupported: 'الوسيط لا يدعم إعادة الربط من هنا.',
  waError: 'تعذّر الوصول لوسيط واتساب.',
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** index.html باسم مساعد المالك (من الملف الشخصي، مهرّباً) — الاسم ليس سراً وصفحة الدخول تحتاجه قبل المصادقة */
export function renderIndexHtml(template: string, name = assistantName()): string {
  const initial = [...name.trim()][0] ?? ''
  return template.replaceAll('{{assistant_initial}}', escapeHtml(initial)).replaceAll('{{assistant}}', escapeHtml(name))
}

function securityHeaders(reply: FastifyReply) {
  reply.header('Content-Security-Policy', CSP)
  reply.header('X-Frame-Options', 'DENY')
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
}

/** يسجّل اللوحة إن ضُبطت كلمة المرور — يرجع false إن لم تُسجَّل */
export function registerDashboard(app: FastifyInstance, deps: DashboardDeps | null | undefined): boolean {
  if (!deps?.password) return false
  const now = deps.now ?? (() => new Date())
  const tz = deps.cfg.tz
  const sessions = new SessionStore(deps.db, deps.password, now)
  const limiter = new LoginLimiter(() => now().getTime())
  const railwayFn = deps.railwayInfo !== undefined ? deps.railwayInfo : deps.cfg.railwayToken ? railwayInfoFromToken(deps.cfg.railwayToken) : null
  const railway = new RailwayCache(railwayFn)
  const version = () => (typeof deps.version === 'function' ? deps.version() : deps.version) ?? null

  // ───── الواجهة الثابتة ─────
  app.get('/dashboard', (_req, reply) => { securityHeaders(reply); return reply.redirect('/dashboard/', 301) })
  app.register(async (ui) => {
    ui.addHook('onSend', async (_req, reply) => { securityHeaders(reply) })
    const root = deps.publicDir ?? DEFAULT_PUBLIC
    let template: string | null = null
    const index = (reply: FastifyReply) => {
      template ??= readFileSync(join(root, 'index.html'), 'utf8')
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(renderIndexHtml(template))
    }
    await ui.register(fastifyStatic, { root, prefix: '/', index: false, wildcard: true, cacheControl: true, maxAge: 0 })
    // الصفحة الرئيسية تُخدم مُعالجة (اسم المساعد) لا كملف ثابت
    ui.route({ method: 'GET', url: '/', prefixTrailingSlash: 'slash', handler: (_req, reply) => index(reply) })
    ui.get('/index.html', (_req, reply) => index(reply))
    // مسار غير موجود بلا امتداد ← الصفحة الرئيسية (التوجيه بالـ hash أصلاً)
    ui.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0])) return index(reply)
      return reply.code(404).send({ error: AR.notFound })
    })
  }, { prefix: '/dashboard' })

  // ───── API ─────
  app.register(async (api) => {
    await deps.db.exec(DASH_SCHEMA)

    api.addHook('onSend', async (_req, reply) => {
      securityHeaders(reply)
      reply.header('Cache-Control', 'no-store')
    })
    api.addHook('onRequest', async (req, reply) => {
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      if (mutation && req.headers['x-requested-with'] !== 'dash') return reply.code(403).send({ error: AR.csrf })
      if (req.url.split('?')[0] === '/api/dash/login') return
      if (!(await sessions.valid(readCookie(req.headers.cookie, SESSION_COOKIE)))) return reply.code(401).send({ error: AR.unauthorized })
    })
    api.setErrorHandler((err: any, _req, reply) => {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: zodMessage(err) })
      const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
      if (code >= 500) logger.error({ err: String(err?.stack ?? err) }, 'لوحة التحكم: خطأ داخلي')
      return reply.code(code).send({ error: code >= 500 ? 'خطأ داخلي في الخادم.' : String(err.message) })
    })
    api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: AR.notFound }))

    // ── الدخول ──
    api.post('/login', async (req, reply) => {
      const ip = clientIp(req)
      const wait = limiter.lockedFor(ip)
      if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: AR.locked })
      if (!passwordMatches((req.body as any)?.password, deps.password)) {
        limiter.fail(ip)
        logger.warn({ ip }, 'لوحة التحكم: كلمة مرور خاطئة')
        return reply.code(401).send({ error: AR.badPassword })
      }
      limiter.success(ip)
      const token = await sessions.create(ip)
      return reply.header('Set-Cookie', sessionCookie(token)).send({ ok: true })
    })
    api.post('/logout', async (req, reply) => {
      await sessions.destroy(readCookie(req.headers.cookie, SESSION_COOKIE))
      return reply.header('Set-Cookie', clearCookie()).send({ ok: true })
    })

    // ── المراجعة الذاتية + حالات التقييم (قراءة فقط) ──
    api.get('/selfreview', async () => selfReviewSnapshot(deps.db))

    // ── نظرة عامة ──
    api.get('/overview', async () => {
      const t = now()
      const v = version()
      const snap = deps.watchdog?.snapshot()
      const st = deps.settings.get()
      const [today, month, daily, tasks, messages, code_jobs] = await Promise.all([
        data.usageTotals(deps.db, startOfLocalDay(t, tz)),
        data.usageTotals(deps.db, data.startOfLocalMonth(t, tz)),
        data.usageDaily(deps.db, t, tz, 30),
        data.taskStats(deps.db, t, tz),
        data.messageStats(deps.db, t, tz),
        data.jobStats(deps.db, t),
      ])
      return {
        bot: { version: PKG_VERSION, commit: v?.sha ?? null, built_at: v?.built_at ?? v?.date ?? null, uptime_s: Math.round(process.uptime()) },
        channels: {
          whatsapp: snap
            ? { status: snap.banned ? 'banned' : snap.status, banned: !!snap.banned, reason: snap.paused_reason ?? snap.reason ?? null, down_since: snap.down_since }
            : { status: 'unknown', banned: false, reason: null, down_since: null },
          telegram: { bound: !!deps.telegram?.bound },
        },
        send_mode: st.send_mode,
        usage: { today, month, daily, quota_calls: (() => { const m = quotaModels(st.models)[0]; return m ? limitsFromEnv().requests[m] ?? null : null })() },
        tasks, messages, code_jobs,
      }
    })

    // ── المهام ──
    const iso = z.union([z.string().datetime({ offset: true }), z.null()]).optional()
    const prio = z.enum(['low', 'normal', 'high', 'urgent']).nullable().optional()
    const TaskNew = z.object({
      title: z.string().trim().min(1, 'العنوان مطلوب').max(500),
      notes: z.string().max(5000).nullable().optional(),
      due_at: iso, remind_at: iso, priority: prio,
    })
    const TaskPatch = TaskNew.partial().extend({ status: z.enum(['open', 'done']).optional() }).strict()
    const idParam = (req: FastifyRequest) => {
      const id = Number((req.params as any).id)
      if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error(AR.notFound), { statusCode: 404 })
      return id
    }

    api.get('/tasks', async (req) => {
      const q = req.query as any
      const status = (['open', 'overdue', 'done', 'all'].includes(q.status) ? q.status : 'open') as data.TaskFilter
      return { items: await data.listTasks(deps.db, status, String(q.q ?? '').trim().slice(0, 200), now()) }
    })
    api.post('/tasks', async (req, reply) => {
      const b = TaskNew.parse(req.body)
      const [r] = await deps.db.query<any>(
        `INSERT INTO tasks (title, notes, priority, source, due_at, remind_at) VALUES ($1,$2,$3,'dashboard',$4,$5) RETURNING *`,
        [b.title, b.notes || null, b.priority ?? null, b.due_at ?? null, b.remind_at ?? null])
      return reply.code(201).send(data.mapTask(r))
    })
    api.patch('/tasks/:id', async (req) => {
      const id = idParam(req)
      const b = TaskPatch.parse(req.body ?? {})
      const sets: string[] = []
      const params: unknown[] = [id]
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`) }
      if (b.title !== undefined) set('title', b.title)
      if (b.notes !== undefined) set('notes', b.notes || null)
      if (b.priority !== undefined) set('priority', b.priority)
      if (b.due_at !== undefined) set('due_at', b.due_at)
      if (b.remind_at !== undefined) { set('remind_at', b.remind_at); sets.push('reminded_at=NULL') }
      if (b.status === 'done') sets.push(`status='done'`, `done_at=COALESCE(done_at, now())`)
      if (b.status === 'open') sets.push(`status='open'`, 'done_at=NULL')
      const [r] = sets.length
        ? await deps.db.query<any>(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params)
        : await deps.db.query<any>(`SELECT * FROM tasks WHERE id=$1`, [id])
      if (!r) throw Object.assign(new Error(AR.notFound), { statusCode: 404 })
      return data.mapTask(r)
    })
    api.delete('/tasks/:id', async (req) => {
      const rows = await deps.db.query(`DELETE FROM tasks WHERE id=$1 RETURNING id`, [idParam(req)])
      if (!rows.length) throw Object.assign(new Error(AR.notFound), { statusCode: 404 })
      return { ok: true }
    })

    // ── طلبات الكود ──
    api.get('/jobs', async () => {
      const list = deps.projects.all()
      const rows = await data.listJobs(deps.db)
      return {
        items: rows.map((j) => {
          const p = list.find((x) => x.repo.toLowerCase() === String(j.repo).toLowerCase())
          return {
            request_id: j.request_id,
            // الاسم العربي للمشروع — لا مسار محلي أبداً (العمود project يحفظ اسم المجلد)
            project: p ? projectLabel(p) : String(j.repo).split('/').pop(),
            repo: j.repo,
            request: j.request,
            status: j.status,
            run_url: j.run_url ?? null,
            pr_url: j.pr_url ?? null,
            pr_number: j.pr_number ?? null,
            dispatched_at: data.iso(j.dispatched_at),
            updated_at: data.iso(j.updated_at),
            merged_at: data.iso(j.merged_at),
            deploy_status: j.deploy_status ?? null,
            deploy_url: j.deploy_url ?? null,
          }
        }),
      }
    })

    // ── جهات الاتصال ──
    const phone = z.string().transform((s) => toLatinDigits(s).replace(/[^0-9]/g, ''))
      .refine((d) => /^[1-9]\d{7,14}$/.test(d), 'رقم الجوال بالصيغة الدولية (8–15 رقماً بلا أصفار بادئة)، مثل 966500004567')
    const aliases = z.array(z.string().trim().max(60)).max(30).transform((a) => [...new Set(a.filter(Boolean))])
    const ContactNew = z.object({ name: z.string().trim().min(1, 'الاسم مطلوب').max(120), phone, aliases: aliases.optional() })
    const ContactPatch = ContactNew.partial().strict()
    const contactRow = (r: any) => ({ id: r.id, name: r.name, phone: r.phone, aliases: r.aliases ?? [] })
    const uniqueGuard = (err: any) => {
      if (err?.code === '23505' || /duplicate key|unique/i.test(String(err?.message))) throw Object.assign(new Error(AR.phoneTaken), { statusCode: 409 })
      throw err
    }

    api.get('/contacts', async () => ({ items: (await deps.db.query<any>(`SELECT id, name, phone, aliases FROM contacts ORDER BY name`)).map(contactRow) }))
    api.post('/contacts', async (req, reply) => {
      const b = ContactNew.parse(req.body)
      const [r] = await deps.db.query<any>(
        `INSERT INTO contacts (name, phone, aliases) VALUES ($1,$2,$3) RETURNING id, name, phone, aliases`,
        [b.name, b.phone, b.aliases ?? []]).catch(uniqueGuard)
      return reply.code(201).send(contactRow(r))
    })
    api.patch('/contacts/:id', async (req) => {
      const id = idParam(req)
      const b = ContactPatch.parse(req.body ?? {})
      const [r] = await deps.db.query<any>(
        `UPDATE contacts SET name=COALESCE($2,name), phone=COALESCE($3,phone), aliases=COALESCE($4,aliases)
          WHERE id=$1 RETURNING id, name, phone, aliases`,
        [id, b.name ?? null, b.phone ?? null, b.aliases ?? null]).catch(uniqueGuard)
      if (!r) throw Object.assign(new Error(AR.notFound), { statusCode: 404 })
      return contactRow(r)
    })
    api.delete('/contacts/:id', async (req) => {
      const rows = await deps.db.query(`DELETE FROM contacts WHERE id=$1 RETURNING id`, [idParam(req)])
      if (!rows.length) throw Object.assign(new Error(AR.notFound), { statusCode: 404 })
      return { ok: true }
    })

    // ── المشاريع ──
    api.get('/projects', async () => ({ items: joinProjects(deps.projects.all(), await railway.get()) }))
    // ── قواعد بيانات المشاريع (قراءة فقط) ──
    const projectDb = deps.projectDb ?? new ProjectDbClient()
    const dbErr = (e: unknown, reply: FastifyReply) => {
      if (e instanceof ProjectDbError) return reply.code(400).send({ error: e.message })
      throw e
    }
    api.get('/projectdb', async () => ({ items: projectDb.list() }))
    api.get('/projectdb/:name/schema', async (req, reply) => {
      try { return await projectDb.schema((req.params as { name: string }).name) } catch (e) { return dbErr(e, reply) }
    })
    api.post('/projectdb/:name/query', async (req, reply) => {
      const body = z.object({ sql: z.string().min(1).max(4000), limit: z.number().int().positive().max(200).optional() }).parse(req.body)
      try { return await projectDb.query((req.params as { name: string }).name, body.sql, { limit: body.limit }) } catch (e) { return dbErr(e, reply) }
    })
    api.post('/projects/reload', async () => {
      await deps.projects.loadFile(deps.cfg.projectsFile)
      if (deps.github && deps.cfg.projectsRemote) await deps.projects.loadRemote(deps.github, deps.cfg.projectsRemote)
      railway.invalidate()
      return { ok: true, count: deps.projects.all().length }
    })

    // ── المحادثات ──
    api.get('/conversations', async (req) => {
      const limit = Math.min(200, Math.max(1, Number((req.query as any).limit) || 50))
      return { items: await data.conversations(deps.db, limit) }
    })

    // ── متتبّع مشاريع البزنس (قراءة فقط) ──
    api.get('/projects-items', async () => {
      const items = new ProjectItems(deps.db)
      return { items: await items.open(), profiles: await items.profiles() }
    })

    // ── الإعدادات ──
    api.get('/settings', async () => deps.settings.get())
    // ── النماذج لكل دور: الأدوار، قدرات المزوّدين، وحالة المفاتيح (بلا أسرار — hasKey فقط) ──
    api.get('/models', async () => ({
      roles: ROLES, providers: PROVIDERS, caps: PROVIDER_CAPS, needs: ROLE_NEEDS,
      status: deps.keyStatus?.() ?? [],
    }))
    api.put('/settings', async (req, reply) => {
      const r = await deps.settings.update(req.body ?? {})
      if (!r.ok) return reply.code(400).send({ error: r.error })
      logger.info({ keys: Object.keys((req.body as any) ?? {}) }, 'لوحة التحكم: حُدّثت الإعدادات')
      return r.value
    })

    // ── ملف المعرفة ──
    const KNOWLEDGE_MAX = 30 * 1024
    api.get('/knowledge', async () => ({
      markdown: (await deps.store.getKv('knowledge_md')) ?? '',
      updated_at: await deps.store.getKv('knowledge_md_updated_at'),
    }))
    api.put('/knowledge', async (req, reply) => {
      const raw = (req.body as any)?.markdown
      // نهايات أسطر موحّدة (\n): CRLF من ويندوز كان يُظهر «تعديلات غير محفوظة» زائفة في المحرر
      const md = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : raw
      if (typeof md !== 'string' || !md.trim()) return reply.code(400).send({ error: AR.knowledgeEmpty })
      if (Buffer.byteLength(md, 'utf8') > KNOWLEDGE_MAX) return reply.code(413).send({ error: AR.knowledgeTooBig })
      const at = now().toISOString()
      await deps.store.setKv('knowledge_md', md)
      await deps.store.setKv('knowledge_md_updated_at', at)
      return { markdown: md, updated_at: at }
    })

    // ── المقابلة الشخصية: «إعادة المقابلة» ← تبدأ من جديد مع رسالة المالك التالية (الذاكرة الحالية تبقى حتى تنتهي) ──
    api.post('/onboarding/restart', async () => {
      await resetInterview(deps.store)
      logger.info('لوحة التحكم: أُعيدت المقابلة الشخصية')
      return { ok: true }
    })

    // ── واتساب: QR وإعادة الربط عبر الوسيط ──
    const waBanned = () => !!deps.watchdog?.snapshot().banned
    api.get('/wa/qr', async (_req, reply) => {
      const gw = deps.gateway
      if (!gw?.getStatus) return reply.code(501).send({ error: AR.waUnsupported })
      let status: string
      try { status = (await gw.getStatus(deps.cfg.assistantPhone)).status } catch { return reply.code(502).send({ error: AR.waError }) }
      if (status === 'connected' || status === 'open') return { status, qr_png_base64: null }
      let qr: string | null = null
      if (gw.qrPng) { try { qr = (await gw.qrPng(deps.cfg.assistantPhone)).toString('base64') } catch { /* لم يجهز بعد */ } }
      return { status, qr_png_base64: qr }
    })
    api.post('/wa/relink', async (_req, reply) => {
      if (waBanned()) return reply.code(409).send({ error: AR.waBanned })
      const gw = deps.gateway
      if (!gw?.relink) return reply.code(501).send({ error: AR.waUnsupported })
      try { await gw.relink(deps.cfg.assistantPhone) } catch (err) {
        logger.warn({ err: String(err) }, 'لوحة التحكم: فشل relink')
        return reply.code(502).send({ error: AR.waError })
      }
      logger.info('لوحة التحكم: طُلبت إعادة ربط واتساب')
      return { ok: true }
    })

    // ── الحسابات: ربط واتساب عبر تسجيل الرقم في الوسيط (wa-link.ts) ──
    registerWaLinkRoutes(api, { store: deps.store, cfg: deps.cfg, now, ...deps.waLink })
  }, { prefix: '/api/dash' })

  logger.info('لوحة التحكم مفعّلة على /dashboard/')
  return true
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('؛ ')
}
