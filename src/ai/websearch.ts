import { ownerName, profile } from '../profile.js'
import { logger } from '../logger.js'

/**
 * بحث الويب عبر Gemini + أداة Google Search (grounding).
 * REST: generateContent مع tools:[{google_search:{}}] — https://ai.google.dev/gemini-api/docs/generate-content/google-search
 * الروابط تُؤخذ حصراً من groundingMetadata.groundingChunks[].web — لا نعرض رابطاً لم يأتِ من البحث فعلاً،
 * وأي بند بلا مصدر (لا groundingSupport يغطيه) يُحذف.
 */
export interface GroundedResponse {
  text: string
  chunks: { uri: string; title: string }[]
  supports: { text: string; chunkIndices: number[] }[]
  queries: string[]
}

export interface NewsItem { title: string; why: string; sources: { uri: string; title: string }[] }

/** يقرأ استجابة generateContent الخام */
export function parseGrounded(j: any): GroundedResponse {
  const cand = j?.candidates?.[0] ?? {}
  const text = (cand.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim()
  const gm = cand.groundingMetadata ?? {}
  const chunks = (gm.groundingChunks ?? [])
    .map((c: any) => ({ uri: String(c?.web?.uri ?? ''), title: String(c?.web?.title ?? c?.web?.domain ?? '') }))
  const supports = (gm.groundingSupports ?? []).map((s: any) => ({
    text: String(s?.segment?.text ?? ''),
    chunkIndices: (s?.groundingChunkIndices ?? []).map(Number).filter((n: number) => Number.isInteger(n)),
  }))
  return { text, chunks, supports, queries: (gm.webSearchQueries ?? []).map(String) }
}

const norm = (s: string) => s.replace(/[\s*_`#>]+/g, ' ').trim()

/**
 * يحوّل النص المرقّم إلى بنود، ويربط كل بند بمصادره عبر groundingSupports (تطابق نص المقطع مع سطر البند).
 * بند بلا مصدر حقيقي = محذوف. الروابط المكتوبة داخل النص نفسه تُزال (قد تكون مختلقة).
 */
export function extractItems(g: GroundedResponse, max = 7): NewsItem[] {
  const lines = g.text.split('\n').map((l) => l.trim()).filter((l) => /^(\d+[.)-]|[-•*])\s+/.test(l))
  const items: NewsItem[] = []
  for (const raw of lines) {
    const line = raw.replace(/^(\d+[.)-]|[-•*])\s+/, '').replace(/https?:\/\/\S+/g, '').trim()
    const nl = norm(line)
    const idx = new Set<number>()
    for (const s of g.supports) {
      const st = norm(s.text)
      if (st.length >= 8 && (nl.includes(st) || st.includes(nl))) s.chunkIndices.forEach((i) => idx.add(i))
    }
    const sources = [...idx].map((i) => g.chunks[i]).filter((c): c is { uri: string; title: string } => !!c && /^https?:\/\//.test(c.uri))
    if (!sources.length) continue
    const [title, ...rest] = line.split(/\s+[—–-]\s+|:\s+/)
    items.push({ title: title.replace(/\*+/g, '').trim(), why: rest.join(' — ').replace(/\*+/g, '').trim(), sources: dedupe(sources).slice(0, 2) })
    if (items.length >= max) break
  }
  return items
}

function dedupe(s: { uri: string; title: string }[]) {
  const seen = new Set<string>()
  return s.filter((x) => (seen.has(x.uri) ? false : (seen.add(x.uri), true)))
}

export function searchPrompt(query: string, purpose: string | undefined, knowledge: string, nowIso: string): string {
  return `أنت باحث ل${ownerName()}. التاريخ الآن: ${nowIso}.
ابحث في الويب (Google Search) عن: ${query}
${purpose ? `الغرض: ${purpose}\n` : ''}
سياق ${ownerName()} (لتخصيص الأهمية):
${knowledge.slice(0, 4000)}

اكتب بالعربي ٥ إلى ٧ بنود مرقّمة فقط، كل بند سطر واحد بالشكل:
1. العنوان — لماذا يهم ${ownerName()} تحديداً (جملة واحدة مرتبطة بعمله: ${profile().interests || 'عمله ومشاريعه'})
اعتمد فقط على نتائج البحث، ولا تكتب روابط ولا تخترع أخباراً. إذا ما لقيت شيئاً موثوقاً قل ذلك.`
}

export function formatNews(query: string, items: NewsItem[]): string {
  if (!items.length) return `🔎 بحثت عن «${query}» بس ما طلعت نتائج لها مصادر موثوقة أقدر أعرضها.`
  return `🔎 ${query}\n\n${items.map((it, i) =>
    `${i + 1}. ${it.title}${it.why ? `\n   💡 ${it.why}` : ''}\n${it.sources.map((s) => `   🔗 ${s.title ? `${s.title}: ` : ''}${s.uri}`).join('\n')}`).join('\n\n')}`
}

export function logSearch(g: GroundedResponse) {
  logger.info({ queries: g.queries, chunks: g.chunks.length, supports: g.supports.length }, 'بحث الويب')
}
