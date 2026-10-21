import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeTask, planDispatch } from './agents.js'
import { RailwayMonitor } from './monitor.js'
import { parseLlmOutput } from './ai/schema.js'
import type { RwService } from './clients/railway.js'

test('توزيع المهام حسب التخصص', () => {
  assert.equal(routeTask('عدّل تصميم لوحة التحكم والألوان')[0].agent.key, 'hammam')
  assert.equal(routeTask('أضف endpoint جديد في الـ API')[0].agent.key, 'sami')
  assert.equal(routeTask('اكتب اختبارات playwright')[0].agent.key, 'samer')
  assert.equal(routeTask('شيء غامض')[0].agent.key, 'sami')
  assert.equal(routeTask('أي شيء', 'محمد')[0].agent.key, 'mohammed')
  const p = planDispatch('أصلح تصميم الصفحة وأضف API', { project: 'a/b' })
  assert.ok(p.briefs.length >= 2)
  assert.match(p.briefs[0].brief, /المشروع: a\/b/)
})

test('مخرجات النموذج تقبل إجراءات الفريق واللابتوب', () => {
  const r = parseLlmOutput(JSON.stringify({ actions: [
    { type: 'agent_dispatch', task: 'x' }, { type: 'laptop_draft', title: 't' },
    { type: 'laptop_list' }, { type: 'laptop_update', draft_id: '2', status: 'done' },
  ], reply: '' }))
  assert.equal(r.ok, true)
})

const svc = (status: string, id = 'd1', domain: string | null = null): RwService => ({
  projectId: 'p', projectName: 'قنديل', serviceId: 's', serviceName: 'web', environmentId: 'e', environmentName: 'production',
  repo: null, image: null, domains: domain ? [domain] : [],
  latest: { id, status: status as any, createdAt: '', commitHash: null, commitMessage: null, url: null },
})

function setup(list: () => RwService[], get?: (u: string) => Promise<number>) {
  const kv = new Map<string, string>()
  const sent: string[] = []
  const m = new RailwayMonitor({
    store: { getKv: async (k: string) => kv.get(k) ?? null, setKv: async (k: string, v: string) => { kv.set(k, v) } } as any,
    railway: { listServices: async () => list() } as any,
    notify: async (t) => { sent.push(t) },
    httpGet: get,
  })
  return { m, sent }
}

test('مراقبة Railway: تنبيه مرة واحدة للنشر الفاشل ثم إشعار تعافي', async () => {
  let cur = svc('CRASHED')
  const { m, sent } = setup(() => [cur])
  await m.poll(); await m.poll()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /سقطت/)
  cur = svc('BUILDING', 'd2'); await m.poll()
  assert.equal(sent.length, 1)
  cur = svc('SUCCESS', 'd2'); await m.poll()
  assert.equal(sent.length, 2)
  assert.match(sent[1], /رجعت تشتغل/)
  cur = svc('FAILED', 'd3'); await m.poll()
  assert.match(sent[2], /فشل النشر/)
})

test('مراقبة Railway: فحص الصحة يحتاج فحصين فاشلين', async () => {
  let code = 502
  const { m, sent } = setup(() => [svc('SUCCESS', 'd1', 'example-x.up.railway.app')], async () => code)
  await m.poll(); assert.equal(sent.length, 0)
  await m.poll(); assert.equal(sent.length, 1); assert.match(sent[0], /ما يستجيب/)
  await m.poll(); assert.equal(sent.length, 1)
  code = 200; await m.poll(); assert.match(sent[1], /رجع يستجيب/)
})

import { createDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'

test('مسودات اللابتوب: إنشاء جاهزة ← إنهاء ← تختفي من القائمة', async () => {
  const db = await createDb({ pgliteDir: 'memory://' } as any)
  await migrate(db)
  const store = new Store(db)
  const plan = planDispatch('صمم واجهة جديدة')
  const d = await store.addLaptopDraft({ title: 'واجهة', agent: plan.briefs[0].agent.key, brief: plan.briefs[0].brief })
  assert.equal(d.status, 'ready')
  assert.equal(d.agent, 'hammam')
  assert.equal((await store.laptopDrafts()).length, 1)
  await store.setLaptopDraftStatus(d.id, 'done')
  assert.equal((await store.laptopDrafts()).length, 0)
  assert.equal((await store.laptopDrafts(true)).length, 1)
  await db.close()
})
