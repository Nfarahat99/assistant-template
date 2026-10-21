import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArabic, nameScore, bestMatches } from './arabic.js'
import { normalizeMsisdn } from './phone.js'

test('توحيد الهمزات والتاء المربوطة والألف المقصورة', () => {
  assert.equal(normalizeArabic('أحمد'), 'احمد')
  assert.equal(normalizeArabic('إبراهيم'), 'ابراهيم')
  assert.equal(normalizeArabic('آمنة'), 'امنه')
  assert.equal(normalizeArabic('مصطفى'), 'مصطفي')
})

test('حذف التشكيل والتطويل', () => {
  assert.equal(normalizeArabic('مُحَمَّد'), 'محمد')
  assert.equal(normalizeArabic('ســامي'), 'سامي')
})

test('حذف "ال" من بداية الكلمة', () => {
  assert.equal(normalizeArabic('المدير'), 'مدير')
  assert.equal(normalizeArabic('عبدالله الشهري'), 'عبدالله شهري')
})

test('تطابق كامل > كلمات موجودة > بادئة > خطأ إملائي', () => {
  assert.equal(nameScore('احمد سالم', 'أحمد سالم'), 4)
  assert.equal(nameScore('أحمد', 'أحمد سالم'), 3)
  assert.equal(nameScore('أحم', 'أحمد سالم'), 2)
  assert.equal(nameScore('ابراهم', 'إبراهيم'), 1)
  assert.equal(nameScore('فهد', 'أحمد سالم'), 0)
})

const contacts = [
  { id: 1, names: ['أحمد سالم'] },
  { id: 2, names: ['أحمد الغامدي', 'ابو فهد'] },
  { id: 3, names: ['سامي', 'سامي الشريف'] },
]

test('اسمان "أحمد" = غموض (يرجع الاثنين لا يخمّن)', () => {
  assert.deepEqual(bestMatches('احمد', contacts).map((c) => c.id), [1, 2])
})

test('الاسم الكامل يحسم الغموض', () => {
  assert.deepEqual(bestMatches('أحمد سالم', contacts).map((c) => c.id), [1])
  assert.deepEqual(bestMatches('احمد الغامدي', contacts).map((c) => c.id), [2])
})

test('الاسم البديل يطابق', () => {
  assert.deepEqual(bestMatches('أبو فهد', contacts).map((c) => c.id), [2])
})

test('لا تطابق = قائمة فارغة', () => {
  assert.deepEqual(bestMatches('ماجد', contacts), [])
})

test('تطبيع الجوال (أرقام عربية وصيغ محلية)', () => {
  assert.equal(normalizeMsisdn('٠٥٠٠٠٠٣٤٥٦'), '966500003456')
  assert.equal(normalizeMsisdn('0500003456'), '966500003456')
  assert.equal(normalizeMsisdn('+966 50 000 3456'), '966500003456')
  assert.equal(normalizeMsisdn('500003456'), '966500003456')
  assert.equal(normalizeMsisdn('abc'), null)
})
