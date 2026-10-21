import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWhen, isoLocal, formatWhen, startOfLocalDay, localParts } from './time.js'

const TZ = 'Asia/Riyadh'
// الاثنين 28 سبتمبر 2026، 10:15 صباحاً بتوقيت الرياض = 07:15Z
const now = new Date('2026-09-28T07:15:00Z')

test('ISO بإزاحة الرياض يُقرأ كما هو', () => {
  assert.equal(parseWhen('2026-09-29T09:00:00+03:00', TZ)!.toISOString(), '2026-09-29T06:00:00.000Z')
})

test('ISO بلا منطقة يُفسَّر بتوقيت الرياض (لا UTC)', () => {
  assert.equal(parseWhen('2026-09-29T09:00', TZ)!.toISOString(), '2026-09-29T06:00:00.000Z')
  assert.equal(parseWhen('2026-09-29 21:30:00', TZ)!.toISOString(), '2026-09-29T18:30:00.000Z')
})

test('تاريخ فقط = 9 الصبح افتراضياً', () => {
  assert.equal(parseWhen('2026-09-29', TZ)!.toISOString(), '2026-09-29T06:00:00.000Z')
})

test('Z مقبولة، والأرقام العربية تُحوَّل', () => {
  assert.equal(parseWhen('2026-09-29T06:00:00Z', TZ)!.toISOString(), '2026-09-29T06:00:00.000Z')
  assert.equal(parseWhen('٢٠٢٦-٠٩-٢٩T٠٩:٠٠', TZ)!.toISOString(), '2026-09-29T06:00:00.000Z')
})

test('القيم غير المفهومة ترجع null لا وقتاً مخترعاً', () => {
  for (const v of ['بكرة', 'tomorrow 9am', '', null, undefined, '2026-13-01', '2026-09-29T25:00'])
    assert.equal(parseWhen(v as any, TZ), null, String(v))
})

test('isoLocal يعطي النموذج الوقت المحلي بالإزاحة', () => {
  assert.equal(isoLocal(now, TZ), '2026-09-28T10:15:00+03:00')
  assert.equal(localParts(now, TZ).wd, 1) // الاثنين
})

test('بداية اليوم المحلي (منتصف الليل الرياض = 21:00Z أمس)', () => {
  assert.equal(startOfLocalDay(now, TZ).toISOString(), '2026-09-27T21:00:00.000Z')
  assert.equal(startOfLocalDay(now, TZ, 1).toISOString(), '2026-09-28T21:00:00.000Z')
})

test('formatWhen: اليوم / بكرة / يوم آخر', () => {
  assert.equal(formatWhen(new Date('2026-09-28T13:30:00Z'), now, TZ), 'اليوم 4:30م')
  assert.equal(formatWhen(new Date('2026-09-29T06:00:00Z'), now, TZ), 'بكرة 9:00ص')
  assert.equal(formatWhen(new Date('2026-10-01T09:00:00Z'), now, TZ), 'الخميس 1/10 12:00م')
})
