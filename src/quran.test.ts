import test from 'node:test'
import assert from 'node:assert/strict'
import { TOTAL_AYAHS, parseWirdRange, recordWirdRead, suggestWird, wirdProgressLine, juzOf } from './quran.js'

test('مجموع الآيات ٦٢٣٦ وحدود الأجزاء', () => {
  assert.equal(TOTAL_AYAHS, 6236)
  assert.equal(juzOf({ surah: 1, ayah: 1 }), 1)
  assert.equal(juzOf({ surah: 22, ayah: 78 }), 17)
  assert.equal(juzOf({ surah: 25, ayah: 20 }), 18)
  assert.equal(juzOf({ surah: 25, ayah: 21 }), 19)
  assert.equal(juzOf({ surah: 114, ayah: 6 }), 30)
})

test('قول المالك: قرأت الحج والمؤمنون والنور والفرقان → الموضع التالي الشعراء ١ (الجزء ١٩)', () => {
  const r = parseWirdRange('الحج والمؤمنون والنور والفرقان')
  assert.deepEqual(r, { from: { surah: 22, ayah: 1 }, to: { surah: 25, ayah: 77 } })
  const { progress, ayahs } = recordWirdRead(null, r!, '2026-10-09')
  assert.equal(ayahs, 78 + 118 + 64 + 77)
  assert.deepEqual(progress.next, { surah: 26, ayah: 1 })
  const s = suggestWird(progress)
  assert.equal(s.juz, 19)
  assert.deepEqual(s.to, { surah: 27, ayah: 55 })
  assert.match(wirdProgressLine(progress), /الشعراء 1.*الجزء 19/s)
})

test('نطاق آيات وجزء كامل', () => {
  assert.deepEqual(parseWirdRange('البقرة 1-20'), { from: { surah: 2, ayah: 1 }, to: { surah: 2, ayah: 20 } })
  assert.deepEqual(parseWirdRange('من البقرة ٥ إلى آل عمران 10'), { from: { surah: 2, ayah: 5 }, to: { surah: 3, ayah: 10 } })
  assert.deepEqual(parseWirdRange('الجزء 30')?.to, { surah: 114, ayah: 6 })
  assert.equal(parseWirdRange('كلام غير مفهوم'), null)
  assert.equal(parseWirdRange('البقرة 300'), null)
})

test('إتمام المصحف يزيد الختمات ويعيد للفاتحة', () => {
  const { progress } = recordWirdRead({ next: { surah: 114, ayah: 1 }, khatmas: 1, updated: 'x' }, { from: { surah: 114, ayah: 1 }, to: { surah: 114, ayah: 6 } }, 'd')
  assert.equal(progress.khatmas, 2)
  assert.deepEqual(progress.next, { surah: 1, ayah: 1 })
})
