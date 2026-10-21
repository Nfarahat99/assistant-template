import test from 'node:test'
import assert from 'node:assert/strict'
import { planWirdTimes, advanceWird, dailyWirdMessage } from './wird.js'

test('أوقات الورد داخل النافذة ومتفرقة ومرتبة', () => {
  for (let i = 0; i < 200; i++) {
    const t = planWirdTimes(4, 480, 1260)
    assert.equal(t.length, 4)
    for (const x of t) assert.ok(x >= 480 && x < 1260)
    for (let j = 1; j < t.length; j++) assert.ok(t[j] - t[j - 1] >= 60)
  }
})

test('أدنى فجوة ≥ 60 دقيقة حتى في أسوأ الحالات (rng متطرف) للنافذة الافتراضية', () => {
  const lo = () => 0, hi = () => 1 - Number.EPSILON
  // أسوأ حالة: كل وقت في أقصى موضع في قطاعه والتالي في أدنى موضع
  for (const [count, from, to] of [[4, 480, 1260], [5, 480, 1260], [6, 480, 1260], [3, 0, 1440], [8, 360, 1380]] as const) {
    const n = Math.min(count, to - from), seg = (to - from) / n
    if (seg < 61) continue // نافذة لا تتسع لـ 60 دقيقة بين كل تذكيرين
    // تبادل متطرف: الزوجي أدنى والفردي أعلى، ثم العكس
    for (const flip of [0, 1]) {
      let k = 0
      const t = planWirdTimes(count, from, to, () => ((k++ + flip) % 2 ? hi() : lo()))
      for (let j = 1; j < t.length; j++) assert.ok(t[j] - t[j - 1] >= 60, `${count}/${from}-${to} flip=${flip}: ${t.join(',')}`)
    }
  }
  // مئات التكرارات العشوائية بـ rng مبذور (LCG)
  let seed = 12345
  const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
  for (let i = 0; i < 5000; i++) {
    const t = planWirdTimes(4, 480, 1260, rng)
    for (let j = 1; j < t.length; j++) assert.ok(t[j] - t[j - 1] >= 60)
  }
})

test('نافذة ضيقة أو عدد صفر', () => {
  assert.deepEqual(planWirdTimes(0, 480, 600), [])
  assert.deepEqual(planWirdTimes(3, 600, 600), [])
  assert.equal(planWirdTimes(5, 600, 602).length, 2)
})

test('advanceWird: يطلق مرة، ويهمل الفائت بأكثر من ساعة', () => {
  const plan = { day: 'd', times: [500, 700, 900], sent: 0 }
  assert.deepEqual(advanceWird(plan, 499), { plan, fire: false })
  assert.deepEqual(advanceWird(plan, 505), { plan: { ...plan, sent: 1 }, fire: true })
  assert.deepEqual(advanceWird(plan, 730), { plan: { ...plan, sent: 2 }, fire: true })
  assert.deepEqual(advanceWird(plan, 1200), { plan: { ...plan, sent: 3 }, fire: false })
})

test('بوابة إتمام الورد: تطلب النطاق ثم التأكيد', async () => {
  const { isWirdTask, wirdCompletionGate } = await import('./wird.js')
  assert.ok(isWirdTask('ورد القرآن'))
  assert.ok(!isWirdTask('أرسل العرض'))
  assert.ok(wirdCompletionGate('ورد', undefined, true)?.includes('من أي آية'))
  assert.ok(wirdCompletionGate('ورد', '  ', true))
  assert.ok(wirdCompletionGate('ورد', 'البقرة 1-20', false)?.includes('أكّد'))
  assert.equal(wirdCompletionGate('ورد', 'البقرة 1-20', true), null)
})

test('dailyWirdMessage: يتغير يومياً ويثبت داخل اليوم', () => {
  const a = dailyWirdMessage(null, '2026-01-01')
  assert.ok(a.changed)
  const same = dailyWirdMessage(a.daily, '2026-01-01', () => 0.99)
  assert.equal(same.changed, false)
  assert.equal(same.message, a.message)
  for (let i = 0; i < 100; i++) {
    const n = dailyWirdMessage(a.daily, '2026-01-02')
    assert.ok(n.changed)
    assert.notEqual(n.daily.idx, a.daily.idx)
    assert.equal(n.daily.day, '2026-01-02')
  }
})
