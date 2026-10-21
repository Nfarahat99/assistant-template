import { toLatinDigits } from './phone.js'

/**
 * أدوات الوقت — كل شيء محسوب بتوقيت المالك (الرياض افتراضياً) عبر Intl،
 * فلا نعتمد على TZ الخاص بالحاوية.
 */

export interface LocalParts { y: number; mo: number; d: number; h: number; mi: number; wd: number }

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function localParts(date: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  })
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WD[p.weekday] ?? 0 }
}

/** فرق المنطقة عن UTC بالدقائق في لحظة معيّنة */
function offsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000)
}

/** وقت محلي (في tz) → لحظة UTC */
export function zonedToDate(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi))
  const off = offsetMinutes(guess, tz)
  return new Date(guess.getTime() - off * 60000)
}

export function startOfLocalDay(date: Date, tz: string, addDays = 0): Date {
  const p = localParts(date, tz)
  return zonedToDate(p.y, p.mo, p.d + addDays, 0, 0, tz)
}

/** "2026-09-28T10:15:00+03:00" — يُعطى للنموذج كمرجع للتاريخ الحالي */
export function isoLocal(date: Date, tz: string): string {
  const p = localParts(date, tz)
  const off = offsetMinutes(date, tz)
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const sign = off >= 0 ? '+' : '-'
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']

/** عرض مختصر للمالك: "بكرة 9:00ص" أو "الخميس 2/10 4:30م" */
export function formatWhen(date: Date, now: Date, tz: string): string {
  const p = localParts(date, tz)
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12
  const time = `${h12}:${String(p.mi).padStart(2, '0')}${p.h < 12 ? 'ص' : 'م'}`
  const dayDiff = Math.round(
    (startOfLocalDay(date, tz).getTime() - startOfLocalDay(now, tz).getTime()) / 86_400_000,
  )
  if (dayDiff === 0) return `اليوم ${time}`
  if (dayDiff === 1) return `بكرة ${time}`
  if (dayDiff === -1) return `أمس ${time}`
  return `${AR_DAYS[p.wd]} ${p.d}/${p.mo} ${time}`
}

/**
 * يقرأ تاريخاً أعاده النموذج:
 *  - ISO بمنطقة زمنية (Z أو +03:00) → كما هو
 *  - ISO بلا منطقة → يُفسَّر بتوقيت المالك (النماذج كثيراً ما تنسى الإزاحة)
 *  - تاريخ فقط → الساعة الافتراضية (9 الصبح) بتوقيت المالك
 * يرجع null للقيم غير المفهومة بدل اختراع وقت.
 */
export function parseWhen(raw: string | null | undefined, tz: string, defaultHour = 9): Date | null {
  if (!raw) return null
  const s = toLatinDigits(String(raw)).trim()
  if (!s) return null

  const withZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
  if (withZone.test(s)) {
    const d = new Date(s.replace(' ', 'T'))
    return isNaN(d.getTime()) ? null : d
  }
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s)
  if (!naive) return null
  const [, y, mo, d, h, mi] = naive
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
  if (h !== undefined && (+h > 23 || +mi > 59)) return null
  return zonedToDate(+y, +mo, +d, h !== undefined ? +h : defaultHour, h !== undefined ? +mi : 0, tz)
}

/** "الساعة 06:05" أو "بكرة الساعة 06:05" — لإشعار موعد الإرسال التقريبي */
export function formatClock(date: Date, now: Date, tz: string): string {
  const p = localParts(date, tz)
  const hhmm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  const dayDiff = Math.round((startOfLocalDay(date, tz).getTime() - startOfLocalDay(now, tz).getTime()) / 86_400_000)
  if (dayDiff === 0) return `الساعة ${hhmm}`
  if (dayDiff === 1) return `بكرة الساعة ${hhmm}`
  return formatWhen(date, now, tz)
}
