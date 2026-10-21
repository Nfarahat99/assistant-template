/** المساعد + محوّل الاستضافة: حالة/إعادة نشر المشروع الذاتي (self) بموافقة "نعم N" فقط. */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import type { RailwayClient, RwService } from './clients/railway.js'
import type { Hosting } from './hosting/types.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

let clock = new Date('2026-10-20T08:00:00Z')
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const github = {} as GitHubClient
const llm: LlmClient = { async complete() { return JSON.stringify({ actions: [{ type: 'answer', text: '?' }], reply: '' }) } }

let redeployCalls = 0
let redeployResult = { ok: true, message: 'بدأت إعادة النشر' }
const fakeHosting = (provider: 'railway' | 'none' = 'railway'): Hosting => ({
  provider,
  status: async () => ({ state: 'running', commit: 'abc1234def', deployedAt: null, detail: 'SUCCESS' }),
  logs: async () => [],
  redeploy: async () => { redeployCalls++; return redeployResult },
})
const rwCalls: string[] = []
const selfSvc: RwService = {
  projectId: 'p', projectName: 'my-assistant', serviceId: 'sv', serviceName: 'web', environmentId: 'env', environmentName: 'production',
  repo: 'example-user/my-assistant', image: null,
  latest: { id: 'd', status: 'SUCCESS', createdAt: '2026-10-20T07:00:00Z', commitHash: 'old', commitMessage: null, url: null }, domains: [],
}
const railway: RailwayClient = {
  async listServices() { rwCalls.push('listServices'); return [selfSvc] },
  async deployments() { return [] }, async logs() { return [] },
  async redeploy() { rwCalls.push('redeploy') },
  async projects() { return [] }, async details() { return [] }, async findTargets() { return [] },
}

let db: Db, store: Store
let seq = 0
const mk = (hosting: Hosting, rw: RailwayClient | null) => new Assistant({
  cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github,
  projects: new ProjectRegistry(parseProjects('[]')), now: () => clock, railway: rw, hosting,
})
const say = async (a: Assistant, text: string) => {
  clock = new Date(clock.getTime() + 2_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `H${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
}
const lastPending = async () => (await store.openPending(clock)).filter((p) => p.kind === 'railway_redeploy').at(-1)

before(async () => { db = await createDb({ pgliteDir: 'memory://' }); await migrate(db); store = new Store(db) })
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0; redeployCalls = 0; rwCalls.length = 0; redeployResult = { ok: true, message: 'بدأت إعادة النشر' } })

test('self: الحالة من محوّل الاستضافة', async () => {
  const a = mk(fakeHosting(), railway)
  await say(a, 'لوقات البوت')
  assert.ok(sent.at(-1)!.includes('شغّال'), String(sent.at(-1)))
  assert.ok(sent.at(-1)!.includes('abc1234'))
  assert.deepEqual(rwCalls, [], 'لا يمر على مسار Railway')
})

test('self: طلب إعادة النشر ينشئ pending (self) ولا ينفّذ؛ الموافقة تنفّذ مرة واحدة', async () => {
  const a = mk(fakeHosting(), railway)
  await say(a, 'أعد النشر البوت')
  const p = await lastPending()
  assert.ok(p, 'pending أُنشئ')
  assert.equal((p!.payload as any).self, true)
  assert.equal(redeployCalls, 0, 'لا إعادة نشر قبل الموافقة')
  await say(a, `نعم ${p!.short_no!}`)
  assert.equal(redeployCalls, 1)
  assert.deepEqual(rwCalls.filter((c) => c === 'redeploy'), [])
})

test('self: فشل المحوّل ← ❌ فشلت إعادة النشر بلا ادعاء نجاح', async () => {
  redeployResult = { ok: false, message: 'Railway رفض' }
  const a = mk(fakeHosting(), railway)
  await say(a, 'أعد النشر البوت')
  await say(a, `نعم ${(await lastPending())!.short_no!}`)
  assert.equal(redeployCalls, 1)
  assert.ok(sent.at(-1)!.includes('❌ فشلت إعادة النشر'), String(sent.at(-1)))
  assert.ok(!sent.at(-1)!.includes('🚀'))
})

test('provider none + Railway موجود ← المسار القديم (لا "غير مربوط")', async () => {
  const a = mk(fakeHosting('none'), railway)
  await say(a, 'أعد النشر البوت')
  assert.ok(rwCalls.includes('listServices'), 'استُخدم Railway')
  const p = await lastPending()
  assert.equal((p!.payload as any).self, undefined)
  assert.equal((p!.payload as any).serviceId, 'sv')
  await say(a, `نعم ${p!.short_no!}`)
  assert.equal(redeployCalls, 0)
  assert.ok(rwCalls.includes('redeploy'))
})
