/** أرقام عربية-هندية وفارسية → لاتينية */
export function toLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
}

/** تطبيع الجوال للصيغة الدولية (9665...) — نفس منطق الوسيط */
export function normalizeMsisdn(raw: string | null | undefined, cc = '966'): string | null {
  if (!raw) return null
  let d = toLatinDigits(String(raw)).replace(/[^0-9]/g, '')
  if (!d) return null
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = cc + d.slice(1)
  else if (d.length === 9 && d.startsWith('5') && cc === '966') d = cc + d
  if (d.length < 8 || d.length > 15) return null
  return d
}

/** للعرض: 966500003456 → 0500003456 */
export function displayPhone(intl: string, cc = '966'): string {
  return intl.startsWith(cc) ? '0' + intl.slice(cc.length) : '+' + intl
}

/** لاتينية → عربية-هندية (للعرض في الجمل العربية) */
export function toArabicDigits(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + +d))
}
