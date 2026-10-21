import { ownerName } from '../profile.js'
import type { GroundedResponse } from './websearch.js'

/**
 * "وش أفضل أداة لـ…" / "قارن بين…": بحث مؤسَّس على Google Search مخصص لسياق المالك.
 * كل خيار يجب أن يكون له مصدر حقيقي من groundingChunks — وإلا يُحذف.
 */
export interface ResearchOption {
  name: string; what: string; fit: string; cost: string; maturity: string
  sources: { uri: string; title: string }[]
}
export interface ResearchResult { options: ResearchOption[]; recommendation: string | null }

export function researchPrompt(task: string, constraints: string | undefined, knowledge: string, nowIso: string): string {
  return `أنت مستشار تقني ل${ownerName()}. التاريخ: ${nowIso}.
المهمة: ${task}
${constraints ? `قيود: ${constraints}\n` : ''}
سياقه: Next.js، Node/TypeScript، Railway، Postgres، Claude Code، Baileys (واتساب)، مستخدمون عرب/سعوديون، ويفضّل المجاني أو الرخيص جداً.
${knowledge.slice(0, 3000)}

ابحث في الويب (Google Search) وقارن ٢ إلى ٤ خيارات حقيقية حالية. اكتب بالعربي بهذا الشكل بالضبط، كل خيار سطر واحد:
1. الاسم — ماذا يفعل | الملاءمة: مع ستاكه | التكلفة: مجاني/طبقة مجانية/سعر | النضج: إشارة (نجوم، إصدار، شركة)
ثم سطر أخير:
التوصية: الخيار الأنسب ولماذا (جملة أو جملتان)
اعتمد على نتائج البحث فقط، ولا تكتب روابط.`
}

const norm = (s: string) => s.replace(/[\s*_`#>]+/g, ' ').trim()

export function extractResearch(g: GroundedResponse, max = 4): ResearchResult {
  const lines = g.text.split('\n').map((l) => l.trim()).filter(Boolean)
  const rec = lines.find((l) => /^\**التوصية\**\s*[:：]/.test(l))
  const options: ResearchOption[] = []
  for (const raw of lines.filter((l) => /^\d+[.)-]\s+/.test(l))) {
    const line = raw.replace(/^\d+[.)-]\s+/, '').replace(/https?:\/\/\S+/g, '').trim()
    const nl = norm(line)
    const idx = new Set<number>()
    for (const s of g.supports) {
      const st = norm(s.text)
      if (st.length >= 8 && (nl.includes(st) || st.includes(nl))) s.chunkIndices.forEach((i) => idx.add(i))
    }
    const seen = new Set<string>()
    const sources = [...idx].map((i) => g.chunks[i])
      .filter((c): c is { uri: string; title: string } => !!c && /^https?:\/\//.test(c.uri) && !seen.has(c.uri) && !!seen.add(c.uri))
      .slice(0, 2)
    if (!sources.length) continue
    const [head, ...parts] = line.split('|').map((p) => p.replace(/\*+/g, '').trim())
    const [name, ...whatParts] = head.split(/\s+[—–-]\s+/)
    const field = (label: RegExp) => (parts.find((p) => label.test(p)) ?? '').replace(label, '').replace(/^[:：\s]+/, '').trim()
    options.push({
      name: name.trim(), what: whatParts.join(' — ').trim(),
      fit: field(/^الملاءمة/), cost: field(/^التكلفة/), maturity: field(/^النضج/), sources,
    })
    if (options.length >= max) break
  }
  return { options, recommendation: rec ? rec.replace(/^\**التوصية\**\s*[:：]\s*/, '').replace(/\*+/g, '').trim() : null }
}

export function formatResearch(task: string, r: ResearchResult): string {
  if (!r.options.length) return `🧪 بحثت عن «${task}» بس ما لقيت خيارات لها مصادر موثوقة أقدر أعرضها.`
  const opts = r.options.map((o, i) => [
    `${i + 1}. ${o.name}${o.what ? ` — ${o.what}` : ''}`,
    o.fit ? `   🧩 ${o.fit}` : '',
    [o.cost ? `💰 ${o.cost}` : '', o.maturity ? `📈 ${o.maturity}` : ''].filter(Boolean).join('  ').replace(/^/, '   '),
    ...o.sources.map((s) => `   🔗 ${s.title ? `${s.title}: ` : ''}${s.uri}`),
  ].filter((l) => l.trim()).join('\n'))
  const tail = [
    r.recommendation ? `✅ التوصية: ${r.recommendation}` : '',
    'تبي؟ اكتب: نفّذها في <اسم المشروع> (طلب كود) — أو: احفظها كمهمة',
  ].filter(Boolean)
  return [`🧪 ${task}`, ...opts, ...tail].join('\n\n')
}
