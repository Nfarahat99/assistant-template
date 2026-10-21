/**
 * رابط wa.me يفتح محادثة من رقم المالك نفسه والنص جاهز — الإرسال يدوي بضغطة منه.
 * https://wa.me/<رقم دولي بلا +>?text=<نص مرمّز>
 */
export function waLink(phone: string, text: string): string {
  const digits = phone.replace(/[^0-9]/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

/**
 * تيليجرام: البوت لا يستطيع مراسلة من لم يراسله أولاً (قيد Bot API) — فنعطي المالك رابط مشاركة
 * يفتح تيليجرام بالنص جاهزاً ويختار هو المستلم ويرسل من حسابه.
 */
export function tgShareLink(text: string): string {
  return `https://t.me/share/url?url=&text=${encodeURIComponent(text)}`
}

/** يستخرج الرقم من رابط wa.me داخل نص (مثلاً رسالة البوت المقتبسة) */
export function phoneFromWaLink(text: string | null | undefined): string | null {
  const m = /wa\.me\/(\d{8,15})/.exec(text || '')
  return m ? m[1] : null
}
