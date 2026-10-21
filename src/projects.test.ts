import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectRegistry, parseProjects } from './projects.js'

const reg = new ProjectRegistry(parseProjects(JSON.stringify([
  { folder: 'whatsappSiraj', repo: 'example-user/whatsapp-siraj', default_branch: 'main', aliases: ['واتساب سراج', 'الوسيط'] },
  { folder: 'hudoor', repo: 'example-user/hudoor', default_branch: 'master', aliases: ['تحضير سراج'] },
  { folder: 'planners', repo: 'example-user/planners', aliases: ['جداول سراج'] },
])))

test('الاسم البديل العربي يحدد المشروع', () => {
  assert.deepEqual(reg.resolve('واتساب سراج').map((p) => p.folder), ['whatsappSiraj'])
  assert.deepEqual(reg.resolve('تحضير سراج').map((p) => p.folder), ['hudoor'])
})

test('بدون "ال"', () => {
  assert.deepEqual(reg.resolve('وسيط').map((p) => p.folder), ['whatsappSiraj'])
})

test('اسم المجلد واسم المستودع بالشرطة كلام منطوق', () => {
  assert.deepEqual(reg.resolve('whatsappsiraj').map((p) => p.folder), ['whatsappSiraj'])
  assert.deepEqual(reg.resolve('whatsapp siraj').map((p) => p.folder), ['whatsappSiraj'])
})

test('"سراج" وحدها غامضة → أكثر من مشروع', () => {
  assert.ok(reg.resolve('سراج').length > 1)
})

test('غير موجود → فارغ', () => {
  assert.deepEqual(reg.resolve('مشروع الفواتير'), [])
})

test('default_branch يُفترض main، والعناصر غير الصالحة تُتجاهل', () => {
  const list = parseProjects(JSON.stringify([{ folder: 'a', repo: 'o/a' }, { folder: 'b', repo: 'bad repo' }]))
  assert.equal(list.length, 1)
  assert.equal(list[0].default_branch, 'main')
})

import { setProfile } from './profile.js'
import { TEST_PROFILE } from './test-profile.js'
import { selfProject, claudeConfigProject } from './projects.js'

test('self project comes from the profile', () => {
  setProfile({ ...TEST_PROFILE, github: { owner: 'fahad-example', self_repo: 'example-user/fahad-assistant', default_branch: 'main' }, self_aliases: ['مساعد فهد'], hosting: { provider: 'railway', railway_project: 'fahad-assistant' } })
  try {
    const p = selfProject()
    assert.equal(p.repo, 'example-user/fahad-assistant')
    assert.equal(p.railway_project, 'fahad-assistant')
    assert.ok(p.aliases.includes('البوت') && p.aliases.includes('نفسك') && p.aliases.includes('مساعد فهد'))
    assert.equal(claudeConfigProject(), null)
  } finally { setProfile(TEST_PROFILE) }
})

test('self project default_branch comes from the profile', () => {
  setProfile({ ...TEST_PROFILE, github: { ...TEST_PROFILE.github, default_branch: 'master' } })
  try {
    assert.equal(selfProject().default_branch, 'master')
  } finally { setProfile(TEST_PROFILE) }
  assert.equal(selfProject().default_branch, TEST_PROFILE.github.default_branch)
})
