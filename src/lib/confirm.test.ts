import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfirmation } from './confirm.js'

test('كلمات الموافقة', () => {
  for (const w of ['نعم', 'اي', 'إي', 'تمام', 'ارسل', 'أرسل', 'ok', 'OK', '👍', '1', 'نعم.', 'تمام!'])
    assert.deepEqual(parseConfirmation(w), { kind: 'yes' }, w)
})

test('"نعم 2" و"نعم ٢" تحدد طلباً بعينه', () => {
  assert.deepEqual(parseConfirmation('نعم 2'), { kind: 'yes', index: 2 })
  assert.deepEqual(parseConfirmation('نعم ٢'), { kind: 'yes', index: 2 })
  assert.deepEqual(parseConfirmation('تمام 3'), { kind: 'yes', index: 3 })
})

test('كلمات الرفض', () => {
  for (const w of ['لا', 'الغ', 'cancel', 'Cancel'])
    assert.deepEqual(parseConfirmation(w), { kind: 'no' }, w)
  assert.deepEqual(parseConfirmation('لا 2'), { kind: 'no', index: 2 })
})

test('عدّل بنص جديد (بالشدة وبدونها، مع رقم وبدونه)', () => {
  assert.deepEqual(parseConfirmation('عدّل: بتأخر نص ساعة'), { kind: 'edit', text: 'بتأخر نص ساعة' })
  assert.deepEqual(parseConfirmation('عدل: سطر\nسطر ثاني'), { kind: 'edit', text: 'سطر\nسطر ثاني' })
  assert.deepEqual(parseConfirmation('عدل 2: نص'), { kind: 'edit', text: 'نص', index: 2 })
})

test('الكلام العادي ليس موافقة (الأمان أولاً)', () => {
  for (const w of ['نعم بس بعدين', 'ذكرني بكرة', 'لا تنسى الموعد', 'عدل', 'عدّل:', '', '2', 'اي شي'])
    assert.equal(parseConfirmation(w), null, JSON.stringify(w))
})

import { yesStrength } from './confirm.js'

test('قوة كلمة الموافقة: تمام/ok/اي/1 ضعيفة، نعم قوية وتكفي للدمج', () => {
  for (const w of ['تمام', 'ok', 'اي', 'y', '👍', '1']) assert.deepEqual(yesStrength(w), { strong: false, merge: false }, w)
  assert.deepEqual(yesStrength('نعم 3'), { strong: true, merge: true })
  assert.deepEqual(yesStrength('ارسل'), { strong: true, merge: false })
  assert.deepEqual(yesStrength('ادمجه 2'), { strong: true, merge: true })
})
