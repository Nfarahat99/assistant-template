/**
 * ربط واتساب من اللوحة ← الحسابات (يُسجَّل داخل نطاق /api/dash المحمي بالجلسة).
 *
 * التدفق (docs/gateway/whatsapp-siraj-changes.md §2):
 *   POST   /wa/link          تسجيل الرقم بمفتاح التسجيل → ضبط الويبهوك بمفتاح الرقم → حفظ الربط مشفّراً
 *   GET    /wa/link/qr       رمز QR (مفتاح الرقم من الربط المحفوظ)
 *   GET    /wa/link/status   الحالة؛ عند connected: ترحيب للمالك ثم إعادة تشغيل (ليُطبَّق الربط عند الإقلاع)
 *   POST   /wa/link/relink   رمز جديد بعد انتهاء المهلة أو مسح بجوال خطأ
 *   DELETE /wa/link          حذف الرقم من الوسيط + مسح الربط + إعادة تشغيل
 *
 * إعادة التشغيل = process.exit(75)؛ Railway (restartPolicyType ON_FAILURE) يعيد التشغيل.
 * لا يُسجَّل ولا يُرجَع مفتاح الرقم أبداً.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Store } from '../store.js'
import type { Config } from '../config.js'
import { isValidKey } from '../lib/secretbox.js'
import { normalizeMsisdn } from '../lib/phone.js'
import { assistantName } from '../profile.js'
import { logger } from '../logger.js'
import { loadWaLink, saveWaLink, clearWaLink, peekWaLink, waLinkConnected, WELCOMED_KEY, type WaLink } from '../whatsapp/link-store.js'
import { provisionClient, numberClient, ProvisionError, linkStatusMessage } from '../whatsapp/provision.js'
import { guardedGateway } from '../clients/gateway.js'

export type WaLinkReason = 'no_gateway' | 'no_provision_key' | 'no_secrets_key' | 'no_public_url' | 'no_webhook_secret' | 'env_assistant_phone'

export interface WaLinkDeps {
  store: Store
  cfg: Config
  /** للاختبار: بديل process.exit (يُستخدم فقط إن لم يُمرَّر restart) */
  exit?: (code: number) => void
  /** إعادة تشغيل نظيفة من index.ts: stop() ثم exit(75) */
  restart?: () => void | Promise<void>
  /** مهلة حالة الوسيط في GET /wa/link (افتراضي 4000ms) — بعدها status='unknown' */
  statusTimeoutMs?: number
  /** مهلة قبل إعادة التشغيل (افتراضي 1000ms) ليصل الرد للمتصفح */
  restartDelayMs?: number
  now?: () => Date
}

export const RESTART_EXIT_CODE = 75
const WEBHOOK_PATH = '/webhook/wa'

const AR = {
  unavailable: 'ربط واتساب من اللوحة غير متاح — إعدادات ناقصة.',
  exists: 'فيه ربط قائم — فكّه أول.',
  envManaged: 'واتساب مضبوط من متغيرات البيئة (GATEWAY_API_KEY) — احذفها أول لو تبي تربط من اللوحة.',
  envAssistant: 'رقم المساعد مضبوط من متغيرات البيئة (ASSISTANT_PHONE) — احذفه أول لو تبي تربط من اللوحة.',
  busy: 'فيه عملية ربط شغّالة الحين — انتظر لحظات.',
  restarting: 'المساعد يعيد التشغيل — جرّب بعد دقيقة.',
  none: 'ما فيه ربط واتساب.',
  locked: 'الربط محفوظ لكن ما قدرت أفك تشفيره — SECRETS_KEY ناقص أو تغيّر.',
  samePhone: 'رقم المساعد لازم يختلف عن رقمك.',
  badPhone: 'رقم جوال سعودي غير صالح — مثال: 05xxxxxxxx',
  risk: 'لازم توافق على تحذير الحظر أول.',
  manualRemove: 'ما قدرت أفك الجهاز من الجوال تلقائياً — افتحه: واتساب ← الأجهزة المرتبطة، واحذف الجهاز بنفسك.',
}

/** ما الناقص لربط واتساب من اللوحة — بالترتيب الذي يظهر للمالك */
export function waLinkMissing(cfg: Config): WaLinkReason[] {
  const m: WaLinkReason[] = []
  if (!cfg.gatewayUrl) m.push('no_gateway')
  if (!cfg.gatewayProvisionKey) m.push('no_provision_key')
  if (!cfg.secretsKey || !isValidKey(cfg.secretsKey)) m.push('no_secrets_key')
  if (!cfg.publicUrl) m.push('no_public_url')
  // الوسيط يشترط سراً من 16 محرفاً على الأقل
  if (!cfg.webhookSecret || cfg.webhookSecret.length < 16) m.push('no_webhook_secret')
  return m
}

const httpFor: Record<ProvisionError['code'], number> = {
  unreachable: 502, timeout: 504, unauthorized: 502, unknown: 502, not_found: 404,
  conflict: 409, limit: 409, rate_limited: 429, bad_request: 400,
}
const fail = (reply: FastifyReply, code: number, error: string, extra: Record<string, unknown> = {}) => reply.code(code).send({ error, ...extra })
const failProvision = (reply: FastifyReply, e: unknown) => {
  if (e instanceof ProvisionError) return fail(reply, httpFor[e.code], e.message, { code: e.code })
  throw e
}

export function registerWaLinkRoutes(api: FastifyInstance, deps: WaLinkDeps): void {
  const { store, cfg } = deps
  const now = deps.now ?? (() => new Date())
  const exit = deps.exit ?? ((c: number) => process.exit(c))
  const restart = deps.restart ?? (() => exit(RESTART_EXIT_CODE))
  const delay = deps.restartDelayMs ?? 1000
  const statusTimeout = deps.statusTimeoutMs ?? 4000
  let restartScheduled = false
  let busy = false
  /** يُضبط متزامناً قبل أول await — يمنع ترحيبين من استطلاعين متزامنين */
  let welcoming = false
  /** قيمة من البيئة (لا من ربط اللوحة المطبّق عند الإقلاع) */
  const fromEnv = (f: 'gatewayApiKey' | 'assistantPhone' | 'ownerPhone') => (cfg.waLinkFilled.includes(f) ? '' : cfg[f])
  /** المالك الفعلي: البيئة تغلب، وإلا رقم الربط */
  const effectiveOwner = (link: WaLink) => fromEnv('ownerPhone') || link.ownerPhone

  const scheduleRestart = (why: string) => {
    if (restartScheduled) return
    restartScheduled = true
    logger.info({ why }, 'ربط واتساب: إعادة تشغيل لتطبيق التغيير')
    setTimeout(() => { Promise.resolve().then(restart).catch((err) => { logger.error({ err: String(err) }, 'ربط واتساب: فشل الإيقاف النظيف'); exit(RESTART_EXIT_CODE) }) }, delay)
  }
  const provision = () => provisionClient(cfg.gatewayUrl, cfg.gatewayProvisionKey)
  const numbers = (link: WaLink) => numberClient(cfg.gatewayUrl, link.apiKey)
  const mustLoad = async (reply: FastifyReply): Promise<WaLink | null> => {
    const r = await loadWaLink(store, cfg.secretsKey)
    if (r.ok) return r.link
    fail(reply, r.reason === 'none' ? 404 : 409, r.reason === 'none' ? AR.none : AR.locked)
    return null
  }

  const phone = (label: string) => z.string().max(40).transform((s, ctx) => {
    const d = normalizeMsisdn(s, cfg.defaultCountryCode)
    const saudi = cfg.defaultCountryCode !== '966' || (d && /^9665\d{8}$/.test(d))
    if (!d || !saudi) { ctx.addIssue({ code: 'custom', message: `${label}: ${AR.badPhone}` }); return z.NEVER }
    return d
  })
  const LinkBody = z.object({
    assistantPhone: phone('رقم المساعد'),
    // OWNER_PHONE من البيئة يغلب: قيمة النموذج تُتجاهل
    ownerPhone: z.unknown().optional(),
    acceptRisk: z.literal(true, { error: AR.risk }),
  })

  // ── الحالة العامة للصفحة ──
  api.get('/wa/link', async () => {
    const missing: WaLinkReason[] = [...waLinkMissing(cfg), ...(fromEnv('assistantPhone') ? ['env_assistant_phone' as const] : [])]
    const base = { available: missing.length === 0, ...(missing.length ? { reason: missing[0], missing } : {}) }
    const r = await loadWaLink(store, cfg.secretsKey)
    if (r.ok) {
      const { link } = r
      let status: string | null = null, message: string | null = null, disconnectReason: string | null = null, errorCode: string | undefined
      if (cfg.gatewayUrl) {
        // مهلة قصيرة: الصفحة ما تعلق لو الوسيط بطيء ← unknown. غير ذلك (مفتاح ملغى، لا يستجيب) ← الرسالة العربية للصفحة
        try {
          const st = await numbers(link).status(link.assistantPhone, statusTimeout)
          status = st.status; message = linkStatusMessage(st); disconnectReason = st.last_disconnect_reason ?? null
        } catch (e) {
          if (e instanceof ProvisionError && e.code === 'timeout') status = 'unknown'
          else if (e instanceof ProvisionError) { status = e.code === 'unreachable' ? 'unreachable' : 'error'; message = e.message; errorCode = e.code }
          else throw e
        }
      }
      // pending: ربط محفوظ لم يتصل بعد (لا connectedAt) ← الصفحة تعرض شاشة الرمز، واستطلاع /status يكمل الربط
      const pending = !(await waLinkConnected(store, link))
      return { ...base, linked: true, source: 'dashboard', assistantPhone: link.assistantPhone, ownerPhone: link.ownerPhone, linkedAt: link.linkedAt, status, disconnectReason, message, ...(errorCode ? { errorCode } : {}), pending, active: cfg.whatsappEnabled && cfg.gatewayApiKey === link.apiKey }
    }
    if (r.reason !== 'none') {
      const p = await peekWaLink(store)
      return { ...base, linked: true, source: 'dashboard', locked: true, assistantPhone: p?.assistantPhone, ownerPhone: p?.ownerPhone, message: AR.locked }
    }
    if (cfg.whatsappEnabled) return { ...base, linked: true, source: 'env', assistantPhone: cfg.assistantPhone, ownerPhone: cfg.ownerPhone }
    const envOwner = fromEnv('ownerPhone')
    return { ...base, linked: false, ...(envOwner ? { ownerFromEnv: true, defaults: { ownerPhone: envOwner } } : {}) }
  })

  // ── بدء الربط ──
  api.post('/wa/link', async (req, reply) => {
    if (restartScheduled) return fail(reply, 409, AR.restarting)
    const missing = waLinkMissing(cfg)
    if (missing.length) return fail(reply, 409, AR.unavailable, { reason: missing[0], missing })
    if (await peekWaLink(store)) return fail(reply, 409, AR.exists)
    if (fromEnv('gatewayApiKey')) return fail(reply, 409, AR.envManaged)
    if (fromEnv('assistantPhone')) return fail(reply, 409, AR.envAssistant, { reason: 'env_assistant_phone' })
    const parsed = LinkBody.safeParse(req.body ?? {})
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? AR.badPhone)
    const envOwner = fromEnv('ownerPhone')
    let ownerPhone = envOwner
    if (!ownerPhone) {
      const o = phone('رقمك').safeParse(parsed.data.ownerPhone)
      if (!o.success) return fail(reply, 400, o.error.issues[0]?.message ?? AR.badPhone)
      ownerPhone = o.data
    }
    const b = { assistantPhone: parsed.data.assistantPhone, ownerPhone }
    if (b.assistantPhone === b.ownerPhone) return fail(reply, 400, AR.samePhone)
    if (busy) return fail(reply, 409, AR.busy)
    busy = true
    try {
      const pc = provision()
      const webhook = { url: `${cfg.publicUrl}${WEBHOOK_PATH}`, secret: cfg.webhookSecret }
      let num
      try { num = await pc.provisionNumber(b.assistantPhone, assistantName(), webhook) } catch (e) {
        logger.warn({ code: (e as ProvisionError)?.code }, 'ربط واتساب: فشل تسجيل الرقم')
        return failProvision(reply, e)
      }
      // من هنا: أي فشل = نحذف الرقم من الوسيط (rollback) ولا نكتب شيئاً في kv
      const rollback = async (step: string, e: unknown) => {
        logger.warn({ step, code: (e as ProvisionError)?.code, numberId: num.id }, 'ربط واتساب: تراجع — حذف الرقم من الوسيط')
        try { await pc.deleteNumber(num.id) } catch (de) { logger.error({ code: (de as ProvisionError)?.code, numberId: num.id }, 'ربط واتساب: فشل التراجع — احذف الرقم يدوياً من لوحة الوسيط') }
      }
      const link: WaLink = { assistantPhone: b.assistantPhone, ownerPhone: b.ownerPhone, apiKey: num.apiKey, linkedAt: now().toISOString(), numberId: num.id }
      try { await numbers(link).setWebhook(webhook.url, webhook.secret, [b.ownerPhone]) } catch (e) {
        await rollback('webhook', e)
        return failProvision(reply, e)
      }
      try { await saveWaLink(store, link, cfg.secretsKey) } catch (e) {
        await rollback('save', e)
        throw e
      }
      logger.info({ numberId: num.id }, 'ربط واتساب: سُجّل الرقم وضُبط الويبهوك — بانتظار مسح الرمز')
      return reply.code(201).send({ ok: true, numberId: num.id })
    } finally { busy = false }
  })

  // ── رمز QR ──
  api.get('/wa/link/qr', async (_req, reply) => {
    const link = await mustLoad(reply); if (!link) return reply
    let png: Buffer | null
    try { png = await numbers(link).qrPng(link.assistantPhone) } catch (e) { return failProvision(reply, e) }
    return { qr_png_base64: png ? png.toString('base64') : null }
  })

  // ── الحالة (يُستطلع من الصفحة أثناء الربط) ──
  // GET بأثر جانبي (ترحيب + إعادة تشغيل) — آمن: المسار خلف جلسة اللوحة، وكوكي الجلسة SameSite=Strict
  // فلا يُرسل من موقع آخر (لا CSRF)، والأثر مرة واحدة لكل ربط (WELCOMED_KEY + welcoming) ولا يقبل مدخلات.
  api.get('/wa/link/status', async (_req, reply) => {
    const link = await mustLoad(reply); if (!link) return reply
    const nc = numbers(link)
    let st
    try { st = await nc.status(link.assistantPhone) } catch (e) { return failProvision(reply, e) }
    const message = linkStatusMessage(st)
    if (st.status !== 'connected') return { status: st.status, reason: st.last_disconnect_reason ?? null, message }
    // أول اتصال لهذا الربط: connectedAt يُحفظ (قبل إعادة التشغيل — بدونه لا يُطبَّق الربط عند الإقلاع)، ثم ترحيب للمالك ثم إعادة تشغيل.
    // الإرسال عبر guardedGateway (وضع link): أي مستلم غير المالك الفعلي يُرفض — رسائل المالك لا تحتاج موافقة.
    if (welcoming) {
      // استطلاع متزامن والأول ما زال يحفظ connectedAt: هو من يجدول إعادة التشغيل
      if (!link.connectedAt) return { status: 'connected', restarting: true, message: null }
    } else {
      welcoming = true
      try {
        if (!link.connectedAt) {
          link.connectedAt = now().toISOString()
          await saveWaLink(store, link, cfg.secretsKey)
          logger.info({ numberId: link.numberId ?? null }, 'ربط واتساب: اتصل الرقم — حُفظ وقت الاتصال')
        }
        if ((await store.getKv(WELCOMED_KEY)) !== link.linkedAt) {
          await store.setKv(WELCOMED_KEY, link.linkedAt)
          const owner = effectiveOwner(link)
          const gw = guardedGateway(nc.gateway, { ownerPhone: owner, mode: 'link', messagedUsWithin24h: async () => false })
          try { await gw.sendText(link.assistantPhone, owner, `تم ربط واتساب ✅ — أنا ${assistantName()}`) } catch (e) {
            logger.warn({ code: nc.mapError(e).code }, 'ربط واتساب: تعذّر إرسال رسالة الترحيب')
          }
        }
      } finally { welcoming = false }
    }
    const restarting = restartScheduled || !(cfg.whatsappEnabled && cfg.gatewayApiKey === link.apiKey)
    if (restarting) scheduleRestart('connected')
    return { status: 'connected', restarting, message: null }
  })

  // ── رمز جديد ──
  api.post('/wa/link/relink', async (_req, reply) => {
    const link = await mustLoad(reply); if (!link) return reply
    try { await numbers(link).relink(link.assistantPhone) } catch (e) { return failProvision(reply, e) }
    return { ok: true }
  })

  // ── فك الربط ──
  api.delete('/wa/link', async (_req, reply) => {
    const meta = await peekWaLink(store)
    if (!meta) return fail(reply, 404, AR.none)
    let loggedOut = false
    if (meta.numberId) {
      if (!cfg.gatewayUrl || !cfg.gatewayProvisionKey) return fail(reply, 409, AR.unavailable, { reason: !cfg.gatewayUrl ? 'no_gateway' : 'no_provision_key' })
      try { loggedOut = (await provision().deleteNumber(meta.numberId)).loggedOut } catch (e) {
        // غير موجود في الوسيط = محذوف أصلاً؛ نكمل المسح محلياً
        if (!(e instanceof ProvisionError && e.code === 'not_found')) return failProvision(reply, e)
      }
    }
    await clearWaLink(store)
    await store.delKv(WELCOMED_KEY)
    logger.info({ numberId: meta.numberId ?? null, loggedOut }, 'ربط واتساب: فُك الربط')
    const restarting = cfg.whatsappEnabled
    if (restarting) scheduleRestart('unlinked')
    return { ok: true, logged_out: loggedOut, restarting, ...(loggedOut ? {} : { message: AR.manualRemove }) }
  })
}
