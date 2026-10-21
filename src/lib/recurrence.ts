/**
 * التذكيرات المتكررة (عادات يومية: ورد، قراءة كتاب…). تُخزَّن في tasks.recurrence كـ JSON:
 *   {"kind":"daily","time":"21:00"}
 *   {"kind":"weekly","days":[0,3],"time":"09:00"}        ← 0=الأحد … 6=السبت
 *   {"kind":"every_n_days","n":2,"start":"2026-10-07","time":"21:00"}
 *   {"kind":"weekdays","time":"07:30"}                    ← أيام الدوام في السعودية: الأحد–الخميس
 * الوقت دائماً بتوقيت المالك (Asia/Riyadh افتراضياً).
 *
 * المبدأ: المهمة المتكررة تبقى مفتوحة؛ remind_at/due_at = الموعد القادم دائماً (لا ماضٍ أبداً).
 * بعد كل تذكير يُحسب الموعد التالي بعد "الآن" — المواعيد الفائتة تُتخطّى (تذكير واحد لكل موعد).
 */
import { localParts, zonedToDate } from './time.js'

export type RecurrenceKind = 'daily' | 'weekly' | 'every_n_days' | 'weekdays'
export interface Recurrence { kind: RecurrenceKind; time: string; days?: number[]; n?: number; start?: string }

/** أيام الدوام في السعودية */
export const SAUDI_WEEKDAYS = [0, 1, 2, 3, 4]
export const DEFAULT_RECURRENCE_TIME = '09:00'
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']

const DAY_WORDS: [RegExp, number][] = [
  [/احد|أحد|sun/i, 0], [/اثنين|إثنين|الاثنين|mon/i, 1], [/ثلاثاء|ثلاثا|tue/i, 2], [/اربعاء|أربعاء|اربعا|wed/i, 3],
  [/خميس|thu/i, 4], [/جمعة|جمعه|fri/i, 5], [/سبت|sat/i, 6],
]

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/
const pad = (n: number) => String(n).padStart(2, '0')
const normTime = (t: unknown): string | null => {
  const m = HHMM.exec(String(t ?? '').trim())
  return m ? `${pad(+m[1])}:${m[2]}` : null
}

function parseDays(s: string): number[] {
  const out = new Set<number>()
  for (const part of s.split(/[,،\s/|]+|و(?=\S)/).map((x) => x.trim()).filter(Boolean)) {
    if (/^[0-6]$/.test(part)) { out.add(+part); continue }
    for (const [re, d] of DAY_WORDS) if (re.test(part)) out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * يقبل كائناً أو نصاً: "daily" | "daily@21:00" | "weekly:0,3" | "weekly:الأحد" | "every_n_days:2" | "weekdays"
 * وكذلك "يومياً" / "كل يوم" / "كل يومين" / "كل أحد" / "أسبوعياً". غير مفهوم/فاضي/once ← null.
 * fallbackTime: وقت التذكير إن لم يُذكر وقت داخل التكرار نفسه.
 */
export function parseRecurrence(raw: unknown, fallbackTime: string | null = null): Recurrence | null {
  if (raw == null || raw === '' || raw === false) return null
  let obj: any = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null
    if (s.startsWith('{')) { try { obj = JSON.parse(s) } catch { return null } } else obj = null
    if (!obj) return parseRecurrenceText(s, fallbackTime)
  }
  if (typeof obj !== 'object') return null
  const kindText = String(obj.kind ?? obj.type ?? '').trim()
  const base = parseRecurrenceText(kindText + (obj.days != null && !Array.isArray(obj.days) ? `:${obj.days}` : obj.n != null ? `:${obj.n}` : ''), null)
  if (!base) return null
  const time = normTime(obj.time) ?? fallbackTime ?? base.time
  const days = Array.isArray(obj.days) ? obj.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6) : base.days
  const n = obj.n != null ? Math.trunc(Number(obj.n)) : base.n
  const r: Recurrence = { kind: base.kind, time: normTime(time) ?? DEFAULT_RECURRENCE_TIME }
  if (r.kind === 'weekly' && days?.length) r.days = [...new Set<number>(days)].sort((a, b) => a - b)
  if (r.kind === 'every_n_days') {
    if (!n || n < 1 || n > 365) return null
    if (n === 1) r.kind = 'daily'
    else r.n = n
  }
  if (typeof obj.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.start)) r.start = obj.start
  return r
}

function parseRecurrenceText(s0: string, fallbackTime: string | null): Recurrence | null {
  const s = s0.trim().toLowerCase()
  if (!s || /^(none|once|no|false|null|مرة|مره)$/.test(s)) return null
  const tm = /(?:@|\s|^)(\d{1,2}:\d{2})\b/.exec(s)
  const time = (tm && normTime(tm[1])) || fallbackTime || DEFAULT_RECURRENCE_TIME
  const body = tm ? s.replace(tm[0], ' ').trim() : s
  let m: RegExpExecArray | null
  if (/^(weekdays|workdays|أيام الدوام|ايام الدوام|أيام العمل|ايام العمل)/.test(body)) return { kind: 'weekdays', time }
  if ((m = /^(?:every_n_days|every)[:\s_-]*(\d+)/.exec(body)) || (m = /كل\s*(\d+)\s*(?:أيام|ايام|يوم)/.exec(body))) {
    const n = +m[1]
    if (!n || n > 365) return null
    return n === 1 ? { kind: 'daily', time } : { kind: 'every_n_days', n, time }
  }
  if (/كل\s*يومين/.test(body)) return { kind: 'every_n_days', n: 2, time }
  if (/^(daily|day|يومي|يومياً|يوميا|يومية|كل\s*يوم\b)/.test(body) || /^كل\s*يوم$/.test(body)) return { kind: 'daily', time }
  if ((m = /^(?:weekly|week)(?:[:\s]+(.+))?$/.exec(body))) {
    const days = m[1] ? parseDays(m[1]) : []
    return days.length ? { kind: 'weekly', days, time } : { kind: 'weekly', time }
  }
  if (/^(أسبوعي|اسبوعي|أسبوعياً|اسبوعيا|كل\s*أسبوع|كل\s*اسبوع)/.test(body)) {
    const days = parseDays(body.replace(/^(أسبوعي[اً]*|اسبوعي[اً]*|كل\s*[أا]سبوع)/, ''))
    return days.length ? { kind: 'weekly', days, time } : { kind: 'weekly', time }
  }
  if ((m = /^كل\s+(.+)$/.exec(body))) {
    const days = parseDays(m[1])
    if (days.length) return { kind: 'weekly', days, time }
  }
  return null
}

/** يكمّل ما يلزم من أول موعد: أيام الأسبوع لـ "أسبوعياً" بلا يوم، وتاريخ البداية لـ "كل N أيام" */
export function anchorRecurrence(r: Recurrence, first: Date, tz: string): Recurrence {
  const out = { ...r }
  const p = localParts(first, tz)
  if (out.kind === 'weekly' && !out.days?.length) out.days = [p.wd]
  if (out.kind === 'every_n_days' && !out.start) out.start = `${p.y}-${pad(p.mo)}-${pad(p.d)}`
  return out
}

const dayNum = (y: number, mo: number, d: number) => Math.round(Date.UTC(y, mo - 1, d) / 86_400_000)

function matchesDay(r: Recurrence, y: number, mo: number, d: number, wd: number): boolean {
  switch (r.kind) {
    case 'daily': return true
    case 'weekdays': return SAUDI_WEEKDAYS.includes(wd)
    case 'weekly': return (r.days?.length ? r.days : [wd]).includes(wd)
    case 'every_n_days': {
      if (!r.start) return true
      const [sy, sm, sd] = r.start.split('-').map(Number)
      const diff = dayNum(y, mo, d) - dayNum(sy, sm, sd)
      return diff >= 0 && diff % (r.n ?? 1) === 0
    }
  }
}

/** أقرب موعد بعد `after` تماماً (لا يرجع ماضياً أبداً) */
export function nextOccurrence(r: Recurrence, after: Date, tz: string): Date {
  const [h, mi] = r.time.split(':').map(Number)
  const p = localParts(after, tz)
  for (let i = 0; i <= 800; i++) {
    const cand = zonedToDate(p.y, p.mo, p.d + i, h, mi, tz)
    if (cand.getTime() <= after.getTime()) continue
    const c = localParts(cand, tz)
    if (matchesDay(r, c.y, c.mo, c.d, c.wd)) return cand
  }
  // لا يحدث عملياً (قاعدة لا تطابق أي يوم) — بعد يوم بدل حلقة لا تنتهي
  return new Date(after.getTime() + 86_400_000)
}

/** "2026-10-07" بتوقيت المالك */
export function localDate(d: Date, tz: string): string {
  const p = localParts(d, tz)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
}

/** هل `date` (YYYY-MM-DD) يوم موعد؟ */
export function isOccurrenceDate(r: Recurrence, date: string): boolean {
  const [y, mo, d] = date.split('-').map(Number)
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  return matchesDay(r, y, mo, d, wd)
}

function shiftDate(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/**
 * السلسلة (streak): عدد المواعيد المتتالية المنجزة حتى اليوم. موعد اليوم إن لم يُنجز بعد لا يكسرها
 * (اليوم ما خلص)، وأي موعد سابق فائت يكسرها.
 */
export function streak(r: Recurrence, done: Set<string>, today: string): number {
  let n = 0
  let date = today
  for (let i = 0; i < 800; i++, date = shiftDate(date, -1)) {
    if (r.start && date < r.start) break
    if (!isOccurrenceDate(r, date)) continue
    if (done.has(date)) { n++; continue }
    if (date === today) continue
    break
  }
  return n
}

/** المواعيد المتوقعة بين تاريخين (شاملة) — لعدّ "أنجز ٥ من ٧" في التقرير الأسبوعي */
export function expectedBetween(r: Recurrence, from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from, i = 0; d <= to && i < 400; d = shiftDate(d, 1), i++) {
    if (r.start && d < r.start) continue
    if (isOccurrenceDate(r, d)) out.push(d)
  }
  return out
}

function clock12(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad(m)}${h < 12 ? 'ص' : 'م'}`
}

/** "يومياً 9:00م" / "كل الأحد والأربعاء 9:00ص" / "كل يومين 9:00م" / "أيام الدوام 7:30ص" */
export function formatRecurrence(r: Recurrence): string {
  const when = clock12(r.time)
  switch (r.kind) {
    case 'daily': return `يومياً ${when}`
    case 'weekdays': return `أيام الدوام (الأحد–الخميس) ${when}`
    case 'weekly': return `كل ${(r.days?.length ? r.days : []).map((d) => AR_DAYS[d]).join(' و') || 'أسبوع'} ${when}`
    case 'every_n_days': return `${r.n === 2 ? 'كل يومين' : `كل ${r.n} أيام`} ${when}`
  }
}

export const serializeRecurrence = (r: Recurrence) => JSON.stringify(r)

/** من عمود tasks.recurrence (أو null) */
export function taskRecurrence(t: { recurrence?: string | null }): Recurrence | null {
  return t.recurrence ? parseRecurrence(t.recurrence) : null
}
