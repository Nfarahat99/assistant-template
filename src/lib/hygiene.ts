/** أدوات حارس النشر العام (src/public-hygiene.test.ts و scripts/hygiene-hash.mjs؛ القائمة في hygiene-deny.ts) */
import { createHash } from 'node:crypto'
import { normalizeArabic } from './arabic.js'
import { toLatinDigits } from './phone.js'

/** كلمات النص بحروف صغيرة وعربية موحّدة — أي حرف غير حرف/رقم فاصل */
export function tokens(text: string): string[] {
  return normalizeArabic(text.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** hash مصطلح من كلمة أو كلمتين */
export function termHash(term: string): string {
  const t = tokens(term)
  if (t.length < 1 || t.length > 2) throw new Error('term must be 1 or 2 words')
  return sha(t.join(' '))
}

const PREFIX = /^[ولبفك]/

/**
 * صيغ الكلمة بعد حذف السوابق الملتصقة: حرف واحد (و ل ب ف ك) حتى مرتين، ثم "ال" بعدها
 * ("والX"، "بالX"، "للX"، "لـX" — التطويل يحذفه normalizeArabic). الكلمة الأصلية تبقى أولاً.
 */
function variants(w: string): string[] {
  const out = new Set([w])
  let cur = [w]
  for (let k = 0; k < 2; k++) {
    const next: string[] = []
    for (const v of cur) if (v.length > 2 && PREFIX.test(v) && !out.has(v.slice(1))) { out.add(v.slice(1)); next.push(v.slice(1)) }
    cur = next
  }
  for (const v of [...out]) if (v.length > 3 && v.startsWith('ال')) out.add(v.slice(2))
  return [...out]
}

/** hash لكل كلمة ولكل زوج كلمات متتالية في النص — مع صيغها بلا سوابق ملتصقة */
export function textHashes(text: string): Set<string> {
  const t = tokens(text).map(variants)
  const out = new Set<string>()
  for (let i = 0; i < t.length; i++) {
    for (const a of t[i]!) {
      out.add(sha(a))
      if (i + 1 < t.length) for (const b of t[i + 1]!) out.add(sha(`${a} ${b}`))
    }
  }
  return out
}

/** حروف بعد \ تبقى فاصلاً (معناها في regex/النصوص ليس الحرف نفسه): \b \d \s \w \n \t \p \k \c، و \u \x غير المكتملة */
const KEEP_ESC = /\\([^bBdDsSwWnrtfv0-9pPkcux\\\s])/g

/**
 * "نسخة مفكوكة" من النص لكشف المصطلحات/الأرقام المخفية: تفك \uXXXX و \u{…} و \xXX،
 * وتحذف الشرطة المائلة قبل الحروف العادية (\- \. \m)، وتفك أقواس الحرف الواحد في regex ([5] ← 5).
 * تُفحص مع النص الأصلي (لا بدلاً منه).
 */
export function decodedView(text: string): string {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, h: string) => { const cp = parseInt(h, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(KEEP_ESC, '$1')
    .replace(/\[([^\]\\])\]/gu, '$1')
}

/** النص الأصلي + المفكوك (إن اختلف) */
const views = (text: string) => { const d = decodedView(text); return d === text ? [text] : [text, d] }

/** عدد المصطلحات الممنوعة (بدون تكرار) في النص أو نسخته المفكوكة */
export function deniedTerms(text: string, deny: ReadonlySet<string>): number {
  const found = new Set<string>()
  for (const v of views(text)) for (const h of textHashes(v)) if (deny.has(h)) found.add(h)
  return found.size
}

/** سطر فيه hash (64 hex) وحده — أسطر قائمة DENY نفسها */
const HASH_LINE = /^[ \t]*['"`]?[0-9a-f]{64}['"`]?,?[ \t]*\r?$/gim

const FAKE_PHONE = /^(96650000|96651111|050000|051111)/
/** جوال سعودي: 9665/+966 5/00966 5/05 + ٨ أرقام، مع مسافة أو شرطة اختيارية بين المجموعات (بعد تحويل الأرقام العربية) */
const PHONE = /(?<!\d)(?:(?:\+|00)?966[ -]?|0)5(?:[ -]?\d){8}(?!\d)/g
const phoneDigits = (m: string) => m.replace(/\D/g, '').replace(/^00/, '')

const RULES: Array<[string, RegExp, (m: string) => boolean]> = [
  ['phone', PHONE, (m) => !FAKE_PHONE.test(phoneDigits(m))],
  ['personal-email', /[\w.+-]+@(?:gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me)\.com\b/gi, () => true],
  ['railway-host', /\b[a-z0-9-]+\.up\.railway\.app\b/gi, (m) => !m.toLowerCase().startsWith('example')],
  ['secret', new RegExp([
    String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b`, String.raw`\bgithub_pat_[A-Za-z0-9_]{40,}\b`,
    String.raw`\bsk-ant-[A-Za-z0-9-]{20,}\b`,
    String.raw`\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}`, // OpenAI
    String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, String.raw`\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b`, String.raw`\bxox[bp]-[A-Za-z0-9-]{10,}`,
  ].join('|'), 'g'), () => true],
]

/**
 * أسماء القواعد المخالفة في النص أو نسخته المفكوكة (بدون تكرار، بترتيب القواعد).
 * skipHashLines: سطر hash وحده لا يُفحص كرقم جوال (ملفات قائمة DENY).
 */
export function ruleViolations(text: string, opts: { skipHashLines?: boolean } = {}): string[] {
  const out = new Set<string>()
  for (const v of views(text)) {
    const t = toLatinDigits(v) // نفس الطول: ٠-٩ و ۰-۹ ← 0-9
    for (const [name, re, bad] of RULES) {
      const s = name === 'phone' && opts.skipHashLines ? t.replace(HASH_LINE, '') : t
      if ([...s.matchAll(re)].some((m) => bad(m[0]))) out.add(name)
    }
  }
  return RULES.map(([n]) => n).filter((n) => out.has(n))
}

/** امتدادات ثنائية مسموحة (صور/خطوط/أرشيف) — أي ملف آخر فيه NUL بلا BOM يُرفض */
export const BINARY_OK = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf'])

/** نص الملف: UTF-16 حسب الـ BOM (FF FE / FE FF)، وإلا UTF-8؛ null = ثنائي (NUL بلا BOM) */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)))
    return body.swap16().toString('utf16le')
  }
  return buf.includes(0) ? null : buf.toString('utf8')
}

/**
 * فحص ملف متتبَّع واحد: المسار (مصطلحات ممنوعة)، ثم المحتوى (مصطلحات + القواعد إلا إذا rules=false)،
 * كلها على النص الأصلي ونسخته المفكوكة (decodedView).
 * buf = null ← الملف غير مقروء (محذوف من مجلد العمل) فيُفحص المسار فقط.
 */
export function scanFile(path: string, buf: Buffer | null, deny: ReadonlySet<string>, opts: { rules?: boolean; skipHashLines?: boolean } = {}): string[] {
  const hits: string[] = []
  if (deniedTerms(path, deny)) hits.push(`${path}: denied term in path`)
  if (!buf) return hits
  const text = decodeText(buf)
  if (text === null) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!BINARY_OK.has(ext)) hits.push(`${path}: unexpected binary`)
    return hits
  }
  const denied = deniedTerms(text, deny)
  if (denied) hits.push(`${path}: ${denied} denied term(s)`)
  if (opts.rules !== false) for (const r of ruleViolations(text, { skipHashLines: opts.skipHashLines })) hits.push(`${path}: ${r}`)
  return hits
}
