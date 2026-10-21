import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, parseProfile, PROFILE_PLACEHOLDERS, ProfileError, setProfile, profile, ownerName, assistantName, isProgrammer } from './profile.js'
import { TEST_PROFILE } from './test-profile.js'

const dir = mkdtempSync(join(tmpdir(), 'profile-'))
const write = (name: string, body: unknown) => {
  const p = join(dir, name)
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  return p
}
const minimal = {
  owner: { name: 'فهد' },
  assistant: { name: 'مساعد فهد' },
  user_type: 'non_programmer',
  github: { owner: 'fahad-example', self_repo: 'example-user/fahad-assistant' },
}

test('loads a minimal profile and fills defaults', () => {
  const p = loadProfile(write('ok.json', minimal))
  assert.equal(p.owner.name, 'فهد')
  assert.equal(p.language, 'ar')
  assert.equal(p.timezone, 'Asia/Riyadh')
  assert.deepEqual(p.workweek, [0, 1, 2, 3, 4])
  assert.equal(p.hosting.provider, 'railway')
  assert.deepEqual(p.self_aliases, [])
})

test('missing file → ProfileError naming the path', () => {
  assert.throws(() => loadProfile(join(dir, 'nope.json')), (e: unknown) =>
    e instanceof ProfileError && /nope\.json/.test(e.message))
})

test('invalid JSON → ProfileError', () => {
  assert.throws(() => loadProfile(write('bad.json', '{')), ProfileError)
})

test('schema violation → ProfileError naming the field', () => {
  assert.throws(() => loadProfile(write('v.json', { ...minimal, user_type: 'manager' })),
    (e: unknown) => e instanceof ProfileError && /user_type/.test(e.message))
})

test('self_repo must be owner/name', () => {
  assert.throws(() => loadProfile(write('r.json', { ...minimal, github: { owner: 'x', self_repo: 'just-a-name' } })),
    (e: unknown) => e instanceof ProfileError && /self_repo/.test(e.message))
})

test('non-Riyadh timezone rejected in phase 1', () => {
  assert.throws(() => loadProfile(write('tz.json', { ...minimal, timezone: 'Europe/London' })),
    (e: unknown) => e instanceof ProfileError && /timezone/.test(e.message))
})

test('accessors read the active profile', () => {
  setProfile(loadProfile(write('acc.json', minimal)))
  assert.equal(ownerName(), 'فهد')
  assert.equal(assistantName(), 'مساعد فهد')
  assert.equal(isProgrammer(), false)
  setProfile(TEST_PROFILE)
  assert.equal(profile().owner.name, 'وليد')
  assert.equal(isProgrammer(), true)
})

test('default_branch defaults to main and can be set', () => {
  assert.equal(loadProfile(write('db1.json', minimal)).github.default_branch, 'main')
  assert.equal(loadProfile(write('db2.json', { ...minimal, github: { ...minimal.github, default_branch: 'master' } })).github.default_branch, 'master')
})

test('example placeholder values are rejected with a pointer to the interview', () => {
  const example = JSON.parse(readFileSync(new URL('../assistant.config.example.json', import.meta.url), 'utf8'))
  assert.throws(() => loadProfile(write('ex.json', example)), (e: unknown) =>
    e instanceof ProfileError && e.message.includes('onboarding/interview.md'))
})

test('parseProfile validates raw objects and exposes the placeholders', () => {
  assert.equal(parseProfile(minimal, 'x.json').owner.name, 'فهد')
  assert.throws(() => parseProfile({ ...minimal, owner: { name: PROFILE_PLACEHOLDERS.owner } }, 'x.json'),
    (e: unknown) => e instanceof ProfileError && e.message.includes('onboarding/interview.md'))
  assert.throws(() => parseProfile({}, 'x.json'), ProfileError)
})
