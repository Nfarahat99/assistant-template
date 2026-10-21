import type { Config } from './config.js'
import type { GatewayClient, WaStatus } from './clients/gateway.js'
import type { NtfyClient } from './clients/ntfy.js'

/** مُنبّه خارج واتساب: تيليجرام (فوري) أو ntfy. immediate = نبّه عند أول لحظة انقطاع بلا مهلة */
export type Alerter = NtfyClient & { immediate?: boolean }

/**
 * حظر واتساب — لا فائدة من الاستئناف، والمالك يحتاج يعرف فوراً.
 * الوسيط الحقيقي يعيد للرقم المحظور: {"status":"paused","paused_reason":"حظره واتساب (403) — ...","last_disconnect_reason":null}
 */
export function isBan(s: { status?: string | null; last_disconnect_reason?: string | null; paused_reason?: string | null }): boolean {
  if (s.status === 'banned' || s.last_disconnect_reason === 'ban') return true
  return /403|حظر/.test(s.paused_reason ?? '')
}
import { formatClock } from './lib/time.js'
import { logger } from './logger.js'

const MIN = 60_000
const GRACE_MS = 2 * MIN                  // انقطاع أقصر من دقيقتين = تذبذب عادي
const RESUME_BACKOFF_MS = [2 * MIN, 5 * MIN, 15 * MIN]
const REALERT_MS = 30 * MIN
const RELINK_EVERY_MS = 60 * MIN

export const QR_MESSAGE = 'امسح هذا الرمز من جوال البوت: الأجهزة المرتبطة ← ربط جهاز'

const STATUS_AR: Record<WaStatus, string> = {
  connected: 'متصل', connecting: 'يحاول الاتصال', qr: 'ينتظر مسح QR', logged_out: 'مسجّل خروج',
  disconnected: 'مقطوع', paused: 'موقوف', unreachable: 'الوسيط لا يرد', banned: 'محظور',
}

export interface WatchdogHooks {
  /** يُستدعى عند الرجوع: يرسل للمالك ملخص الانقطاع + ما تجمّع في الصندوق */
  onRecovered(summary: string): Promise<void>
}

/**
 * حارس الاتصال: كل دقيقة يسأل الوسيط عن حالة رقم المساعد.
 *  - غير متصل > دقيقتين ← استئناف (resume) بتباعد ٢، ٥، ١٥ دقيقة.
 *  - ما زال مقطوعاً بعد أول استئناف، أو يحتاج QR ← تنبيه خارج واتساب (ntfy) كل ٣٠ دقيقة كحد أقصى.
 *  - logged_out ← relink (مرة في الساعة) ثم صورة QR في التنبيه ليمسحها من جوال البوت.
 *  - أثناء الانقطاع: isDown = true، والمساعد يخزّن رسائله محلياً بدل الوسيط.
 */
export class Watchdog {
  status: WaStatus = 'connected'
  reason: string | null = null
  downSince: number | null = null
  private resumeAttempts = 0
  private nextResumeAt: number | null = null
  private lastAlertAt: number | null = null
  private lastRelinkAt: number | null = null
  private qrDelivered = false
  private events: string[] = []
  private banNotified = false
  private pausedNotified = false
  pausedReason: string | null = null

  constructor(
    private cfg: Config,
    private gateway: GatewayClient,
    private ntfy: Alerter | null,
    private hooks: WatchdogHooks,
    private now: () => Date = () => new Date(),
  ) {}

  get isDown() { return this.downSince !== null }
  get enabled() { return typeof this.gateway.getStatus === 'function' }

  snapshot(): { status: WaStatus | 'disabled'; reason: string | null; paused_reason: string | null; banned: boolean; down_since: string | null; resume_attempts: number } {
    if (!this.cfg.whatsappEnabled) {
      return { status: 'disabled', reason: null, paused_reason: null, banned: false, down_since: null, resume_attempts: 0 }
    }
    return {
      status: this.status,
      reason: this.reason,
      paused_reason: this.pausedReason,
      banned: this.banNotified,
      down_since: this.downSince ? new Date(this.downSince).toISOString() : null,
      resume_attempts: this.resumeAttempts,
    }
  }

  private dashboard() { return this.cfg.gatewayDashboardUrl || this.cfg.gatewayUrl || undefined }
  private at(ms: number) { return formatClock(new Date(ms), this.now(), this.cfg.tz) }

  private async push(title: string, message: string, priority: 3 | 4 | 5 = 5) {
    if (!this.ntfy) { logger.warn({ title }, 'NTFY_TOPIC غير مضبوط — لا يمكن التنبيه خارج واتساب'); return }
    try {
      await this.ntfy.send({ title, message, priority, click: this.dashboard(), tags: ['warning'] })
    } catch (err) {
      logger.error({ err: String(err) }, 'فشل تنبيه ntfy')
    }
  }

  async check() {
    if (!this.cfg.whatsappEnabled) return
    if (!this.enabled) return
    let status: WaStatus
    let reason: string | null = null
    let pausedReason: string | null = null
    let banned = false
    try {
      const s = await this.gateway.getStatus!(this.cfg.assistantPhone)
      status = s.status ?? 'unreachable'
      pausedReason = typeof s.paused_reason === 'string' ? s.paused_reason : null
      reason = s.last_disconnect_reason ?? pausedReason ?? null
      banned = isBan({ status: s.status, last_disconnect_reason: s.last_disconnect_reason ?? null, paused_reason: pausedReason })
    } catch (err) {
      status = 'unreachable'
      reason = String((err as any)?.message ?? err)
    }
    this.status = status
    this.reason = reason
    this.pausedReason = pausedReason
    const now = this.now().getTime()

    if (status === 'connected') {
      if (this.isDown) await this.recover(now)
      return
    }

    if (!this.isDown) {
      this.downSince = now
      this.nextResumeAt = now + GRACE_MS
      this.events.push(`${this.at(now)} انقطع (${STATUS_AR[status] ?? status}${reason ? ` — ${reason}` : ''})`)
      logger.warn({ status, reason }, 'واتساب غير متصل')
      // تيليجرام: نبلّغ فوراً مع السبب (بلا مهلة) — الرسائل صارت تروح لتيليجرام تلقائياً
      if (this.ntfy?.immediate && !banned && status !== 'paused') {
        await this.push('⚠️ واتساب البوت انقطع',
          `الحالة: ${STATUS_AR[status] ?? status}${reason ? ` (${reason})` : ''}\nالرسائل بتجيك هنا في تيليجرام لين يرجع.`, 4)
      }
    }

    // ── حظر: رسالة واضحة مرة واحدة، ولا استئناف ولا relink ──
    if (banned) {
      if (!this.banNotified) {
        this.banNotified = true
        this.lastAlertAt = now
        this.events.push(`${this.at(now)} الرقم محظور`)
        await this.push('⛔ رقم البوت محظور من واتساب',
          `واتساب حظر رقم البوت${reason ? ` (${reason})` : ''}.\nتيليجرام الآن هو القناة الأساسية — كل الملخصات والتذكيرات والتحويلات بتجيك هنا.\nللرسائل للناس: استخدم روابط wa.me من رقمك.`, 5)
      }
      return
    }

    // ── موقوف (قاطع الدائرة / إيقاف يدوي): تنبيه واحد بالسبب، ولا استئناف تلقائي أبداً ──
    if (status === 'paused') {
      if (!this.pausedNotified) {
        this.pausedNotified = true
        this.lastAlertAt = now
        this.events.push(`${this.at(now)} الرقم موقوف${pausedReason ? ` (${pausedReason})` : ''}`)
        await this.push('⏸️ رقم البوت موقوف في الوسيط',
          `السبب: ${pausedReason ?? 'غير معروف'}
ما راح أحاول أشغّله تلقائياً — راجع لوحة الوسيط وشغّله يدوياً إذا كان آمناً.`, 5)
      }
      return
    }
    if (now - this.downSince! < GRACE_MS) return

    // ── يحتاج مسح QR ──
    if (status === 'logged_out' || status === 'qr') {
      if (status === 'logged_out' && this.gateway.relink &&
          (this.lastRelinkAt === null || now - this.lastRelinkAt >= RELINK_EVERY_MS)) {
        this.lastRelinkAt = now
        try {
          await this.gateway.relink(this.cfg.assistantPhone)
          this.events.push(`${this.at(now)} طلبت ربطاً جديداً (relink)`)
          this.qrDelivered = false
        } catch (err) {
          this.events.push(`${this.at(now)} فشل relink`)
          logger.error({ err: String(err) }, 'فشل relink')
        }
      }
      const due = this.lastAlertAt === null || now - this.lastAlertAt >= REALERT_MS
      if (due || !this.qrDelivered) await this.alertQr(now, due)
      return
    }

    // ── استئناف بتباعد ──
    // الاستئناف التلقائي فقط للحالات العالقة: disconnected / connecting
    if ((status === 'disconnected' || status === 'connecting') && this.gateway.resume && this.nextResumeAt !== null && now >= this.nextResumeAt) {
      const i = Math.min(this.resumeAttempts, RESUME_BACKOFF_MS.length - 1)
      this.resumeAttempts++
      this.nextResumeAt = now + RESUME_BACKOFF_MS[i]
      try {
        await this.gateway.resume(this.cfg.assistantPhone)
        this.events.push(`${this.at(now)} محاولة استئناف ${this.resumeAttempts}`)
      } catch (err) {
        this.events.push(`${this.at(now)} فشلت محاولة الاستئناف ${this.resumeAttempts}`)
        logger.error({ err: String(err) }, 'فشل resume')
      }
      if (this.resumeAttempts === 1) return   // نعطي أول استئناف فرصة قبل التنبيه
    }

    if (this.lastAlertAt === null || now - this.lastAlertAt >= REALERT_MS) {
      this.lastAlertAt = now
      this.events.push(`${this.at(now)} نبّهتك (ntfy)`)
      const mins = Math.round((now - this.downSince!) / MIN)
      await this.push('⚠️ واتساب البوت مقطوع!',
        `الحالة: ${STATUS_AR[status]}${reason ? ` (${reason})` : ''}\nمن ${mins} دقيقة. محاولات الاستئناف: ${this.resumeAttempts}.\nافتح لوحة الوسيط للتفاصيل.`)
    }
  }

  /** تنبيه مع صورة QR ليُمسح من جوال البوت — وإن تعذّرت الصورة، تنبيه نصي برابط اللوحة */
  private async alertQr(now: number, due: boolean) {
    let png: Buffer | null = null
    if (this.gateway.qrPng) {
      try { png = await this.gateway.qrPng(this.cfg.assistantPhone) } catch (err) {
        logger.warn({ err: String(err) }, 'رمز QR غير جاهز بعد')
      }
    }
    if (png && this.ntfy) {
      try {
        await this.ntfy.sendImage(png, {
          title: '📱 البوت يحتاج إعادة ربط', message: QR_MESSAGE, priority: 5, click: this.dashboard(), filename: 'qr.png',
        })
        this.qrDelivered = true
        this.lastAlertAt = now
        this.events.push(`${this.at(now)} أرسلت رمز QR (ntfy)`)
        return
      } catch (err) {
        logger.error({ err: String(err) }, 'فشل إرسال QR عبر ntfy')
      }
    }
    if (due) {
      this.lastAlertAt = now
      this.events.push(`${this.at(now)} نبّهتك: يحتاج QR`)
      await this.push('📱 البوت يحتاج إعادة ربط', `واتساب البوت ${STATUS_AR[this.status]}. افتح لوحة الوسيط وامسح رمز QR من جوال البوت: الأجهزة المرتبطة ← ربط جهاز`)
    }
  }

  private async recover(now: number) {
    const mins = Math.max(1, Math.round((now - this.downSince!) / MIN))
    this.events.push(`${this.at(now)} رجع متصل`)
    const summary = `✅ رجع البوت متصل (انقطع ${mins} دقيقة)\n${this.events.map((e) => `• ${e}`).join('\n')}`
    logger.info({ mins }, 'واتساب رجع متصل')
    this.downSince = null
    this.resumeAttempts = 0
    this.nextResumeAt = null
    this.lastAlertAt = null
    this.qrDelivered = false
    this.banNotified = false
    this.pausedNotified = false
    this.events = []
    await this.push('✅ رجع البوت متصل', `انقطع ${mins} دقيقة.`, 3)
    try { await this.hooks.onRecovered(summary) } catch (err) { logger.error({ err }, 'فشل ملخص الرجوع') }
  }
}
