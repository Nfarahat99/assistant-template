/**
 * عميل Telegram Bot API الرسمي — fetch مباشر بلا مكتبات.
 * https://core.telegram.org/bots/api
 */
export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type?: string; title?: string; first_name?: string }
export interface TgFileRef { file_id: string; file_unique_id?: string; mime_type?: string; duration?: number; file_size?: number; file_name?: string }
export interface TgMessage {
  message_id: number
  date: number
  chat: TgChat
  from?: TgUser
  text?: string
  caption?: string
  voice?: TgFileRef
  audio?: TgFileRef
  photo?: (TgFileRef & { width: number; height: number })[]
  document?: TgFileRef
  /** رسالة محوّلة (Bot API 7+) */
  forward_origin?: { type: string; date?: number; sender_user?: TgUser; sender_user_name?: string; chat?: TgChat }
  reply_to_message?: TgMessage
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }

export interface TelegramApi {
  sendMessage(chatId: number | string, text: string, replyMarkup?: unknown): Promise<TgMessage>
  sendPhoto(chatId: number | string, png: Buffer, caption: string): Promise<TgMessage>
  /** getFile ثم تنزيل الملف — يرجع base64 */
  downloadFile(fileId: string): Promise<{ base64: string; path: string }>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  sendChatAction(chatId: number | string, action: 'typing'): Promise<void>
  editMessageText(chatId: number | string, messageId: number, text: string): Promise<void>
  editMessageReplyMarkup(chatId: number | string, messageId: number, replyMarkup?: unknown): Promise<void>
  setWebhook(url: string, secretToken: string): Promise<void>
  deleteWebhook(): Promise<void>
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>
}

export function httpTelegram(token: string, base = 'https://api.telegram.org'): TelegramApi {
  async function call<T>(method: string, body: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !j.ok) throw new Error(`Telegram ${method} ${res.status}: ${j.description ?? ''}`)
    return j.result as T
  }
  return {
    sendMessage: (chatId, text, replyMarkup) =>
      call('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), link_preview_options: { is_disabled: true }, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
    async sendPhoto(chatId, png, caption) {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('caption', caption.slice(0, 1024))
      form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'qr.png')
      const res = await fetch(`${base}/bot${token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
      const j = (await res.json().catch(() => ({}))) as any
      if (!res.ok || !j.ok) throw new Error(`Telegram sendPhoto ${res.status}: ${j.description ?? ''}`)
      return j.result
    },
    async downloadFile(fileId) {
      const f = await call<{ file_path: string }>('getFile', { file_id: fileId })
      const res = await fetch(`${base}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`Telegram file ${res.status}`)
      return { base64: Buffer.from(await res.arrayBuffer()).toString('base64'), path: f.file_path }
    },
    async sendChatAction(chatId, action) { await call('sendChatAction', { chat_id: chatId, action }) },
    async editMessageText(chatId, messageId, text) {
      await call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } })
    },
    async answerCallbackQuery(id, text) { await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }) },
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup ?? { inline_keyboard: [] } })
    },
    async setWebhook(url, secretToken) {
      await call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })
    },
    async deleteWebhook() { await call('deleteWebhook', { drop_pending_updates: false }) },
    getUpdates: (offset, timeoutSec) =>
      call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000),
  }
}
