import type { GatewayClient } from './clients/gateway.js'

/**
 * قنوات التواصل مع المالك. خط المعالجة لا يعرف القناة: الرد يعود على نفس القناة التي جاءت منها
 * الرسالة، والرسائل الاستباقية (ملخصات، تذكيرات، تحويلات) تذهب لواتساب إن كان متصلاً وإلا لتيليجرام.
 */
export type ChannelName = 'whatsapp' | 'telegram'

/** زر مضمّن (تيليجرام) — data تربط الضغطة بطلب محدد (p:<id>:yes) لا بنص حر */
export interface Button { text: string; data: string }
export type Keyboard = Button[][]

/** مرجع الرسالة المرسلة: id لربط المعاينة، وquoteKey = ما سيأتي في quoted_message_id عند الرد عليها */
export interface SentRef { id: string | null; quoteKey: string | null }

export interface OwnerChannel {
  name: ChannelName
  /** هل يمكن الإرسال الآن؟ (واتساب: متصل؛ تيليجرام: المالك مربوط) */
  available(): boolean
  send(text: string, keyboard?: Keyboard): Promise<SentRef>
  sendPhoto?(png: Buffer, caption: string): Promise<void>
  /** مؤشر "يكتب…" فوري (تيليجرام) */
  typing?(): Promise<void>
  /** يعدّل رسالة سابقة (إشعار الاستلام ← الرد النهائي) — false إن تعذّر */
  edit?(ref: SentRef, text: string): Promise<boolean>
}

export function whatsappChannel(gateway: GatewayClient, from: string, owner: string, isUp: () => boolean): OwnerChannel {
  return {
    name: 'whatsapp',
    available: isUp,
    async send(text) {
      // واتساب بلا أزرار: النص نفسه يشرح "رد: نعم / لا"
      const res = await gateway.sendText(from, owner, text)
      return { id: res.id ?? null, quoteKey: null }
    },
  }
}
