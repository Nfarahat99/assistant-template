import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setProfile } from './profile.js'
import { TEST_PROFILE } from './test-profile.js'
import { ProjectRegistry } from './projects.js'

const nonProg = { ...TEST_PROFILE, user_type: 'non_programmer' as const, github: { owner: 'k', self_repo: 'k/assistant', default_branch: 'main' } }

test('non-programmer registry: only the self repo, file projects ignored', () => {
  setProfile(nonProg)
  try {
    const reg = new ProjectRegistry()
    reg.set([{ folder: 'x', repo: 'k/other', default_branch: 'main', aliases: ['مشروع إكس'], railway_project: null }])
    assert.deepEqual(reg.all().map((p) => p.repo), ['k/assistant'])
    assert.equal(reg.resolve('مشروع إكس').length, 0)
    assert.equal(reg.resolve('البوت').length, 1)
  } finally { setProfile(TEST_PROFILE) }
})

test('programmer registry keeps file projects', () => {
  const reg = new ProjectRegistry()
  reg.set([{ folder: 'x', repo: 'example-user/other', default_branch: 'main', aliases: ['مشروع إكس'], railway_project: null }])
  assert.ok(reg.all().some((p) => p.repo === 'example-user/other'))
})

// ───── المساعدة ("وش تقدر تسوي") حسب نوع المستخدم ─────
import { createHash } from 'node:crypto'
import { capabilitiesForOwner } from './capabilities.js'
import { help } from './format.js'

const helpState = {
  githubConnected: true, githubOwner: 'o', projects: [{ label: 'a', repo: 'o/a' }, { label: 'b', repo: 'o/b' }], selfRepo: 'o/self',
  telegram: 'bound' as const, whatsapp: { status: 'connected', banned: false }, sendMode: 'link' as const, version: null, recentJobs: [],
  databases: ['نبراس'], dbAccess: true,
}
const helpOutputs = () => [
  capabilitiesForOwner(helpState),
  capabilitiesForOwner({ ...helpState, githubConnected: false, whatsappEnabled: false, sendMode: 'direct', databases: [] }),
  help(),
]

test('help (programmer, TEST_PROFILE): byte-identical to the original output', () => {
  const h = createHash('sha256').update(JSON.stringify(helpOutputs())).digest('hex')
  // تحدّث عمداً: أُضيف سطر «ابدأ المقابلة» (المقابلة الشخصية) للمساعدة وقائمة القدرات؛ ثم أسماء الأمثلة صارت عامة (تنظيف القالب العام)
  assert.equal(h, '09ba2479c0f505594ce0acda33e44b39fe7ff26c2a151e59ef56f494b6c72472')
  for (const out of helpOutputs()) assert.match(out, /ابدأ المقابلة/)
})

test('help (non-programmer): "طوّر نفسك" instead of editing projects; no skill-install / database lines', () => {
  setProfile(nonProg)
  try {
    const [caps, , h] = helpOutputs()
    assert.match(caps, /💻 طوّر نفسك: /)
    assert.doesNotMatch(caps, /عدّل في <مشروع>|مشاريعي/)
    assert.doesNotMatch(caps, /🧰|ثبّت 1/)
    assert.doesNotMatch(caps, /🗄️|قواعد بيانات|استعلامات كلود/)
    assert.match(h, /"طوّر نفسك: /)
    assert.doesNotMatch(h, /عدّل في مشروع|واتساب سراج/)
  } finally { setProfile(TEST_PROFILE) }
})
