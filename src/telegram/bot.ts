import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { Store } from '../store.js'
import type { InboundPayload } from '../assistant.js'
import type { OwnerChannel, Keyboard } from '../channels.js'
import type { NtfyMessage } from '../clients/ntfy.js'
import type { TelegramApi, TgMessage, TgUpdate } from './client.js'
import { assistantName } from '../profile.js'
import { logger } from '../logger.js'

/** ما يحتاجه البوت من المساعد — واجهة ضيقة لتسهيل الاختبار */
export interface TelegramSink {
  acceptTelegram(p: InboundPayload): Promise<'duplicate' | 'queued'>
  onButton(data: string): Promise<void>
  /** بعد ربط المالك (/start <الرمز>) — المساعد يبدأ المقابلة الشخصية لو ذاكرته ما زالت قالباً */
  onOwnerBound?(): Promise<void>
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** مسار وسر الويبهوك: من البيئة، أو مشتقان من التوكن (ثابتان بين الإقلاعات، ولا يكشفان التوكن) */
export function telegramSecrets(cfg: Config) {
  const derive = (label: string) => createHash('sha256').update(`${label}:${cfg.telegramBotToken}`).digest('hex').slice(0, 40)
  return {
    path: cfg.telegramWebhookPath || derive('path'),
    token: cfg.telegramWebhookSecret || derive('secret'),
  }
}

/**
 * قناة تيليجرام (Bot API الرسمي — بلا خطر حظر).
 * ربط المالك: TELEGRAM_OWNER_CHAT_ID، أو أول محادثة ترسل "/start <TELEGRAM_LINK_CODE>" (تُحفظ في kv).
 * أي محادثة أخرى تُتجاهل تماماً.
 */
export class TelegramBot {
  ownerChat: string | null = null
  private stopped = false

  constructor(private cfg: Config, private api: TelegramApi, private store: Store, private sink: TelegramSink) {}

  async init() {
    this.ownerChat = this.cfg.telegramOwnerChatId || (await this.store.getKv('tg_owner_chat')) || null
  }

  get bound() { return !!this.ownerChat }

  // ─────────── القناة ───────────

  channel(): OwnerChannel {
    return {
      name: 'telegram',
      available: () => this.bound,
      send: async (text: string, keyboard?: Keyboard) => {
        const m = await this.api.sendMessage(this.ownerChat!, text, keyboard?.length ? {
          inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
        } : undefined)
        return { id: `tg:${m.message_id}`, quoteKey: `tg:${m.message_id}` }
      },
      sendPhoto: async (png: Buffer, caption: string) => { await this.api.sendPhoto(this.ownerChat!, png, caption) },
      typing: async () => { await this.api.sendChatAction(this.ownerChat!, 'typing') },
      edit: async (ref, text) => {
        const id = Number(String(ref.id ?? '').replace(/^tg:/, ''))
        if (!id) return false
        try { await this.api.editMessageText(this.ownerChat!, id, text); return true } catch { return false }
      },
    }
  }

  /** تنبيهات الحارس عبر تيليجرام (نفس واجهة ntfy) — فورية */
  alerter() {
    const fmt = (m: NtfyMessage) => `${m.title}\n${m.message}${m.click ? `\n${m.click}` : ''}`
    return {
      immediate: true,
      send: async (m: NtfyMessage) => { if (this.bound) await this.api.sendMessage(this.ownerChat!, fmt(m)) },
      sendImage: async (png: Buffer, m: NtfyMessage) => { if (this.bound) await this.api.sendPhoto(this.ownerChat!, png, fmt(m)) },
    }
  }

  // ─────────── الاستقبال ───────────

  async handleUpdate(u: TgUpdate) {
    if (!(await this.store.markSeen(`tgu:${u.update_id}`))) return

    if (u.callback_query) {
      const cq = u.callback_query
      const chat = String(cq.message?.chat.id ?? cq.from.id)
      if (!this.bound || chat !== this.ownerChat) {
        logger.warn({ chat }, 'ضغطة زر من محادثة غير المالك — تجاهل')
        await this.api.answerCallbackQuery(cq.id).catch(() => {})
        return
      }
      await this.api.answerCallbackQuery(cq.id, '👍').catch(() => {})
      // نزيل الأزرار بعد الضغط — لا ضغطة ثانية على نفس المعاينة
      if (cq.message) await this.api.editMessageReplyMarkup(chat, cq.message.message_id).catch(() => {})
      if (cq.data) await this.sink.onButton(cq.data)
      return
    }

    const m = u.message
    if (!m) return
    const chat = String(m.chat.id)

    if (!this.bound) {
      const start = /^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(m.text ?? '')
      if (start && this.cfg.telegramLinkCode && safeEq(start[1], this.cfg.telegramLinkCode)) {
        this.ownerChat = chat
        await this.store.setKv('tg_owner_chat', chat)
        logger.info({ chat }, 'تم ربط المالك بتيليجرام')
        await this.api.sendMessage(chat, `✅ تم ربطك — أنا ${assistantName()}، كلمني هنا مثل واتساب تماماً (نص، صوتيات، رسائل محوّلة، لقطات شاشة).`)
        // المقابلة الشخصية تبدأ مباشرة بعد رسالة الربط (لو الذاكرة قالب) — فشلها لا يفسد الربط
        await this.sink.onOwnerBound?.().catch((err) => logger.error({ err: String(err) }, 'تعذّر بدء المقابلة بعد الربط'))
      } else {
        logger.warn({ chat }, 'محادثة تيليجرام غير مربوطة — تجاهل')
      }
      return
    }
    if (chat !== this.ownerChat) {
      logger.warn({ chat }, 'رسالة تيليجرام من غير المالك — تجاهل')
      return
    }
    if (/^\/start\b/.test(m.text ?? '')) {
      await this.api.sendMessage(chat, 'أنت مربوط ✅ — أرسل "مساعدة" للأوامر.')
      return
    }

    const p = await this.toPayload(m)
    if (p) await this.sink.acceptTelegram(p)
  }

  /** رسالة تيليجرام ← نفس شكل حمولة الوسيط، فيعمل خط المعالجة كما هو */
  async toPayload(m: TgMessage): Promise<InboundPayload | null> {
    const base = {
      event: 'message',
      message_id: `tg:${m.chat.id}:${m.message_id}`,
      from: this.cfg.ownerPhone,
      from_jid: `tg:${m.chat.id}`,
      session_phone: this.cfg.assistantPhone,
      push_name: m.from?.first_name ?? null,
      timestamp: m.date,
      quoted_message_id: m.reply_to_message ? `tg:${m.reply_to_message.message_id}` : null,
      quoted_text: m.reply_to_message?.text ?? m.reply_to_message?.caption ?? null,
      forwarded: !!m.forward_origin,
      forward_name: forwardName(m),
    }
    const text = (m.text ?? m.caption ?? '').trim() || null
    const file = m.voice ?? m.audio
    try {
      if (file) {
        const f = await this.api.downloadFile(file.file_id)
        return { ...base, type: 'audio', text, media: { mimetype: file.mime_type ?? 'audio/ogg', base64: f.base64, seconds: file.duration ?? null, ptt: !!m.voice, file_name: null } } as InboundPayload
      }
      const photo = m.photo?.length ? m.photo[m.photo.length - 1] : (m.document?.mime_type?.startsWith('image/') ? m.document : null)
      if (photo) {
        const f = await this.api.downloadFile(photo.file_id)
        return { ...base, type: 'image', text, media: { mimetype: (photo as any).mime_type ?? 'image/jpeg', base64: f.base64, seconds: null, ptt: false, file_name: null } } as InboundPayload
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'تعذّر تنزيل ملف تيليجرام')
      await this.api.sendMessage(m.chat.id, 'ما قدرت أحمّل الملف 🙏 أرسله مرة ثانية').catch(() => {})
      return null
    }
    if (!text) return { ...base, type: 'other', text: null, media: null } as InboundPayload
    return { ...base, type: 'text', text, media: null } as InboundPayload
  }

  // ─────────── النقل: ويبهوك أو استطلاع ───────────

  /** ويبهوك إن وُجد رابط عام، وإلا long polling */
  async start() {
    const { path, token } = telegramSecrets(this.cfg)
    if (this.cfg.publicUrl) {
      await this.api.setWebhook(`${this.cfg.publicUrl}/webhook/tg/${path}`, token)
      logger.info('تيليجرام: ويبهوك مفعّل')
      return
    }
    await this.api.deleteWebhook().catch(() => {})
    logger.info('تيليجرام: لا PUBLIC_URL — استطلاع (long polling)')
    void this.poll()
  }

  stop() { this.stopped = true }

  private async poll() {
    let offset = Number((await this.store.getKv('tg_offset')) ?? 0)
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(offset, 30)
        for (const u of updates) {
          offset = u.update_id + 1
          await this.handleUpdate(u).catch((err) => logger.error({ err }, 'فشل معالجة تحديث تيليجرام'))
        }
        if (updates.length) await this.store.setKv('tg_offset', String(offset))
      } catch (err) {
        logger.warn({ err: String(err) }, 'فشل getUpdates — إعادة بعد ٥ث')
        await new Promise((r) => setTimeout(r, 5_000))
      }
    }
  }
}

function forwardName(m: TgMessage): string | null {
  const o = m.forward_origin
  if (!o) return null
  if (o.sender_user) return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') || null
  return o.sender_user_name ?? o.chat?.title ?? null
}
