/**
 * بحث الأسماء العربية في SQL الذي يكتبه النموذج — التطبيع في الكود لا عبر النموذج.
 * أمس: النموذج طبّع العمود (ة←ه) ولم يطبّع النص المبحوث '%بازرعة%' ← صفر صفوف و«ما لقيت»
 * والطالب موجود. هنا: كل مقارنة LIKE/ILIKE على نص عربي يُطبَّع طرفاها معاً:
 * التشكيل والتطويل يُحذفان، أ/إ/آ←ا، ى←ي، ة←ه، ؤ←و، ئ←ي، والمسافات تُحذف ("با زرعة"≈"بازرعة")،
 * وبحث "يحتوي" بعدة كلمات ← كل جزء على حدة (AND).
 */

const AR = /[؀-ۿ]/
const DIAC_RE = /[ً-ْٰـ]/g
const FROM = 'أإآىةؤئ'
const TO = 'ااايهوي'

export function normalizeArabicLiteral(s: string): string {
  let out = s.replace(DIAC_RE, '')
  for (let i = 0; i < FROM.length; i++) out = out.split(FROM[i]).join(TO[i])
  return out.replace(/\s+/g, '')
}

/** تعبير SQL يطبّع العمود بنفس قواعد النص */
export function normalizedExpr(expr: string): string {
  return `replace(translate(regexp_replace((${expr})::text,'[ً-ْٰـ]','','g'),'${FROM}','${TO}'),' ','')`
}

/** أجزاء الاسم: الكلمات القصيرة (با، بن، أبو…) تلتصق بما بعدها */
export function nameParts(inner: string): string[] {
  const toks = inner.split(/[\s%]+/).map((t) => t.trim()).filter(Boolean)
  const out: string[] = []
  let carry = ''
  for (const t of toks) {
    const n = normalizeArabicLiteral(carry + t)
    if (normalizeArabicLiteral(t).length <= 2 && AR.test(t)) { carry += t; continue }
    out.push(n); carry = ''
  }
  if (carry) {
    if (out.length) out[out.length - 1] = out[out.length - 1] + normalizeArabicLiteral(carry)
    else out.push(normalizeArabicLiteral(carry))
  }
  return out.filter(Boolean)
}

interface Hit { start: number; end: number; text: string }

/** يعيد كتابة كل `<تعبير> [NOT] (I)LIKE '<نص عربي>'` — وإلا يرجع الجملة كما هي */
export function arabicSearchSql(sql: string): string {
  const hits: Hit[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") { i = skipString(sql, i); continue }
    if (ch === '"') { const j = sql.indexOf('"', i + 1); i = j < 0 ? sql.length : j + 1; continue }
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; continue }
    const m = /^(i?like)\b/i.exec(sql.slice(i, i + 6))
    if (m && !/[\w]/.test(sql[i - 1] ?? ' ')) {
      const kwStart = i
      const kw = m[1]
      let j = i + kw.length
      while (/\s/.test(sql[j] ?? '')) j++
      if (sql[j] === "'") {
        const litEnd = skipString(sql, j)
        const content = sql.slice(j + 1, litEnd - 1)
        if (AR.test(content)) {
          // NOT قبل الكلمة؟
          let k = kwStart - 1
          while (k >= 0 && /\s/.test(sql[k])) k--
          let negated = false
          let lhsEnd = k + 1
          if (/not$/i.test(sql.slice(Math.max(0, k - 2), k + 1)) && !/\w/.test(sql[k - 3] ?? ' ')) {
            negated = true
            k -= 3
            while (k >= 0 && /\s/.test(sql[k])) k--
            lhsEnd = k + 1
          }
          const lhsStart = findLhsStart(sql, lhsEnd)
          if (lhsStart !== null && lhsStart < lhsEnd) {
            const lhs = sql.slice(lhsStart, lhsEnd)
            hits.push({ start: lhsStart, end: litEnd, text: rewrite(lhs, kw, content, negated) })
          }
        }
        i = litEnd
        continue
      }
    }
    i++
  }
  if (!hits.length) return sql
  let out = sql
  for (const h of hits.sort((a, b) => b.start - a.start)) out = out.slice(0, h.start) + h.text + out.slice(h.end)
  return out
}

function rewrite(lhs: string, kw: string, content: string, negated: boolean): string {
  const col = normalizedExpr(lhs)
  const op = kw.toUpperCase()
  const contains = content.startsWith('%') && content.endsWith('%') && content.length > 1
  if (negated || !contains) return `${col} ${negated ? 'NOT ' : ''}${op} '${keepWildcards(content)}'`
  const parts = nameParts(content.slice(1, -1))
  if (!parts.length) return `${col} ${op} '${keepWildcards(content)}'`
  if (parts.length === 1) return `${col} ${op} '%${parts[0]}%'`
  return `(${parts.map((p) => `${col} ${op} '%${p}%'`).join(' AND ')})`
}

/** يطبّع النص مع إبقاء % و _ */
function keepWildcards(content: string): string {
  return content.split(/([%_])/).map((seg) => (seg === '%' || seg === '_' ? seg : normalizeArabicLiteral(seg))).join('')
}

function skipString(sql: string, i: number): number {
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } return j + 1 }
    j++
  }
  return sql.length
}

/** بداية التعبير الذي ينتهي عند end: معرّف (a.b، "Col") أو دالة متوازنة الأقواس، مع ::نوع اختياري */
function findLhsStart(sql: string, end: number): number | null {
  let k = end - 1
  // ::text / ::varchar
  const cast = /::\s*[A-Za-z_]+(?:\s*\(\s*\d+\s*\))?$/.exec(sql.slice(Math.max(0, end - 30), end))
  if (cast) k = end - cast[0].length - 1
  while (k >= 0 && /\s/.test(sql[k])) k--
  if (k < 0) return null
  if (sql[k] === ')') {
    let depth = 0
    for (; k >= 0; k--) {
      const c = sql[k]
      if (c === "'") { // نتجاوز نصاً للخلف
        k--
        while (k >= 0 && !(sql[k] === "'" && sql[k - 1] !== "'")) k--
        continue
      }
      if (c === ')') depth++
      else if (c === '(') { depth--; if (depth === 0) break }
    }
    if (k < 0) return null
    k--
    while (k >= 0 && /[\w.]/.test(sql[k])) k--   // اسم الدالة
    return k + 1
  }
  if (/[\w."]/.test(sql[k])) {
    while (k >= 0 && /[\w."]/.test(sql[k])) {
      if (sql[k] === '"') { const q = sql.lastIndexOf('"', k - 1); if (q < 0) return null; k = q - 1; continue }
      k--
    }
    return k + 1
  }
  return null
}

