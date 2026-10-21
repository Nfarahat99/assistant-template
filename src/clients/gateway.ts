/**
 * عميل وسيط "واتساب سراج" — راجع README الوسيط:
 *   POST /api/v1/messages      → 202 {id, status:"queued", ...}
 *   GET  /api/v1/messages/:id  → {status: queued|sent|failed, scheduled_at, error, ...}
 */
export interface GatewayMessage {
  id: string
  status: string
  scheduled_at?: string | null
  error?: string | null
  /** رد 202 فقط: تقدير ثواني حتى الإرسال، وهل الرقم في المسار السريع */
  eta_seconds?: number | null
  fast_lane?: boolean
  [k: string]: unknown
}

/** حالة رقم المساعد في الوسيط — GET /api/v1/status */
export type WaStatus = 'connected' | 'connecting' | 'qr' | 'logged_out' | 'disconnected' | 'paused' | 'unreachable' | 'banned'
export interface GatewayStatus { status: WaStatus; last_disconnect_reason?: string | null; [k: string]: unknown }

export interface GatewayClient {
  sendText(from: string, to: string, text: string): Promise<GatewayMessage>
  getMessage(id: string): Promise<GatewayMessage>
  /** إرسال نص إلى قروب واتساب (jid ينتهي بـ @g.us) — لا يُستدعى إلا بعد موافقة المالك على الرد */
  sendGroupText?(from: string, groupJid: string, text: string): Promise<GatewayMessage>
  /** الإصلاح الذاتي (فرع feat/session-selfheal في الوسيط) — اختيارية لتبقى المحاكيات بسيطة */
  getStatus?(from: string): Promise<GatewayStatus>
  resume?(from: string): Promise<void>
  relink?(from: string): Promise<void>
  qrPng?(from: string): Promise<Buffer>
}

/** خطأ HTTP من الوسيط — status للمستدعي بدل تحليل نص الرسالة (نفس الرسائل السابقة) */
export class GatewayHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'GatewayHttpError' }
}

export function httpGateway(baseUrl: string, apiKey: string): GatewayClient {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  return {
    async sendText(from, to, text) {
      const res = await fetch(`${baseUrl}/api/v1/messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ from, to, kind: 'text', text }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new GatewayHttpError(res.status, `الوسيط ${res.status}: ${body.error ?? 'خطأ غير معروف'}`)
      return body as GatewayMessage
    },
    async sendGroupText(from, groupJid, text) {
      const res = await fetch(`${baseUrl}/api/v1/messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ from, to: groupJid, kind: 'text', text, group: true }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new GatewayHttpError(res.status, `الوسيط ${res.status}: ${body.error ?? 'خطأ غير معروف'}`)
      return body as GatewayMessage
    },
    async getStatus(from) {
      const res = await fetch(`${baseUrl}/api/v1/status?from=${encodeURIComponent(from)}`, { headers, signal: AbortSignal.timeout(15_000) })
      const body = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new GatewayHttpError(res.status, `الوسيط ${res.status}: ${body.error ?? 'خطأ غير معروف'}`)
      return body as GatewayStatus
    },
    async resume(from) {
      const res = await fetch(`${baseUrl}/api/v1/session/resume`, {
        method: 'POST', headers, body: JSON.stringify({ from }), signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new GatewayHttpError(res.status, `resume ${res.status}`)
    },
    async relink(from) {
      const res = await fetch(`${baseUrl}/api/v1/session/relink`, {
        method: 'POST', headers, body: JSON.stringify({ from }), signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new GatewayHttpError(res.status, `relink ${res.status}`)
    },
    async qrPng(from) {
      const res = await fetch(`${baseUrl}/api/v1/session/qr?format=png&from=${encodeURIComponent(from)}`, {
        headers: { Authorization: headers.Authorization }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new GatewayHttpError(res.status, `qr ${res.status}`)
      // الوسيط يرجع JSON فيه qr_png_base64 (+ expires_hint_s)؛ ونقبل PNG خاماً للتوافق
      if (/json/i.test(res.headers.get('content-type') ?? '')) {
        const body = (await res.json().catch(() => ({}))) as any
        const b64 = typeof body?.qr_png_base64 === 'string' ? body.qr_png_base64.replace(/^data:image\/png;base64,/, '') : ''
        if (!b64) throw new GatewayHttpError(404, 'qr 404')
        return Buffer.from(b64, 'base64')
      }
      return Buffer.from(await res.arrayBuffer())
    },
    async getMessage(id) {
      const res = await fetch(`${baseUrl}/api/v1/messages/${encodeURIComponent(id)}`, {
        headers, signal: AbortSignal.timeout(15_000),
      })
      const body = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new GatewayHttpError(res.status, `الوسيط ${res.status}: ${body.error ?? 'خطأ غير معروف'}`)
      return body as GatewayMessage
    },
  }
}

/**
 * هل الرسالة مؤجلة (نافذة صمت / طابور)؟
 * الأولوية لـ eta_seconds الذي يعيده الوسيط في رد 202 (تقدير يشمل وقت الصمت)،
 * ثم أي حقل موعد (scheduled_at في GET). مؤجلة = أكثر من دقيقتين من الآن.
 */
export function deferredUntil(msg: GatewayMessage, now: Date): Date | null {
  let d: Date | null = null
  const eta = typeof msg.eta_seconds === 'number' ? msg.eta_seconds : Number(msg.eta_seconds)
  if (msg.eta_seconds != null && Number.isFinite(eta)) {
    d = new Date(now.getTime() + eta * 1000)
  } else {
    const cand = [msg.eta, msg.quiet_until, msg.deliver_after, msg.scheduled_at]
      .find((v) => typeof v === 'string' && v) as string | undefined
    if (cand && !isNaN(new Date(cand).getTime())) d = new Date(cand)
  }
  return d && d.getTime() - now.getTime() > 120_000 ? d : null
}

/**
 * حارس صارم على طبقة العميل: رقم البوت يكلّم المالك فقط.
 * خلفية: الرقم حُظر (403) بعد ثوانٍ من أول رسالة لغريب، وفُصل قبلها بعد أول رسالة للوالدة.
 *  - link   (الافتراضي): أي مستلم غير المالك = استثناء. الرسائل للناس تُرسل من رقم المالك عبر رابط wa.me.
 *  - direct : يُسمح لغير المالك فقط إن راسل هو البوت خلال ٢٤ ساعة (لا "أول تواصل" من البوت أبداً).
 */
export class ThirdPartyBlockedError extends Error {
  constructor(to: string, why: string) { super(`ممنوع الإرسال من رقم البوت إلى ${to}: ${why}`) }
}

export function guardedGateway(
  inner: GatewayClient,
  opts: { ownerPhone: string; mode: 'link' | 'direct' | (() => 'link' | 'direct'); messagedUsWithin24h: (phone: string) => Promise<boolean>; allowlist?: string[] },
): GatewayClient {
  return {
    ...inner,
    // القروب: فقط jid حقيقي لقروب (@g.us) — والمستدعي (الموافقة على group_reply) هو الحارس الفعلي
    ...(inner.sendGroupText ? {
      async sendGroupText(from: string, groupJid: string, text: string) {
        if (!/^[0-9]+(-[0-9]+)*@g\.us$/.test(groupJid)) throw new ThirdPartyBlockedError(groupJid, 'ليس معرّف قروب صالحاً')
        return inner.sendGroupText!(from, groupJid, text)
      },
    } : {}),
    async sendText(from, to, text) {
      const digits = String(to).replace(/[^0-9]/g, '')
      if ((!opts.ownerPhone || digits !== opts.ownerPhone) && !opts.allowlist?.includes(digits)) {
        const mode = typeof opts.mode === 'function' ? opts.mode() : opts.mode
        if (mode !== 'direct') throw new ThirdPartyBlockedError(digits, 'وضع link — رقم البوت للمالك فقط')
        if (!(await opts.messagedUsWithin24h(digits))) throw new ThirdPartyBlockedError(digits, 'لم يراسل البوت خلال ٢٤ ساعة')
      }
      return inner.sendText(from, to, text)
    },
  }
}
