import { toLatinDigits } from './phone.js'

/**
 * قراءة ردّ المالك على طلب موافقة.
 * أمثلة: "نعم" ، "اي" ، "تمام" ، "👍" ، "1" ، "نعم 2" ، "لا" ، "الغ 3" ،
 *        "عدّل: النص الجديد" ، "عدل 2: النص الجديد"
 * أي نص آخر يرجع null — يُعامل كرسالة عادية وليس كموافقة (الأمان أولاً).
 */
export type ConfirmReply =
  | { kind: 'yes'; index?: number; unchecked?: boolean }
  | { kind: 'no'; index?: number }
  | { kind: 'edit'; text: string; index?: number }

const YES = ['نعم', 'ايوه', 'ايه', 'اي', 'إي', 'أي', 'ايوا', 'تمام', 'ارسل', 'أرسل', 'ارسلها', 'أرسلها',
  'موافق', 'اوكي', 'ok', 'okay', 'yes', 'y', 'ادمج', 'ادمجه', 'نفذ', '👍', '✅']
const NO = ['لا', 'الغ', 'ألغ', 'الغي', 'ألغي', 'إلغاء', 'الغاء', 'cancel', 'no', 'n', 'لاتسوي', 'لا ترسل', '❌', '👎']

function stripTashkeel(s: string) {
  return s.replace(/[ً-ٰٟـ]/g, '')
}

export function parseConfirmation(input: string): ConfirmReply | null {
  const raw = stripTashkeel(toLatinDigits(input)).trim()
  if (!raw) return null

  // عدّل[ رقم]: نص جديد
  const edit = /^(?:عدل|عدّل|تعديل|edit)\s*(\d+)?\s*[:：\-–]\s*([\s\S]+)$/i.exec(raw)
  if (edit) {
    const text = edit[2].trim()
    if (text) return { kind: 'edit', text, ...(edit[1] ? { index: +edit[1] } : {}) }
  }

  // "نعم N بدون فحص" — تجاوز صريح لبوابة الدمج (اختبارات ما اشتغلت / بلا dry-run)
  const unchecked = /^(\S+)\s*(\d+)\s+بدون\s+(?:فحص|تحقق)$/.exec(raw)
  if (unchecked) {
    const w = unchecked[1].toLowerCase()
    if (YES.includes(w)) return { kind: 'yes', index: +unchecked[2], unchecked: true }
  }

  // "1" وحدها = نعم (حسب الاتفاق)
  if (/^1$/.test(raw)) return { kind: 'yes' }

  const cleaned = raw.toLowerCase().replace(/[.!؟?،,]+$/g, '').trim()
  const m = /^(.+?)\s*(\d+)?$/.exec(cleaned)
  if (!m) return null
  const word = m[1].trim()
  const index = m[2] ? +m[2] : undefined
  const withIdx = <T extends object>(o: T) => (index !== undefined ? { ...o, index } : o)
  if (YES.includes(word)) return withIdx({ kind: 'yes' as const })
  if (NO.includes(word)) return withIdx({ kind: 'no' as const })
  return null
}

/**
 * قوة كلمة الموافقة:
 *  strong = كلمة صريحة (نعم، أرسل، موافق، نفّذ، ادمج)
 *  weak   = كلمات عابرة (تمام، اي، ok، 👍، 1) — تُقبل فقط لطلب إرسال وحيد أنشأته رسالتك السابقة مباشرة
 *  merge  = ما يكفي لدمج PR (مع رقم الطلب أو اقتباس المعاينة): نعم / ادمج / موافق
 */
const STRONG = ['نعم', 'ارسل', 'أرسل', 'ارسلها', 'أرسلها', 'موافق', 'نفذ', 'نفّذ', 'ادمج', 'ادمجه']
const MERGE = ['نعم', 'ادمج', 'ادمجه', 'موافق']

export function yesStrength(input: string): { strong: boolean; merge: boolean } {
  const word = stripTashkeel(toLatinDigits(input)).trim().toLowerCase()
    .replace(/[.!؟?،,]+$/g, '').replace(/\s+بدون\s+(?:فحص|تحقق)$/, '').replace(/\s*\d+$/, '').trim()
  return { strong: STRONG.includes(word), merge: MERGE.includes(word) }
}
