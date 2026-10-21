import { normalizeArabic } from './arabic.js'
import { toLatinDigits } from './phone.js'

/**
 * حواجز على نص الرد قبل ما يوصل المالك — كلها دوال نقية (تُختبر بلا نموذج).
 * تغطي أنماط تعثّر شائعة: "ما تقصد بـ ج؟"، حلقات التوضيح، "تم تأكيد" بلا فحص،
 * جملة فرنسية وسط الرد، والبوت يرد بـ "نعم 195" كأنه هو اللي يوافق.
 */

// ───────── (٨) أوامر الموافقة لا تخرج من البوت كرد ─────────

/** "نعم 195" / "لا 12" / "عدّل 3" — نص أمر موافقة (يكتبه المالك لا البوت) */
export const APPROVAL_CMD_RE = /^\s*[«"']?\s*(?:نعم|لا|عدّل|عدل|ادمج|موافق)\s*\d+\s*[»"']?\s*[.!؟?]?\s*$/

export function isApprovalEcho(text: string | null | undefined): boolean {
  return !!text && APPROVAL_CMD_RE.test(toLatinDigits(text))
}

/** خيار توضيح يحمل أمر موافقة أو رقم طلب معلّق ("[164] قنديل: …"، "نعم 194") */
export function isPendingRefOption(option: string): boolean {
  const t = toLatinDigits(option)
  return /^\s*\[\d+\]/.test(t) || /(?:^|\s)(?:نعم|لا|عدّل|عدل)\s*\d+/.test(t) || /طلب(?:\s+الكود)?\s+(?:رقم\s+)?\d+/.test(t)
}

/**
 * خيارات التوضيح من السياق الحقيقي فقط: لا أوامر موافقة، ولا طلبات معلّقة لم يذكرها المالك.
 * mentioned = نص رسالة المالك (رقم طلب ذكره هو مسموح).
 */
export function filterClarifyOptions(options: string[], mentioned: string): string[] {
  const nums = new Set([...toLatinDigits(mentioned).matchAll(/\d+/g)].map((m) => m[0]))
  return options
    .map((o) => o.trim())
    .filter(Boolean)
    .filter((o) => {
      if (!isPendingRefOption(o)) return true
      const refs = [...toLatinDigits(o).matchAll(/\d+/g)].map((m) => m[0])
      // أمر موافقة صريح لا يُعرض كخيار أبداً (الموافقة تُكتب من المالك نفسه)
      if (/(?:^|\s)(?:نعم|لا|عدّل|عدل)\s*\d+/.test(toLatinDigits(o))) return false
      return refs.length > 0 && refs.every((r) => nums.has(r))
    })
}

// ───────── (٢) "تصرف" = لا مزيد من الأسئلة ─────────

/** "انت تصرف" / "تصرف" / "جاوبني على السؤال" / "شوف المناسب" / "لا تسأل" */
export function isActDirective(text: string): boolean {
  const t = normalizeArabic(text)
  return /(^|\s)(انت\s+)?تصرف(\s|$)/.test(t) ||
    /جاوب(ني)?\s+(علي|ع)\s+(سوال|سؤال)/.test(t.replace(/ؤ/g, 'و')) ||
    /شوف\s+(مناسب|انسب|اللي\s+تشوفه)/.test(t) ||
    /(لا|بلا)\s+(تسال|اسيله|اسئله|تسالني)/.test(t) ||
    /(سو|سوي)\s+(اللي|الي)\s+تشوفه/.test(t)
}

/** "شغل السكربت الان" / "run backfill-uniform.ts" — تشغيل سكربت على سيرفر/قاعدة */
export function isRunScriptRequest(text: string): boolean {
  const t = toLatinDigits(text).toLowerCase()
  const verb = /(شغل|شغّل|تشغيل|نفذ|نفّذ|تنفيذ|run|execute|exec)/.test(t)
  const obj = /(سكربت|سكريبت|السكربت|السكريبت|script|backfill|[\w-]+\.(?:ts|js|mjs|cjs|sh|py)\b)/.test(t)
  return verb && obj
}

/** اسم سكربت مذكور في نص (scripts/backfill-uniform.ts أو Backfill-uniform.ts) */
export function scriptNameIn(text: string): string | null {
  const m = /((?:[\w.-]+\/)*[\w-]+\.(?:ts|js|mjs|cjs|sh|py))\b/i.exec(text)
  return m ? m[1] : null
}

// ───────── (١) جواب سؤال Claude: أ/ب/ج ↔ a/b/c ─────────

const AR_LETTERS = ['أ', 'ب', 'ج', 'د', 'ه', 'و']
const LAT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f']

/** "ج" / "الخيار ب" / "c" / "(ب)" ← فهرس الخيار (0 = أ/a)، وإلا null */
export function optionLetterIndex(answer: string): number | null {
  const t = answer.trim().replace(/[.!؟?]+$/, '').replace(/^(?:ال)?خيار\s*/, '').replace(/^[(\[]\s*|\s*[)\]]$/g, '').trim()
  const ar = t.replace(/^ا$/, 'أ')
  const i = AR_LETTERS.indexOf(ar)
  if (i >= 0) return i
  const j = LAT_LETTERS.indexOf(t.toLowerCase())
  return j >= 0 ? j : null
}

/**
 * يوسّع جواب الحرف لنص الخيار من نفس السؤال، مع مطابقة أ/ب/ج ↔ a/b/c
 * (مثلاً "ج" والسؤال فيه "(c) شي ثاني" ← "الخيار (c): شي ثاني").
 */
export function expandOptionAnswer(answer: string, question: string): string {
  const i = optionLetterIndex(answer)
  if (i === null) return answer
  for (const letter of [AR_LETTERS[i], LAT_LETTERS[i], LAT_LETTERS[i].toUpperCase()]) {
    const re = new RegExp(`[(\\[]\\s*${letter}\\s*[)\\]]\\s*([^\\n]*?)(?=\\s*(?:أو\\s*)?[(\\[]\\s*[${AR_LETTERS.join('')}a-fA-F]\\s*[)\\]]|[؟?\\n]|$)`)
    const m = re.exec(question)
    if (m) {
      const txt = m[1].replace(/[،,]\s*$/, '').replace(/\s+(?:أو|او)$/, '').trim()
      return `الخيار (${letter})${txt ? `: ${txt}` : ''}`
    }
  }
  return `الخيار (${AR_LETTERS[i]} / ${LAT_LETTERS[i]})`
}

// ───────── (٣) لا "تم تأكيد" بلا فحص ─────────

/** يدّعي إنه تحقق/أكّد/فحص/راجع شيئاً */
export function claimsVerification(text: string): boolean {
  return /(تمّ?|تم\s+ال)\s*(?:ال)?(تأكيد|تاكيد|تأكد|تاكد|تحقق|التحقق|فحص|الفحص|مراجعة|المراجعة)|(?:^|\s)(تأكدت|تاكدت|تحققت|فحصت|راجعت|اتأكدت|أكدت\s+(?:إن|ان))/.test(text)
}

/** المالك يطلب تحقق/تأكد ("تاكد من كلود"، "تحقق إن …") */
export function asksVerification(text: string): boolean {
  return /(تاكد|تأكد|اتاكد|اتأكد|تحقق|افحص|شيك|راجع|متأكد|متاكد)/.test(text)
}

/** ادعاء صريح بالتحقق (يُرفض بلا فحص حتى لو ما طلب المالك التحقق) */
export const STRONG_CLAIM_RE = /تمّ?\s*(?:ال)?(?:تأكيد|تاكيد|تحقق)|تأكدت|تاكدت|تحققت/

// ───────── (٧) لغة الرد: عربي (والإنجليزي/الكود مسموح) ─────────

const FOREIGN_STOP = new Set([
  // فرنسي
  'appartenant', 'utilisateur', 'les', 'des', 'du', 'est', 'une', 'pour', 'avec', 'dans', 'qui', 'que', 'sont', 'être', 'cette', 'ces',
  'aux', 'mais', 'nous', 'vous', 'leur', 'votre', 'notre', 'très', 'aussi', 'donc', 'selon', 'ainsi', 'mise', 'jour', 'fichiers', 'dépôt', 'synchronisation',
  // إسباني/برتغالي/إيطالي
  'los', 'las', 'del', 'una', 'para', 'por', 'pero', 'como', 'esta', 'este', 'sus', 'uma', 'não', 'com', 'della', 'delle', 'sono', 'perché', 'anche',
  // ألماني
  'und', 'der', 'das', 'nicht', 'ist', 'mit', 'für', 'von', 'dem', 'den', 'ein', 'eine', 'auch', 'wird', 'sind', 'oder',
])
const NON_EN_DIACRITIC = /[àâçéèêëîïôûùüÿœæñãõßäöìòáíóú]/i

/** يقص جمل/عبارات لاتينية بلغة غير الإنجليزية (فرنسي…) — الروابط والكود والإنجليزي تبقى */
export function stripForeignLatin(text: string): { text: string; changed: boolean } {
  // الكتل البرمجية والروابط لا تُلمس
  const protectedRe = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g
  const parts: string[] = []
  let last = 0
  let changed = false
  const isForeign = (w: string) => FOREIGN_STOP.has(w.toLowerCase()) || NON_EN_DIACRITIC.test(w) || /^[ldjnmsct]$/i.test(w)
  const clean = (seg: string) => seg.replace(/[A-Za-z0-9À-ÿœæ'’_/]+(?:[ \t'’-]+[A-Za-z0-9À-ÿœæ'’_/]+)*/g, (run) => {
    const words = run.split(/[ \t'’-]+/).filter(Boolean)
    const foreign = words.filter((w) => FOREIGN_STOP.has(w.toLowerCase()) || NON_EN_DIACRITIC.test(w))
    const accented = words.some((w) => NON_EN_DIACRITIC.test(w))
    if (!(accented || foreign.length >= 2)) return run
    changed = true
    // عبارة أغلبها أجنبي: تُحذف كلها عدا المعرّفات (أرقام، camelCase، _ أو /)؛ وإلا تُحذف الكلمات الأجنبية فقط
    const mostly = words.filter(isForeign).length * 2 >= words.length
    const keep = mostly
      ? words.filter((w) => !isForeign(w) && /\d|[a-z][A-Z]|[_/]/.test(w))
      : words.filter((w) => !isForeign(w))
    return keep.join(' ')
  })
  for (const m of text.matchAll(protectedRe)) {
    parts.push(clean(text.slice(last, m.index)), m[0])
    last = m.index! + m[0].length
  }
  parts.push(clean(text.slice(last)))
  const out = parts.join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+([،,.])/g, '$1')
  return { text: changed ? out : text, changed }
}

// ───────── (٩) الأسماء في قواعد البيانات ─────────

/** تطبيع اسم شخص للمطابقة: ة/ه، أ/ا، "با زرعة" = "بازرعة"، "أبو بكر" = "ابوبكر" */
export function normalizeName(s: string): string {
  return normalizeArabic(s)
    .replace(/(^|\s)(با|ابو|بو|بن|ال|عبد)\s+(?=\S)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** كل أجزاء الاسم موجودة في النص (بعد التطبيع؛ والمسافات لا تفرق "بازرعة"/"با زرعة") */
export function nameMatches(name: string, haystack: string): boolean {
  const n = normalizeName(name)
  if (!n) return true
  const h = normalizeName(haystack)
  const hs = h.replace(/\s+/g, '')
  return n.split(' ').every((tok) => h.includes(tok) || hs.includes(tok))
}

/** أسماء الجداول في SELECT (للتصريح: "بحثت في جدول …") */
export function tablesInSql(sql: string): string[] {
  const out = new Set<string>()
  for (const m of sql.matchAll(/\b(?:from|join)\s+((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)/gi)) {
    const t = m[1].replace(/"/g, '')
    if (!/^(select|lateral|unnest|generate_series)$/i.test(t)) out.add(t)
  }
  return [...out]
}

// ───────────── حالة البوت نفسه ─────────────
/** سؤال عن البوت نفسه (لا عن جهاز/نظام في المحادثة) */
export function asksAboutSelf(ownerText: string): boolean {
  return /(البوت|بوتك|انت|أنت|إنت|نفسك|واتسابك|واتساب البوت|رقم البوت|المساعد|شغال انت|متصل انت)/.test(ownerText)
}
/** جملة عن حالة البوت/واتسابه ("البوت الآن متصل والواتساب شغال ✅") */
const SELF_STATUS_RE = /[^.\n!؟?]*(?:(?:البوت|أنا|انا)\s*(?:الآن|الان|الحين|حالياً|حاليا)?\s*(?:متصل|شغال|مربوط|أونلاين)|(?:ال)?واتساب\s*(?:شغال|متصل|مربوط))[^.\n!؟?]*(?:[.!؟?]+|(?=\n)|$)/g

/** يحذف كلام البوت عن حالته إن لم يُسأل عن نفسه — "هل هو متصل؟" عن الوسيط ليست سؤالاً عن البوت */
export function stripSelfStatus(reply: string, ownerText: string): string {
  if (!reply || asksAboutSelf(ownerText)) return reply
  const out = reply.replace(SELF_STATUS_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return out || reply
}
