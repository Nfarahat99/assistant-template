import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addGuideline, removeGuideline, parseGuidelines, guidelinesForPrompt, MAX_GUIDELINES } from './guidelines.js'
import { buildSystemPrompt } from '../ai/understand.js'
import { wantsRawData } from '../assistant.js'

test('إضافة/تكرار/حذف التوجيهات', () => {
  let { list, added } = addGuideline([], 'لا تعرض جداول', 't')
  assert.equal(added?.id, 1)
  assert.equal(addGuideline(list, '  لا  تعرض جداول ', 't').added, null)
  ;({ list } = addGuideline(list, 'اختصر', 't'))
  assert.equal(list.length, 2)
  assert.equal(removeGuideline(list, 1).list.length, 1)
  assert.equal(removeGuideline(list, 9).removed, null)
})

test('الحد الأقصى يزيح الأقدم، والـ JSON التالف يُتجاهل', () => {
  let list: ReturnType<typeof parseGuidelines> = []
  for (let i = 0; i < MAX_GUIDELINES + 5; i++) list = addGuideline(list, `قاعدة ${i}`, 't').list
  assert.equal(list.length, MAX_GUIDELINES)
  assert.equal(list[0].rule, 'قاعدة 5')
  assert.deepEqual(parseGuidelines('{bad'), [])
})

test('التوجيهات تُحقن في برومبت النظام', () => {
  const g = guidelinesForPrompt(addGuideline([], 'لا تعرض جداول', 't').list)
  assert.match(buildSystemPrompt({ guidelines: g }), /لا تعرض جداول/)
  assert.doesNotMatch(buildSystemPrompt({}), /توجيهات أسلوب علّمني/)
})

test('البيانات الخام فقط عند الطلب الصريح', () => {
  assert.equal(wantsRawData('كم طالب نشط في نبراس؟'), false)
  assert.equal(wantsRawData('وريني الجدول'), true)
})

test('برومبت التوجيهات يصف الإلزام', () => {
  assert.match(guidelinesForPrompt([{ id: 1, rule: 'اختصر', at: 'x' }]), /إلزامية/)
})

test('مراجعة التوجيهات: تصنيف وعلامة المراجعة', async () => {
  const { parseReviewVerdict, markReviewed, unreviewed } = await import('./guidelines.js')
  assert.equal(parseReviewVerdict('x {"verdict":"style","request":""}')?.verdict, 'style')
  assert.equal(parseReviewVerdict('{"verdict":"code","request":""}'), null)
  assert.equal(parseReviewVerdict('تالف'), null)
  const v = parseReviewVerdict('{"verdict":"code","request":"أضف أمراً"}')!
  const { list } = addGuideline([], 'أضف أمراً جديداً', 't')
  assert.equal(unreviewed(list).length, 1)
  const out = markReviewed(list, 1, v)
  assert.equal(out[0].review, 'code')
  assert.equal(out[0].code_request, 'أضف أمراً')
  assert.equal(unreviewed(out).length, 0)
})
