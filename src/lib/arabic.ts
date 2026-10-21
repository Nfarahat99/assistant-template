import { toLatinDigits } from './phone.js'

/**
 * تطبيع النص العربي للمطابقة:
 * أ/إ/آ/ٱ → ا ، ة → ه ، ى → ي ، ؤ → و ، ئ → ي ، حذف التشكيل والتطويل،
 * وحذف "ال" من بداية كل كلمة.
 */
export function normalizeArabic(input: string): string {
  const s = toLatinDigits(input)
    .toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭ]/g, '')   // التشكيل
    .replace(/ـ/g, '')                                // التطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .join(' ')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/**
 * درجة تطابق استعلام مع اسم واحد (0 = لا تطابق):
 * 4 = تطابق كامل، 3 = كل كلمات الاستعلام موجودة في الاسم،
 * 2 = بادئة كلمة، 1 = خطأ إملائي بسيط (حرف واحد في كلمة طويلة)
 */
export function nameScore(query: string, name: string): number {
  const q = normalizeArabic(query)
  const n = normalizeArabic(name)
  if (!q || !n) return 0
  if (q === n) return 4
  const qt = q.split(' ')
  const nt = n.split(' ')
  if (qt.every((t) => nt.includes(t))) return 3
  if (qt.every((t) => nt.some((w) => t.length >= 2 && w.startsWith(t)))) return 2
  if (qt.every((t) => nt.some((w) => t.length >= 4 && w.length >= 4 && levenshtein(t, w) <= 1))) return 1
  return 0
}

export interface Named { names: string[] }

/**
 * يرجع أفضل المرشحين فقط (كلهم بنفس أعلى درجة).
 * أكثر من مرشح = غموض → المستدعي يسأل المالك، لا يخمّن أبداً.
 */
export function bestMatches<T extends Named>(query: string, items: T[]): T[] {
  let best = 0
  let out: T[] = []
  for (const it of items) {
    const s = Math.max(0, ...it.names.map((n) => nameScore(query, n)))
    if (s === 0) continue
    if (s > best) { best = s; out = [it] }
    else if (s === best) out.push(it)
  }
  return out
}
