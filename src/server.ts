import Fastify, { type FastifyInstance } from 'fastify'
import type { Assistant, InboundPayload } from './assistant.js'
import { timingSafeEqual } from 'node:crypto'
import { verifySignature } from './lib/hmac.js'
import { logger } from './logger.js'
import { registerDashboard, type DashboardDeps } from './dashboard/index.js'
import { registerCiGateway, type CiGateway } from './ci-gateway.js'

declare module 'fastify' {
  interface FastifyRequest { rawBody?: Buffer }
}

/**
 * الخادم: /health + /webhook/wa فقط.
 * الجسم الخام يُحفظ قبل التحليل لأن HMAC يُحسب على البايتات كما وصلت.
 */
export interface TelegramWebhook {
  path: string
  secretToken: string
  handle(update: any): Promise<void>
}

export function buildServer(opts: {
  assistant: Assistant
  webhookSecret: string
  health?: () => Promise<Record<string, unknown>>
  telegram?: TelegramWebhook
  /** لوحة التحكم — تُسجَّل فقط إن ضُبط DASHBOARD_PASSWORD */
  dashboard?: DashboardDeps | null
  /** (j) نبض اللابتوب: POST /api/heartbeat بتوكن HEARTBEAT_TOKEN */
  heartbeat?: { token: string; record: (info: { host: string | null; note: string | null }) => Promise<void> } | null
  /** بوابة قواعد البيانات (قراءة فقط) لـ Claude في GitHub Actions — تُسجَّل فقط إن ضُبط CI_GATEWAY_SECRET */
  ciGateway?: CiGateway | null
}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 })   // الصوتيات تصل base64

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer
    if (!(body as Buffer).length) return done(null, {})
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))) }
    catch { const e: any = new Error('JSON غير صالح'); e.statusCode = 400; done(e, undefined) }
  })

  // (j) نبض اللابتوب — Authorization: Bearer <HEARTBEAT_TOKEN>، جسم اختياري {host, note}
  if (opts.heartbeat?.token) {
    const hb = opts.heartbeat
    app.post('/api/heartbeat', async (req, reply) => {
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!safeEqual(given, hb.token)) return reply.code(401).send({ error: 'unauthorized' })
      const b = (req.body ?? {}) as { host?: unknown; note?: unknown }
      const clip = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null)
      await hb.record({ host: clip(b.host), note: clip(b.note) })
      return reply.code(200).send({ ok: true })
    })
  }

  app.get('/health', async () => ({ ok: true, service: 'assistant', ...(opts.health ? await opts.health() : {}) }))

  app.post('/webhook/wa', async (req, reply) => {
    const sig = req.headers['x-meem-signature'] as string | undefined
    if (!req.rawBody || !verifySignature(req.rawBody, sig, opts.webhookSecret)) {
      logger.warn({ ip: req.ip }, 'ويبهوك بتوقيع غير صالح — مرفوض')
      return reply.code(401).send({ error: 'invalid signature' })
    }
    const event = (req.headers['x-meem-event'] as string | undefined) ?? (req.body as any)?.event
    if (event !== 'message') return reply.code(200).send({ ok: true, ignored: true })

    const payload = req.body as InboundPayload
    if (!payload?.message_id) return reply.code(400).send({ error: 'message_id مطلوب' })
    const result = await opts.assistant.accept(payload)
    // نرد فوراً — المعالجة (تفريغ + نموذج + إرسال) تجري في الخلفية
    return reply.code(200).send({ ok: true, result })
  })

  // ويبهوك تيليجرام: مسار سري + ترويسة secret_token (تُقارن بزمن ثابت)
  if (opts.telegram) {
    const tg = opts.telegram
    app.post('/webhook/tg/:path', async (req, reply) => {
      const { path } = req.params as { path: string }
      const given = String(req.headers['x-telegram-bot-api-secret-token'] ?? '')
      const ok = safeEqual(path, tg.path) && safeEqual(given, tg.secretToken)
      if (!ok) {
        logger.warn({ ip: req.ip }, 'ويبهوك تيليجرام بسر خاطئ — مرفوض')
        return reply.code(401).send({ error: 'unauthorized' })
      }
      // نرد فوراً — تيليجرام يعيد الإرسال إن تأخرنا
      tg.handle(req.body).catch((err) => logger.error({ err }, 'فشل معالجة تحديث تيليجرام'))
      return reply.code(200).send({ ok: true })
    })
  }

  registerDashboard(app, opts.dashboard)
  registerCiGateway(app, opts.ciGateway)

  return app
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return !!b && x.length === y.length && timingSafeEqual(x, y)
}
