/**
 * عميل تسجيل الأرقام في وسيط "واتساب سراج" (docs/gateway/whatsapp-siraj-changes.md §G3 و§G5):
 *   POST   /api/v1/numbers              (مفتاح التسجيل) → 201 {session_id, phone, mode, status, api_key, ...}
 *   DELETE /api/v1/numbers/:session_id  (مفتاح التسجيل) → {ok, session_id, logged_out}
 *   PUT    /api/v1/webhook              (مفتاح الرقم المقيّد) {url, secret, trusted_numbers}
 * الحالة وQR وإعادة الربط والإرسال عبر httpGateway الموجود (src/clients/gateway.ts) بمفتاح الرقم.
 * لا يُسجَّل المفتاح أبداً، ولا يظهر في أي رسالة خطأ.
 */
import { httpGateway, GatewayHttpError, type GatewayStatus } from '../clients/gateway.js'

export type ProvisionErrorCode =
  | 'unreachable' | 'timeout' | 'unauthorized' | 'conflict' | 'rate_limited' | 'bad_request' | 'limit' | 'not_found' | 'unknown'

export class ProvisionError extends Error {
  constructor(public readonly code: ProvisionErrorCode, message: string, public readonly httpStatus?: number) {
    super(message)
    this.name = 'ProvisionError'
  }
}

export const PROVISION_MSG = {
  unreachable: 'ما قدرت أوصل للوسيط — تأكد من GATEWAY_URL وأن الوسيط شغّال.',
  unauthorized: 'الوسيط رفض مفتاح التسجيل — راجع GATEWAY_PROVISION_KEY في الإعدادات.',
  numberKeyRevoked: 'مفتاح رقم المساعد ما عاد يشتغل — فك الربط واربطه من جديد.',
  webhookRejected: 'الوسيط رفض ضبط الويبهوك — راجع WEBHOOK_SECRET وPUBLIC_URL وجرّب مرة ثانية.',
  slow: 'الوسيط بطيء الحين — ما قدرت أتأكد من الحالة.',
  badPhone: 'الوسيط رفض الرقم — تأكد أنه رقم جوال صحيح.',
  badWebhook: 'الوسيط رفض رابط الاستقبال — لازم يكون رابط https عام (PUBLIC_URL) وسر WEBHOOK_SECRET ‏16 حرفاً أو أكثر.',
  limit: 'وصلت حد الأرقام المسموح لحسابك في الوسيط — احذف رقماً قديماً أو اطلب رفع الحد.',
  conflictMine: 'الرقم مسجّل عند الوسيط مسبقاً — كلّم صاحب الوسيط يحذفه أو يعطيك مفتاحه.',
  conflictOther: 'الرقم مربوط بحساب ثاني في الوسيط — استخدم رقماً غيره.',
  rateLimited: 'محاولات كثيرة على الوسيط — انتظر شوي وجرّب مرة ثانية.',
  notFound: 'الرقم غير موجود في الوسيط.',
  unknown: (s: number) => `الوسيط رد بخطأ غير متوقع (${s}).`,
} as const

const TIMEOUT_MS = 20_000

async function call(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new ProvisionError('unreachable', PROVISION_MSG.unreachable)
  }
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body: body ?? {} }
}

/** يحوّل رد خطأ من الوسيط لخطأ مفهوم؛ ctx يحدد الصياغة (number = طلب بمفتاح الرقم المقيّد) */
function toError(status: number, body: any, ctx: 'provision' | 'webhook' | 'delete' | 'number'): ProvisionError {
  if (status === 400) return new ProvisionError('bad_request', ctx === 'webhook' ? PROVISION_MSG.badWebhook : PROVISION_MSG.badPhone, status)
  // 403 بجسم فيه limit = بلغ حد الأرقام (§G3)؛ غير ذلك صلاحية
  if (status === 403 && body && typeof body === 'object' && 'limit' in body) return new ProvisionError('limit', PROVISION_MSG.limit, status)
  if (status === 401 || status === 403) {
    // webhook: يحدث أثناء الربط (بعده تراجع ولا ربط محفوظ) — فلا نقول «فك الربط»
    const msg = ctx === 'webhook' ? PROVISION_MSG.webhookRejected : ctx === 'number' ? PROVISION_MSG.numberKeyRevoked : PROVISION_MSG.unauthorized
    return new ProvisionError('unauthorized', msg, status)
  }
  if (status === 404) return new ProvisionError('not_found', PROVISION_MSG.notFound, status)
  if (status === 409) return new ProvisionError('conflict', body?.session_id ? PROVISION_MSG.conflictMine : PROVISION_MSG.conflictOther, status)
  if (status === 429) return new ProvisionError('rate_limited', PROVISION_MSG.rateLimited, status)
  return new ProvisionError('unknown', PROVISION_MSG.unknown(status), status)
}

export interface ProvisionedNumber { id: string; apiKey: string; phone: string }

export function provisionClient(baseUrl: string, provisionKey: string) {
  const base = baseUrl.replace(/\/+$/, '')
  const headers = { Authorization: `Bearer ${provisionKey}`, 'Content-Type': 'application/json' }
  /** §G5 — loggedOut=false: الجهاز ما انفك من الجوال (السوكت كان مقطوعاً) */
  async function deleteNumber(id: string): Promise<{ loggedOut: boolean }> {
    const { status, body } = await call(`${base}/api/v1/numbers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: headers.Authorization } })
    if (status < 200 || status >= 300) throw toError(status, body, 'delete')
    return { loggedOut: body?.logged_out !== false }
  }
  return {
    /** §G3 — المفتاح المرتجع يُعرض مرة واحدة فقط؛ المستدعي يشفّره فوراً */
    async provisionNumber(phone: string, name: string, webhook?: { url: string; secret: string }): Promise<ProvisionedNumber> {
      const { status, body } = await call(`${base}/api/v1/numbers`, {
        method: 'POST', headers,
        body: JSON.stringify({ phone, name, mode: 'sender', pairing: 'qr', ...(webhook ? { webhook } : {}) }),
      })
      if (status !== 201 && status !== 200) throw toError(status, body, 'provision')
      if (!body?.session_id || !body?.api_key) {
        // رقم أُنشئ بلا مفتاح = يتيم في الوسيط؛ نحذفه قبل الرمي (best-effort)
        if (body?.session_id) await deleteNumber(String(body.session_id)).catch(() => {})
        throw new ProvisionError('unknown', PROVISION_MSG.unknown(status), status)
      }
      return { id: String(body.session_id), apiKey: String(body.api_key), phone: String(body.phone ?? phone) }
    },
    deleteNumber,
  }
}
export type ProvisionClient = ReturnType<typeof provisionClient>

export function numberClient(baseUrl: string, apiKey: string) {
  const base = baseUrl.replace(/\/+$/, '')
  const gw = httpGateway(base, apiKey)
  /** httpGateway يرمي GatewayHttpError (فيه status) أو خطأ شبكة — نحوّلهما لخطأ عربي بلا تفاصيل داخلية */
  const mapErr = (err: unknown): ProvisionError => {
    if (err instanceof ProvisionError) return err
    if (err instanceof GatewayHttpError) return toError(err.status, {}, 'number')
    return new ProvisionError('unreachable', PROVISION_MSG.unreachable)
  }
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (err) { throw mapErr(err) }
  }
  return {
    async setWebhook(url: string, secret: string, trustedNumbers: string[] = []): Promise<void> {
      const { status, body } = await call(`${base}/api/v1/webhook`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret, trusted_numbers: trustedNumbers }),
      })
      if (status < 200 || status >= 300) throw toError(status, body, 'webhook')
    },
    /** timeoutMs: مهلة أقصر من مهلة httpGateway (للوحة حتى لا تعلق) — انتهاؤها = code 'timeout' */
    status: (from: string, timeoutMs?: number): Promise<GatewayStatus> => {
      const p = wrap(() => gw.getStatus!(from))
      if (!timeoutMs) return p
      let t: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ProvisionError('timeout', PROVISION_MSG.slow)), timeoutMs) })
      return Promise.race([p, timeout]).finally(() => clearTimeout(t))
    },
    /** null = الرمز لم يجهز بعد (404)؛ غير ذلك خطأ واضح (مفتاح ملغى، الوسيط لا يستجيب…) */
    qrPng: async (from: string): Promise<Buffer | null> => {
      try { return await gw.qrPng!(from) } catch (err) {
        if (err instanceof GatewayHttpError && err.status === 404) return null
        throw mapErr(err)
      }
    },
    relink: (from: string): Promise<void> => wrap(() => gw.relink!(from)),
    /** عميل الإرسال الخام لهذا الرقم — المستدعي يغلّفه بـ guardedGateway (المالك فقط) */
    gateway: gw,
    mapError: mapErr,
  }
}
export type NumberClient = ReturnType<typeof numberClient>

/** رسالة عربية لأسباب الانقطاع التي تهم شاشة الربط (§G4 و§G6) */
export function linkStatusMessage(st: { status?: string; last_disconnect_reason?: string | null }): string | null {
  const r = st.last_disconnect_reason
  if (r === 'phone_mismatch') return 'مسحت الرمز بجوال غير رقم المساعد المسجّل — جرّب مرة ثانية بجوال رقم المساعد.'
  if (r === 'qr_timeout') return 'انتهت مهلة الرمز — اضغط «رمز جديد» وامسحه خلال دقائق.'
  if (st.status === 'banned') return 'رقم المساعد محظور من واتساب — الربط ما راح ينجح حتى يُرفع الحظر.'
  return null
}
