/**
 * نظام مهارات الوكلاء (skills.sh):
 *   GET https://skills.sh/api/search?q=<query> → {skills:[{id, source, skillId, name, installs}]}
 *   صفحة المهارة https://skills.sh/<source>/<skillId> فيها <meta name="description">
 *   التثبيت: npx -y skills add <source>@<skillId>
 */
export interface SkillHit { pkg: string; name: string; installs: number; url: string; description: string | null }

export interface SkillsClient { search(query: string, limit?: number): Promise<SkillHit[]> }

const BASE = 'https://skills.sh'

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export function httpSkills(base = BASE): SkillsClient {
  return {
    async search(query, limit = 5) {
      const res = await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`skills.sh ${res.status}`)
      const j = (await res.json()) as any
      const hits = ((j.skills ?? []) as any[])
        .filter((s) => s.source && s.skillId)
        .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
        .slice(0, limit)
      // الوصف من صفحة المهارة (بالتوازي، ولا يُفشل البحث إن تعذّر)
      return Promise.all(hits.map(async (s) => {
        const url = `${base}/${s.source}/${s.skillId}`
        let description: string | null = null
        try {
          const html = await (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000) })).text()
          const m = /<meta name="description" content="([^"]*)"/i.exec(html)
          description = m ? decodeEntities(m[1]).trim() : null
        } catch { /* بلا وصف */ }
        return { pkg: `${s.source}@${s.skillId}`, name: s.name ?? s.skillId, installs: Number(s.installs ?? 0), url, description }
      }))
    },
  }
}

export function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
