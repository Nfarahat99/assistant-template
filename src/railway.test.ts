import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProjects, formatRailway, formatRailwayDetails, httpRailway } from './clients/railway.js'

const data = { projects: { edges: [{ node: {
  id: 'p1', name: 'my-assistant',
  environments: { edges: [{ node: { id: 'e1', name: 'production' } }] },
  services: { edges: [
    { node: { name: 'bot', serviceInstances: { edges: [{ node: { environmentId: 'e1', latestDeployment: { status: 'SUCCESS', createdAt: '2026-09-29T10:00:00Z' } } }] } } },
    { node: { name: 'db', serviceInstances: { edges: [] } } },
  ] },
} }] } }

test('railway: parse + format', () => {
  const ps = parseProjects(data)
  assert.equal(ps[0].services[0].environment, 'production')
  assert.equal(ps[0].services[1].status, null)
  const t = formatRailway(ps)
  assert.match(t, /bot \(production\): ✅ شغّال — 2026-09-29 10:00 UTC/)
  assert.match(formatRailway([], 'x'), /«x»/)
})

test('railway: http client يرسل Bearer ويفلتر بالاسم ويُظهر أخطاء GraphQL', async () => {
  const orig = globalThis.fetch
  let auth = ''
  let body: any = { data }
  globalThis.fetch = (async (_u: any, init: any) => { auth = init.headers.Authorization; return new Response(JSON.stringify(body)) }) as any
  try {
    const c = httpRailway('tok')
    assert.equal((await c.projects('MY')).length, 1)
    assert.equal((await c.projects('zzz')).length, 0)
    assert.equal(auth, 'Bearer tok')
    body = { errors: [{ message: 'Not Authorized' }] }
    await assert.rejects(c.projects(), /Not Authorized/)
  } finally { globalThis.fetch = orig }
})

test('railway: details يعرض النشرات وأسماء المتغيرات فقط دون القيم', async () => {
  const orig = globalThis.fetch
  const ids = { projects: { edges: [{ node: {
    id: 'p1', name: 'my-assistant',
    environments: { edges: [{ node: { id: 'e1', name: 'production' } }] },
    services: { edges: [{ node: { id: 's1', name: 'bot', serviceInstances: { edges: [{ node: { environmentId: 'e1' } }] } } }] },
  } }] } }
  const detail = {
    deployments: { edges: [{ node: { status: 'FAILED', createdAt: '2026-09-29T09:00:00Z' } }] },
    variables: { ZED: 'super-secret-value', API_KEY: 'sk-123' },
  }
  globalThis.fetch = (async (_u: any, init: any) =>
    new Response(JSON.stringify({ data: JSON.parse(init.body).variables ? detail : ids }))) as any
  try {
    const d = await httpRailway('tok').details('bot')
    assert.deepEqual(d[0].variables, ['API_KEY', 'ZED'])
    const t = formatRailwayDetails(d, 'bot')
    assert.match(t, /API_KEY, ZED/)
    assert.match(t, /❌ فشل — 2026-09-29 09:00 UTC/)
    assert.doesNotMatch(t, /super-secret-value|sk-123/)
    assert.equal((await httpRailway('tok').details('zzz')).length, 0)
  } finally { globalThis.fetch = orig }
})

test('railway: findTargets يفضّل التطابق التام وbenchmark production، وredeploy يرسل mutation بالمعرّفات', async () => {
  const orig = globalThis.fetch
  const two = { projects: { edges: [{ node: {
    id: 'p1', name: 'my-assistant',
    environments: { edges: [{ node: { id: 'e1', name: 'production' } }, { node: { id: 'e2', name: 'staging' } }] },
    services: { edges: [{ node: { id: 's1', name: 'bot', serviceInstances: { edges: [{ node: { environmentId: 'e1' } }, { node: { environmentId: 'e2' } }] } } }] },
  } }] } }
  const sent: any[] = []
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body); sent.push(b)
    return new Response(JSON.stringify({ data: b.query.includes('mutation') ? { serviceInstanceRedeploy: true } : two }))
  }) as any
  try {
    const c = httpRailway('tok')
    const t = await c.findTargets('my', 'bot')
    assert.equal(t.length, 1)
    assert.equal(t[0].environment, 'production')
    assert.equal((await c.findTargets('zzz')).length, 0)
    await c.redeploy('s1', 'e1')
    const m = sent.at(-1)
    assert.match(m.query, /serviceInstanceRedeploy/)
    assert.deepEqual(m.variables, { serviceId: 's1', environmentId: 'e1' })
  } finally { globalThis.fetch = orig }
})

test('railway: redeploy يرمي خطأ إذا رجع Railway false بدل إعلان نجاح كاذب', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { serviceInstanceRedeploy: false } }))) as any
  try {
    await assert.rejects(httpRailway('tok').redeploy('s1', 'e1'), /رفض/)
  } finally { globalThis.fetch = orig }
})
