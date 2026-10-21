import { httpRailway } from '../clients/railway.js'
import { projectLabel, type Project } from '../projects.js'
import { logger } from '../logger.js'

/**
 * معلومات النشر لكل مشروع من Railway (قراءة فقط):
 *  - auto_deploy: خدمة في Railway مصدرها نفس مستودع GitHub (Railway ينشر تلقائياً عند الدفع للفرع)
 *  - domain: أول نطاق عام للخدمة
 * بلا RAILWAY_API_TOKEN ← كل شيء false/null. النتيجة مخزّنة 5 دقائق.
 */
export interface RailwayRepoInfo { project: string; repo: string | null; domain: string | null; deployed: boolean }
export type RailwayInfoFn = () => Promise<RailwayRepoInfo[]>

const ENDPOINT = 'https://backboard.railway.com/graphql/v2'
const SOURCES_QUERY = `query {
  projects { edges { node {
    name
    services { edges { node { name serviceInstances { edges { node {
      source { repo }
      domains { serviceDomains { domain } customDomains { domain } }
      latestDeployment { status }
    } } } } } }
  } } }
}`

export function parseSources(data: any): RailwayRepoInfo[] {
  const nodes = (c: any): any[] => (c?.edges ?? []).map((e: any) => e?.node).filter(Boolean)
  const out: RailwayRepoInfo[] = []
  for (const p of nodes(data?.projects)) {
    for (const s of nodes(p.services)) {
      for (const i of nodes(s.serviceInstances)) {
        const d = i.domains ?? {}
        const domain = [...(d.customDomains ?? []), ...(d.serviceDomains ?? [])].map((x: any) => x?.domain).find(Boolean) ?? null
        out.push({ project: p.name, repo: i.source?.repo ?? null, domain, deployed: !!i.latestDeployment })
      }
    }
  }
  return out
}

/** يبني الدالة: الاستعلام الموسّع أولاً، وإن رفضه المخطط نرجع لعميل Railway الموجود (بالاسم فقط) */
export function railwayInfoFromToken(token: string, endpoint = ENDPOINT): RailwayInfoFn {
  return async () => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: SOURCES_QUERY }),
        signal: AbortSignal.timeout(20_000),
      })
      const j = (await res.json().catch(() => ({}))) as any
      if (!res.ok || j.errors?.length) throw new Error(`Railway ${res.status}: ${String(j.errors?.[0]?.message ?? '').slice(0, 120)}`)
      return parseSources(j.data)
    } catch (err) {
      logger.warn({ err: String(err) }, 'لوحة التحكم: استعلام مصادر Railway فشل — نستخدم قائمة المشاريع فقط')
      const projects = await httpRailway(token, endpoint).projects()
      return projects.flatMap((p) => p.services.map((s) => ({ project: p.name, repo: null, domain: null, deployed: !!s.status })))
    }
  }
}

export interface ProjectOut {
  alias: string; aliases: string[]; repo: string; default_branch: string; auto_deploy: boolean; domain: string | null
}

export function joinProjects(list: Project[], infos: RailwayRepoInfo[]): ProjectOut[] {
  return list.map((p) => {
    const repo = p.repo.toLowerCase()
    const bySource = infos.filter((i) => i.repo?.toLowerCase() === repo)
    const byName = p.railway_project ? infos.filter((i) => i.project.toLowerCase() === p.railway_project!.toLowerCase()) : []
    const hits = bySource.length ? bySource : byName
    return {
      alias: projectLabel(p),
      aliases: p.aliases,
      repo: p.repo,
      default_branch: p.default_branch,
      // مصدر GitHub مربوط = نشر تلقائي؛ الربط بالاسم فقط (الاستعلام الاحتياطي) يكفيه وجود نشر
      auto_deploy: bySource.length > 0 || byName.some((i) => i.deployed && i.repo === null && !infos.some((x) => x.repo)),
      domain: hits.map((i) => i.domain).find(Boolean) ?? null,
    }
  })
}

export class RailwayCache {
  private at = 0
  private data: RailwayRepoInfo[] = []
  constructor(private fn: RailwayInfoFn | null, private ttlMs = 5 * 60_000) {}
  invalidate() { this.at = 0 }
  async get(): Promise<RailwayRepoInfo[]> {
    if (!this.fn) return []
    if (Date.now() - this.at < this.ttlMs) return this.data
    try {
      this.data = await this.fn()
      this.at = Date.now()
    } catch (err) {
      logger.warn({ err: String(err) }, 'لوحة التحكم: تعذّر قراءة Railway')
    }
    return this.data
  }
}
