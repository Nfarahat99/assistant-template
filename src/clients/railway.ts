/**
 * عميل Railway GraphQL: المشاريع ← الخدمات ← حالة آخر نشر (قراءة)، وإعادة نشر خدمة (كتابة، بموافقة صريحة فقط).
 * التوكن: Account/Workspace token من https://railway.com/account/tokens.
 */
export interface RailwayServiceStatus {
  name: string
  environment: string
  status: string | null          // SUCCESS | FAILED | CRASHED | BUILDING | DEPLOYING ...
  deployedAt: string | null
}
export interface RailwayProject { id: string; name: string; services: RailwayServiceStatus[] }

export interface RailwayDeployment { status: string; createdAt: string }
export interface RailwayServiceDetail {
  project: string
  service: string
  environment: string
  deployments: RailwayDeployment[]
  variables: string[]            // أسماء المتغيرات فقط — القيم أسرار ولا تُقرأ ولا تُعرض أبداً
}

/** ── التحقق من النشر بعد الدمج: الخدمات بمصدرها ودومينها، النشرات بالـ commit، والسجلات ── */
export type DeployStatus = 'BUILDING' | 'CRASHED' | 'DEPLOYING' | 'FAILED' | 'INITIALIZING' | 'NEEDS_APPROVAL' | 'QUEUED' |
  'REMOVED' | 'REMOVING' | 'SKIPPED' | 'SLEEPING' | 'SUCCESS' | 'WAITING'
export interface RwDeployment { id: string; status: DeployStatus; createdAt: string; commitHash: string | null; commitMessage: string | null; url: string | null }
export interface RwService {
  projectId: string; projectName: string
  serviceId: string; serviceName: string; environmentId: string; environmentName: string
  /** owner/repo إن كانت الخدمة مربوطة بـ GitHub (نشر تلقائي)، وإلا null (رفع يدوي/صورة) */
  repo: string | null; image: string | null
  latest: RwDeployment | null
  domains: string[]
}
export interface RwLog { message: string; severity: string | null; timestamp: string | null }

export interface RailwayClient {
  /** خدمات البيئة الأساسية لكل مشروع مع المصدر والدومين وآخر نشر (commit) */
  listServices(): Promise<RwService[]>
  deployments(serviceId: string, environmentId: string, first?: number): Promise<RwDeployment[]>
  logs(deploymentId: string, kind: 'build' | 'deploy', limit?: number): Promise<RwLog[]>
  projects(query?: string): Promise<RailwayProject[]>
  /** آخر النشرات وأسماء متغيرات البيئة لكل خدمة/بيئة في المشاريع المطابقة (قراءة فقط) */
  details(query?: string): Promise<RailwayServiceDetail[]>
  /** أزواج خدمة/بيئة المطابقة للمشروع (والخدمة اختيارياً) — لتحديد هدف إعادة النشر */
  findTargets(project: string, service?: string): Promise<RailwayTarget[]>
  /** يعيد نشر آخر نشر للخدمة في البيئة (كتابة — تُستدعى فقط بعد موافقة صريحة) */
  redeploy(serviceId: string, environmentId: string): Promise<void>
}

/** حد أقصى لعدد أزواج خدمة/بيئة لكل طلب حتى لا نغرق API الخاص بـ Railway */
export const MAX_DETAIL_TARGETS = 12
export const DEPLOYMENTS_PER_SERVICE = 5

const ENDPOINT = 'https://backboard.railway.com/graphql/v2'

const QUERY = `query {
  projects { edges { node {
    id name
    environments { edges { node { id name } } }
    services { edges { node { name serviceInstances { edges { node {
      environmentId latestDeployment { status createdAt }
    } } } } } }
  } } }
}`

const IDS_QUERY = `query {
  projects { edges { node {
    id name
    environments { edges { node { id name } } }
    services { edges { node { id name serviceInstances { edges { node { environmentId } } } } } }
  } } }
}`

const DETAIL_QUERY = `query($projectId: String!, $environmentId: String!, $serviceId: String!, $first: Int!) {
  deployments(first: $first, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { status createdAt } }
  }
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
}`

const REDEPLOY_MUTATION = `mutation($serviceId: String!, $environmentId: String!) {
  serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
}`

/** يطابق الاسم بالتضمين؛ إذا تعدّدت البيئات وإحداها production نفضّلها فقط عندما لا يحدّد المستخدم غير المشروع */
export function pickTargets(all: RailwayTarget[], project: string, service?: string): RailwayTarget[] {
  const p = project.trim().toLowerCase()
  const s = service?.trim().toLowerCase()
  const hits = all.filter((t) => t.project.toLowerCase().includes(p) && (!s || t.service.toLowerCase().includes(s)))
  const exact = hits.filter((t) => t.project.toLowerCase() === p && (!s || t.service.toLowerCase() === s))
  const set = exact.length ? exact : hits
  const prod = set.filter((t) => t.environment.toLowerCase() === 'production')
  return set.length > 1 && prod.length === 1 ? prod : set
}

export interface RailwayTarget { project: string; projectId: string; service: string; serviceId: string; environment: string; environmentId: string }

export function parseTargets(data: any): RailwayTarget[] {
  const nodes = (c: any): any[] => (c?.edges ?? []).map((e: any) => e.node).filter(Boolean)
  const out: RailwayTarget[] = []
  for (const p of nodes(data?.projects)) {
    const envs = new Map<string, string>(nodes(p.environments).map((e) => [e.id, e.name]))
    for (const s of nodes(p.services)) {
      for (const i of nodes(s.serviceInstances)) {
        out.push({
          project: p.name, projectId: p.id, service: s.name, serviceId: s.id,
          environment: envs.get(i.environmentId) ?? '—', environmentId: i.environmentId,
        })
      }
    }
  }
  return out
}

export function parseDetail(t: RailwayTarget, data: any): RailwayServiceDetail {
  const deployments: RailwayDeployment[] = (data?.deployments?.edges ?? [])
    .map((e: any) => e?.node).filter(Boolean)
    .map((n: any) => ({ status: String(n.status), createdAt: String(n.createdAt) }))
  // القيم لا تخرج من هنا: نأخذ المفاتيح فقط
  const variables = Object.keys(data?.variables ?? {}).sort()
  return { project: t.project, service: t.service, environment: t.environment, deployments, variables }
}

export function parseProjects(data: any): RailwayProject[] {
  const nodes = (c: any): any[] => (c?.edges ?? []).map((e: any) => e.node).filter(Boolean)
  return nodes(data?.projects).map((p) => {
    const envs = new Map<string, string>(nodes(p.environments).map((e) => [e.id, e.name]))
    const services: RailwayServiceStatus[] = []
    for (const s of nodes(p.services)) {
      const insts = nodes(s.serviceInstances)
      if (!insts.length) services.push({ name: s.name, environment: '—', status: null, deployedAt: null })
      for (const i of insts) {
        services.push({
          name: s.name,
          environment: envs.get(i.environmentId) ?? '—',
          status: i.latestDeployment?.status ?? null,
          deployedAt: i.latestDeployment?.createdAt ?? null,
        })
      }
    }
    return { id: p.id, name: p.name, services }
  })
}

const SERVICES_QUERY = `query($ws: String) {
  projects(first: 100, workspaceId: $ws) { edges { node { id name primaryEnvironmentId
    environments { edges { node { id name serviceInstances { edges { node {
      serviceId serviceName environmentId source { repo image }
      latestDeployment { id status createdAt meta staticUrl url }
      domains { serviceDomains { domain } customDomains { domain } }
    } } } } } }
  } } }
}`

function toDeployment(n: any): RwDeployment | null {
  if (!n?.id) return null
  const meta = typeof n.meta === 'string' ? (() => { try { return JSON.parse(n.meta) } catch { return {} } })() : (n.meta ?? {})
  return {
    id: n.id, status: n.status, createdAt: n.createdAt,
    commitHash: meta?.commitHash ?? null, commitMessage: meta?.commitMessage ?? null,
    url: n.staticUrl ? `https://${n.staticUrl}` : n.url ?? null,
  }
}

export function parseServices(d: any): RwService[] {
  const out: RwService[] = []
  for (const pe of d?.projects?.edges ?? []) {
    const p = pe.node
    const envs = (p.environments?.edges ?? []).map((e: any) => e.node)
    // بيئة production فقط — لا نخلط بيئات PR/staging (كانت "🚀 بدأ النشر" تطلع مرتين لقنديل)
    const env = envs.find((e: any) => /^production$/i.test(e.name)) ?? envs.find((e: any) => e.id === p.primaryEnvironmentId) ?? envs.find((e: any) => /prod/i.test(e.name)) ?? envs[0]
    for (const si of env?.serviceInstances?.edges ?? []) {
      const n = si.node
      out.push({
        projectId: p.id, projectName: p.name, serviceId: n.serviceId, serviceName: n.serviceName,
        environmentId: n.environmentId ?? env.id, environmentName: env.name,
        repo: n.source?.repo ?? null, image: n.source?.image ?? null,
        latest: toDeployment(n.latestDeployment),
        domains: [...(n.domains?.customDomains ?? []), ...(n.domains?.serviceDomains ?? [])].map((x: any) => x.domain).filter(Boolean),
      })
    }
  }
  return out
}

export function httpRailway(token: string, endpoint = ENDPOINT, workspaceId?: string): RailwayClient {
  async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`Railway ${res.status}`)
    const j = (await res.json()) as any
    if (j.errors?.length) throw new Error(`Railway: ${String(j.errors[0]?.message ?? 'error').slice(0, 200)}`)
    return j.data
  }
  return {
    async listServices() {
      return parseServices(await gql(SERVICES_QUERY, { ws: workspaceId ?? null }))
    },
    async deployments(serviceId, environmentId, first = 5) {
      const d = await gql(`query($s: String!, $e: String, $n: Int) {
        deployments(first: $n, input: { serviceId: $s, environmentId: $e }) { edges { node { id status createdAt meta staticUrl url } } }
      }`, { s: serviceId, e: environmentId, n: first })
      return (d?.deployments?.edges ?? []).map((e: any) => toDeployment(e.node)).filter(Boolean)
    },
    async logs(deploymentId, kind, limit = 200) {
      const field = kind === 'build' ? 'buildLogs' : 'deploymentLogs'
      const d = await gql(`query($id: String!, $n: Int) { ${field}(deploymentId: $id, limit: $n) { message severity timestamp } }`, { id: deploymentId, n: limit })
      return (d?.[field] ?? []).map((l: any) => ({ message: String(l.message ?? ''), severity: l.severity ?? null, timestamp: l.timestamp ?? null }))
    },
    async details(query) {
      const q = query?.trim().toLowerCase()
      const targets = parseTargets(await gql(IDS_QUERY))
        .filter((t) => !q || t.project.toLowerCase().includes(q) || t.service.toLowerCase().includes(q))
        .slice(0, MAX_DETAIL_TARGETS)
      return Promise.all(targets.map(async (t) => parseDetail(t, await gql(DETAIL_QUERY, {
        projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId, first: DEPLOYMENTS_PER_SERVICE,
      }))))
    },
    async findTargets(project, service) {
      return pickTargets(parseTargets(await gql(IDS_QUERY)), project, service)
    },
    async redeploy(serviceId, environmentId) {
      const data = await gql(REDEPLOY_MUTATION, { serviceId, environmentId })
      // Railway يرجع Boolean: false تعني أن الطلب لم يُقبل — لا نعلن النجاح
      if (data?.serviceInstanceRedeploy !== true) throw new Error('Railway رفض طلب إعادة النشر (لم تبدأ)')
    },
    async projects(query) {
      const all = parseProjects(await gql(QUERY))
      const q = query?.trim().toLowerCase()
      return q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all
    },
  }
}

/**
 * (k) ضبط متغير على خدمة البوت نفسها (variableUpsert) — يُستخدم فقط حين يلصق المالك توكن Railway
 * والبوت بلا وصول. التوكن الملصوق هو نفسه المصادقة. القيمة لا تُسجَّل ولا تُعاد.
 */
export async function upsertOwnVariable(token: string, ids: { projectId: string; environmentId: string; serviceId: string }, name: string, value: string, endpoint = ENDPOINT): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'mutation($i: VariableUpsertInput!) { variableUpsert(input: $i) }', variables: { i: { ...ids, name, value } } }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = (await res.json().catch(() => ({}))) as any
  if (!res.ok || j.errors?.length || j.data?.variableUpsert !== true) {
    throw new Error(`Railway: ${String(j.errors?.[0]?.message ?? res.status).slice(0, 120)}`)
  }
}

export const STATUS_AR: Record<string, string> = {
  SUCCESS: '✅ شغّال', FAILED: '❌ فشل', CRASHED: '💥 توقف', BUILDING: '🔨 يُبنى', DEPLOYING: '🚀 يُنشر',
  INITIALIZING: '⏳ يبدأ', QUEUED: '⏳ بالانتظار', REMOVED: '🔁 استُبدل بنشر أحدث', SLEEPING: '😴 نائم', SKIPPED: '⏭️ متخطّى',
  WAITING: '⏳ ينتظر', NEEDS_APPROVAL: '✋ يحتاج موافقة', REMOVING: '🔁 يُستبدل بنشر أحدث',
}

export const ACTIVE: DeployStatus[] = ['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']
export const FAILED: DeployStatus[] = ['FAILED', 'CRASHED']
/** نشر استُبدل بأحدث أو أُلغي/تُخطّي — ليس فشلاً نهائياً ولا حذفاً للمشروع */
export const SUPERSEDED: DeployStatus[] = ['REMOVED', 'REMOVING', 'SKIPPED']

/** سطور الأخطاء فقط من سجل البناء/التشغيل — آخر n، بلا ألوان ANSI */
export function errorLines(logs: RwLog[], n = 15): string[] {
  const bad = logs.filter((l) => /^(error|err|fatal)$/i.test(l.severity ?? '') || /\b(error|failed|fatal|exception|cannot|ERR!|exit code [1-9])/i.test(l.message))
  return (bad.length ? bad : logs).map((l) => l.message.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean).slice(-n)
}

export function formatRailway(projects: RailwayProject[], query?: string): string {
  if (!projects.length) return query ? `ما لقيت مشروع باسم «${query}» في Railway 🤔` : 'ما في مشاريع في حساب Railway.'
  return `🚂 Railway:\n\n${projects.map((p) =>
    `• ${p.name}\n${p.services.length
      ? p.services.map((s) => `   ${s.name} (${s.environment}): ${s.status ? (STATUS_AR[s.status] ?? s.status) : 'بلا نشر'}${s.deployedAt ? ` — ${s.deployedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`).join('\n')
      : '   (بلا خدمات)'}`).join('\n\n')}`
}

export function formatRailwayDetails(details: RailwayServiceDetail[], query?: string): string {
  if (!details.length) return query ? `ما لقيت مشروع/خدمة باسم «${query}» في Railway 🤔` : 'ما في خدمات في حساب Railway.'
  return `🚂 Railway — النشرات والمتغيرات:\n\n${details.map((d) => {
    const deps = d.deployments.length
      ? d.deployments.map((x) => `      ${STATUS_AR[x.status] ?? x.status} — ${x.createdAt.slice(0, 16).replace('T', ' ')} UTC`).join('\n')
      : '      بلا نشر'
    const vars = d.variables.length ? d.variables.join(', ') : 'لا يوجد'
    return `• ${d.project} / ${d.service} (${d.environment})\n   آخر النشرات:\n${deps}\n   متغيرات البيئة (${d.variables.length}) — الأسماء فقط، القيم مخفية:\n      ${vars}`
  }).join('\n\n')}`
}
