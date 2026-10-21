import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferredUntil } from './gateway.js'
import { formatClock } from '../lib/time.js'

const now = new Date('2026-09-30T20:30:00Z')   // 23:30 بالرياض

test('eta_seconds من رد 202 يحدد موعد الإرسال التقريبي', () => {
  const d = deferredUntil({ id: 'x', status: 'queued', eta_seconds: 23400, fast_lane: false }, now)
  assert.equal(d!.toISOString(), '2026-10-01T03:00:00.000Z')
  assert.equal(formatClock(d!, now, 'Asia/Riyadh'), 'بكرة الساعة 06:00')
})

test('eta_seconds قصير (المسار السريع أو طابور قصير) = غير مؤجلة', () => {
  assert.equal(deferredUntil({ id: 'x', status: 'queued', eta_seconds: 30, fast_lane: true }, now), null)
  assert.equal(deferredUntil({ id: 'x', status: 'queued', eta_seconds: 0 }, now), null)
})

test('بدون eta_seconds نرجع لـ scheduled_at (رد GET)', () => {
  const d = deferredUntil({ id: 'x', status: 'queued', scheduled_at: '2026-10-01T03:00:00Z' }, now)
  assert.equal(d!.toISOString(), '2026-10-01T03:00:00.000Z')
  assert.equal(deferredUntil({ id: 'x', status: 'queued', scheduled_at: '2026-09-30T20:30:30Z' }, now), null)
})

test('formatClock لنفس اليوم', () => {
  assert.equal(formatClock(new Date('2026-09-30T20:45:00Z'), now, 'Asia/Riyadh'), 'الساعة 23:45')
})
