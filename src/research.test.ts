/**
 * مقارنة التقنيات (research_tech) والبحث عن مهارات Claude (find_skills) — بحث مؤسَّس مزيّف.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects, claudeConfigProject } from './projects.js'
import { parseGrounded } from './ai/websearch.js'
import { extractResearch } from './ai/research.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'
import type { SkillsClient } from './clients/skills.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'

const RESEARCH = {
  candidates: [{
    content: { parts: [{ text:
      'مقارنة سريعة:\n' +
      '1. BullMQ — طوابير مهام على Redis | الملاءمة: ممتاز مع Node/TS | التكلفة: مجاني (يحتاج Redis) | النضج: 6K نجمة\n' +
      '2. pg-boss — طوابير على Postgres نفسها | الملاءمة: يستخدم Postgres الموجود على Railway | التكلفة: مجاني | النضج: إصدار 10\n' +
      '3. أداة وهمية بلا مصدر — لا يجب أن تظهر | الملاءمة: - | التكلفة: - | النضج: -\n' +
      'التوصية: pg-boss لأنه يستخدم Postgres الموجود بلا خدمة إضافية.' }] },
    groundingMetadata: {
      webSearchQueries: ['bullmq vs pg-boss'],
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BULL', title: 'docs.bullmq.io' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/PGB', title: 'github.com' } },
      ],
      groundingSupports: [
        { segment: { text: 'BullMQ — طوابير مهام على Redis' }, groundingChunkIndices: [0] },
        { segment: { text: 'pg-boss — طوابير على Postgres نفسها' }, groundingChunkIndices: [1] },
      ],
    },
  }],
}

test('extractResearch: خيارات بمصادر حقيقية فقط + توصية، والخيار بلا مصدر يُحذف', () => {
  const r = extractResearch(parseGrounded(RESEARCH))
  assert.equal(r.options.length, 2)
  assert.deepEqual(r.options.map((o) => o.name), ['BullMQ', 'pg-boss'])
  assert.equal(r.options[1].cost, 'مجاني')
  assert.equal(r.options[1].fit, 'يستخدم Postgres الموجود على Railway')
  assert.equal(r.options[0].maturity, '6K نجمة')
  assert.match(r.recommendation!, /^pg-boss/)
})

const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)
let db: Db, store: Store, a: Assistant
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
const script: Record<string, any> = {}
const prompts: string[] = []
const llm: LlmClient = {
  async complete(_s, user) {
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: '?' }], reply: '' })
  },
  async searchWeb(prompt) { prompts.push(prompt); return parseGrounded(RESEARCH) },
}
const skillsCalls: string[] = []
const skills: SkillsClient = {
  async search(q) {
    skillsCalls.push(q)
    return [
      { pkg: 'anthropics/skills@pdf', name: 'pdf', installs: 202489, url: 'https://skills.sh/anthropics/skills/pdf', description: 'Use this skill whenever the user wants to do anything with PDF files.' },
      { pkg: 'openai/skills@pdf', name: 'pdf', installs: 12830, url: 'https://skills.sh/openai/skills/pdf', description: null },
    ]
  },
}
const github: GitHubClient = {
  async dispatchWorkflow() {}, async listRuns() { return [] }, async findPrByBranch() { return null },
  async getPr() { throw new Error('x') }, async prFiles() { return [] }, async mergePr() {}, async closePr() {},
  async deleteBranch() {}, async getFileContent() { return '[]' },
}
let seq = 0
async function say(text: string) {
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `R${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(Date.now() / 1000) + seq, type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
}

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([{ folder: 'C:/hudoor', repo: 'example-user/hudoor', aliases: ['تحضير سراج'] }])))
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects, skills })
})
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0 })

test('research_tech: رد فوري، ثم خيارات بمصادر وتوصية، و"نفّذها في <مشروع>" ← طلب كود بمعاينة', async () => {
  script['وش أفضل مكتبة طوابير لمشاريعي؟'] = { actions: [{ type: 'research_tech', task: 'أفضل مكتبة طوابير مهام', constraints: 'مجانية' }], reply: '' }
  await say('وش أفضل مكتبة طوابير لمشاريعي؟')
  assert.ok(sent[0].startsWith('🧪 جالس أبحث وأقارن'))
  assert.match(prompts.at(-1)!, /Next\.js، Node\/TypeScript، Railway/)
  const res = sent.at(-1)!
  assert.match(res, /1\. BullMQ — طوابير مهام على Redis/)
  assert.match(res, /💰 مجاني/)
  assert.match(res, /🔗 github\.com: https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/PGB/)
  assert.match(res, /✅ التوصية: pg-boss/)
  assert.doesNotMatch(res, /أداة وهمية/)

  await say('نفّذها في تحضير سراج')
  assert.match(sent.at(-1)!, /بأطلب من Claude تعديل على تحضير سراج \(example-user\/hudoor\)/)
  assert.match(sent.at(-1)!, /التوصية المختارة: pg-boss/)
  await say('لا')
})

test('find_skills: نتائج skills.sh بالتثبيتات والرابط، و"ثبّت 1" ← طلب كود على إعدادات Claude', async () => {
  script['دور لي مهارة للتعامل مع PDF'] = { actions: [{ type: 'find_skills', query: 'pdf' }], reply: '' }
  await say('دور لي مهارة للتعامل مع PDF')
  assert.deepEqual(skillsCalls, ['pdf'])
  const res = sent.at(-1)!
  assert.match(res, /1\. anthropics\/skills@pdf — 202\.5K تثبيت/)
  assert.match(res, /Use this skill whenever/)
  assert.match(res, /https:\/\/skills\.sh\/anthropics\/skills\/pdf/)
  assert.match(res, /ثبّت <رقم>/)

  await say('ثبّت 1')
  const m = sent.at(-1)!
  assert.match(m, /بأطلب من Claude تعديل على إعدادات كلود \(example-user\/claude-config\)/)
  assert.match(m, /install skill anthropics\/skills@pdf into skills\/ via `npx -y skills add anthropics\/skills@pdf` then commit/)
  await say('ثبّت 9')
  assert.match(sent.at(-1)!, /اختر رقم من 1 إلى 2/)
})

test('إعدادات Claude مدمجة في المشاريع: "المهارات" / "إعدادات كلود"', () => {
  const reg = new ProjectRegistry([])
  assert.equal(reg.resolve('المهارات')[0].repo, claudeConfigProject()!.repo)
  assert.equal(reg.resolve('إعدادات كلود')[0].repo, claudeConfigProject()!.repo)
  assert.equal(reg.all().length, 2, 'البوت + إعدادات Claude')
})
