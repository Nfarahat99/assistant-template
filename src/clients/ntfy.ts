/**
 * تنبيهات خارج واتساب عبر ntfy — لأن "واتساب مقطوع" لا يمكن إبلاغه عبر واتساب.
 * الموضوع (NTFY_TOPIC) سر عشوائي: من يعرفه يستقبل التنبيهات.
 * العناوين العربية تُرمَّز RFC 2047 (المعتمد في توثيق ntfy للترويسات غير اللاتينية).
 */
export interface NtfyMessage { title: string; message: string; priority?: 1 | 2 | 3 | 4 | 5; click?: string; tags?: string[] }

export interface NtfyClient {
  send(m: NtfyMessage): Promise<void>
  sendImage(png: Buffer, m: NtfyMessage & { filename?: string }): Promise<void>
}

export const rfc2047 = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

export function httpNtfy(baseUrl: string, topic: string): NtfyClient {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async send(m) {
      // النشر بـ JSON على الجذر: عربي بلا مشاكل ترميز
      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic, title: m.title, message: m.message, priority: m.priority ?? 4, tags: m.tags ?? [],
          ...(m.click ? { click: m.click, actions: [{ action: 'view', label: 'فتح اللوحة', url: m.click }] } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`ntfy ${res.status}`)
    },
    async sendImage(png, m) {
      // مرفق محلي: PUT بجسم الصورة، والنصوص في الترويسات
      const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
        method: 'PUT',
        headers: {
          Filename: m.filename ?? 'qr.png',
          Title: rfc2047(m.title),
          Message: rfc2047(m.message),
          Priority: String(m.priority ?? 5),
          ...(m.tags?.length ? { Tags: m.tags.join(',') } : {}),
          ...(m.click ? { Click: m.click } : {}),
        },
        body: new Uint8Array(png),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`ntfy ${res.status}`)
    },
  }
}
