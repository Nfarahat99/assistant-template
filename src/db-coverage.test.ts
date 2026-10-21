/**
 * قاعدة المالك الدائمة: كل مشروع له مسار قراءة لقاعدته. المراقب ينبّه أسبوعياً بالمشاريع غير المغطّاة.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RailwayMonitor, DB_COVERAGE_EVERY_MS, uncoveredDbProjects } from './monitor.js'
import type { RwService, RailwayServiceDetail } from './clients/railway.js'

const svc = (projectName: string, serviceName: string, over: Partial<RwService> = {}): RwService => ({
  projectId: `p-${projectName}`, projectName, serviceId: `s-${projectName}-${serviceName}`, serviceName,
  environmentId: 'e', environmentName: 'production', repo: null, image: null,
  latest: { id: `d-${serviceName}`, status: 'SUCCESS', createdAt: '2026-10-01', commitHash: null, commitMessage: null, url: null },
  domains: [], ...over,
})

const SERVICES: RwService[] = [
  svc('falak-prod', 'Postgres', { image: 'ghcr.io/railwayapp-templates/postgres-ssl:16' }),
  svc('falak-prod', 'web', { repo: 'example-user/sirajplus' }),
  svc('new-shop', 'Postgres', { image: 'ghcr.io/railwayapp-templates/postgres-ssl:17' }),
  svc('new-shop', 'api', { repo: 'example-user/new-shop' }),
  svc('hudoor-attendance', 'web', { repo: 'example-user/hudoor' }),
  svc('static-site', 'web', { repo: 'example-user/site' }),
  svc('cache-only', 'Redis', { image: 'redis:7' }),
  svc('ops-tracker-console', 'Postgres', { image: 'postgres:16' }),
  svc('my-assistant', 'Postgres', { image: 'postgres:16', projectId: 'OWN' }),
  svc('legacy-mysql', 'MySQL', { image: 'mysql:8' }),
]

const details = async (q?: string): Promise<RailwayServiceDetail[]> => {
  const vars: Record<string, string[]> = {
    'hudoor-attendance': ['DATABASE_PATH', 'NEXT_PUBLIC_BASE_PATH'],
    'static-site': ['PORT'],
  }
  return Object.entries(vars).filter(([p]) => !q || p.includes(q)).map(([project, variables]) => ({ project, service: 'web', environment: 'production', deployments: [], variables }))
}

const deps = (covered: string[]) => ({ coveredProjects: () => covered, ignoreProjects: ['ops-tracker-console'], ownProjectId: 'OWN' })

test('غير المغطّى: صور Postgres/MySQL + تطبيقات SQLite (أسماء المتغيرات) — بلا redis ولا المستثنى ولا مشروع البوت', async () => {
  const out = await uncoveredDbProjects(SERVICES, { details }, deps(['falak-prod']))
  assert.deepEqual(out, [
    { project: 'new-shop', kind: 'postgres' },
    { project: 'hudoor-attendance', kind: 'sqlite' },
    { project: 'legacy-mysql', kind: 'mysql' },
  ])
  const all = await uncoveredDbProjects(SERVICES, { details }, deps(['FALAK-PROD', 'new-shop', 'hudoor-attendance', 'legacy-mysql']))
  assert.deepEqual(all, [])
})

test('المراقب: تنبيه واحد في الأسبوع بالصيغة المطلوبة، ولا شيء قبل مرور أسبوع', async () => {
  const kv = new Map<string, string>()
  const notes: string[] = []
  let now = Date.parse('2026-10-07T09:00:00Z')
  const m = new RailwayMonitor({
    store: { getKv: async (k: string) => kv.get(k) ?? null, setKv: async (k: string, v: string) => { kv.set(k, v) } } as any,
    railway: { listServices: async () => SERVICES, details } as any,
    notify: async (t) => { notes.push(t) },
    httpGet: async () => 200,
    dbCoverage: deps(['falak-prod']),
    now: () => now,
  })
  const first = await m.poll()
  assert.equal(notes.length, 1)
  assert.equal(notes[0], [
    '🗄️ new-shop بدون وصول قراءة — شغّل الإعداد؟',
    '🗄️ hudoor-attendance بدون وصول قراءة — شغّل الإعداد؟ (SQLite: يحتاج مسار القراءة في التطبيق)',
    '🗄️ legacy-mysql بدون وصول قراءة — شغّل الإعداد؟',
  ].join('\n'))
  assert.ok(first.includes(notes[0]))
  now += DB_COVERAGE_EVERY_MS - 60_000
  await m.poll()
  assert.equal(notes.length, 1)
  now += 120_000
  await m.poll()
  assert.equal(notes.length, 2)
})

test('المراقب: بلا dbCoverage أو كل شيء مغطّى ← صمت؛ وفشل details لا يُسقط المراقبة', async () => {
  const kv = new Map<string, string>()
  const notes: string[] = []
  const base = {
    store: { getKv: async (k: string) => kv.get(k) ?? null, setKv: async (k: string, v: string) => { kv.set(k, v) } } as any,
    notify: async (t: string) => { notes.push(t) }, httpGet: async () => 200,
  }
  await new RailwayMonitor({ ...base, railway: { listServices: async () => SERVICES, details } as any }).poll()
  const failing = { listServices: async () => SERVICES, details: async () => { throw new Error('rate limited') } } as any
  await new RailwayMonitor({ ...base, railway: failing, dbCoverage: deps(['falak-prod', 'new-shop', 'legacy-mysql']) }).poll()
  assert.deepEqual(notes, [])
})
