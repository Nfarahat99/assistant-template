import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setProfile } from './profile.js'
import { TEST_PROFILE } from './test-profile.js'
import { systemPrompt } from './ai/understand.js'
import { summaryPrompt } from './news/digest.js'
import { weeklySystem } from './insights/weekly.js'
import { DENY } from './lib/hygiene-deny.js'
import { deniedTerms } from './lib/hygiene.js'

/**
 * برومبتات القالب لا تحمل معرفة مالك بعينه (مشاريعه، مهنته):
 * لا مصطلح من قائمة DENY (hash فقط)، ولا علامات نطاق عامة كانت مكتوبة فيها سابقاً.
 */
const NEUTRAL = ['كمبيوتر المدرسة', 'رائد أعمال']

test('prompts carry no original-owner domain knowledge; interests come from the profile', () => {
  assert.ok(DENY.size >= 30, 'deny list loaded')
  const other = { ...TEST_PROFILE, owner: { name: 'فهد' }, assistant: { name: 'سند' }, interests: 'العقار والتسويق' }
  for (const p of [TEST_PROFILE, other]) {
    setProfile(p)
    try {
      for (const [name, text] of [['understand', systemPrompt()], ['digest', summaryPrompt('')], ['weekly', weeklySystem()]] as const) {
        assert.equal(deniedTerms(text, DENY), 0, `${name}: denied term`)
        for (const m of NEUTRAL) assert.ok(!text.includes(m), `${name}: ${m}`)
      }
      assert.match(summaryPrompt(''), new RegExp(p.interests))
      assert.match(weeklySystem(), new RegExp(p.interests))
    } finally { setProfile(TEST_PROFILE) }
  }
})
