// Shared UI helpers: escaping, icons, formatting (Asia/Riyadh), dialogs, toasts, states.
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }

// ---- Icons (Lucide paths, 1.75 stroke) ----
const P = {
  overview: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  tasks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  settings: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  auto: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"/>',
  telegram: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8c-.9-.4-1.5-1-1.8-1.8l.8-1-1-2Z"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  offline: '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
}
export function icon(name, size = 20, label) {
  const a = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a}>${P[name] || ''}</svg>`
}

// ---- Formatting (Latin digits, Riyadh time) ----
const TZ = 'Asia/Riyadh'
const nf = new Intl.NumberFormat('en-US')
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const absF = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const shortF = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const dayF = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const dateOnlyF = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { timeZone: 'UTC', day: 'numeric', month: 'short' })
const rtf = new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'auto' })
export const num = (n) => (n == null || isNaN(n) ? '—' : nf.format(n))
export const compact = (n) => (n == null || isNaN(n) ? '—' : nfc.format(n))
export const usd = (n) => (n == null || isNaN(n) ? '—' : '$' + (n < 10 ? n.toFixed(2) : nf.format(Math.round(n))))
export const absDate = (iso) => absF.format(new Date(iso))
export const shortDate = (iso) => shortF.format(new Date(iso))
export const dayLabel = (iso) => dayF.format(new Date(iso))
export const ymdLabel = (ymd) => dateOnlyF.format(new Date(ymd + 'T00:00:00Z'))
export const riyadhDay = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10)
export function rel(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000, a = Math.abs(s)
  if (a < 45) return 'الآن'
  const [v, u] = a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour'] : a < 86400 * 30 ? [s / 86400, 'day'] : a < 86400 * 365 ? [s / 2592000, 'month'] : [s / 31536000, 'year']
  return rtf.format(Math.round(v), u)
}
/** <time> with relative text; tap/click toggles absolute (title tooltips don't work on phones). */
export function when(iso, empty = '—') {
  if (!iso || isNaN(Date.parse(iso))) return `<span class="muted">${empty}</span>`
  return `<time datetime="${esc(iso)}" title="${esc(absDate(iso))}" data-rel="${esc(rel(iso))}" data-abs="${esc(shortDate(iso))}">${esc(rel(iso))}</time>`
}
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('time[data-abs]'); if (!t) return
  t.textContent = t.textContent === t.dataset.abs ? t.dataset.rel : t.dataset.abs
})
export function duration(sec) {
  sec = Math.max(0, Math.floor(sec || 0))
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} يوم${hh ? ` و${hh} ساعة` : ''}`
  if (hh) return `${hh} ساعة${m ? ` و${m} دقيقة` : ''}`
  return `${m} دقيقة`
}
// Riyadh is UTC+3 with no DST, so a fixed offset is exact.
export const toRiyadhInput = (iso) => (iso ? new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 16) : '')
export const fromRiyadhInput = (v) => (v ? new Date(v + ':00+03:00').toISOString() : null)
export const initial = (name) => (String(name || '؟').trim().replace(/^(ال|أبو |ابو |أم |م\. |د\. )/, '')[0] || '؟')

// ---- Toasts ----
export function toast(msg, type = 'ok', action) {
  const el = h(`<div class="toast ${type === 'error' ? 'error' : ''}" role="${type === 'error' ? 'alert' : 'status'}">${icon(type === 'error' ? 'alert' : 'check', 18)}<span>${esc(msg)}</span></div>`)
  const leave = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 180) }
  if (action) {
    const b = h(`<button type="button" class="btn btn-sm btn-ghost toast-action">${esc(action.label)}</button>`)
    b.addEventListener('click', () => { leave(); action.fn() }); el.append(b)
  }
  $('#toasts').append(el)
  setTimeout(leave, type === 'error' || action ? 6000 : 3500)
}

// ---- Dialogs ----
function modalShell(title, bodyHtml, footHtml, { wide } = {}) {
  const d = h(`<dialog class="modal" aria-labelledby="dlg-t"><form method="dialog" novalidate>
    <div class="modal-head"><h2 id="dlg-t">${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="إغلاق">${icon('x')}</button></div>
    <div class="modal-body">${bodyHtml}</div><div class="modal-foot">${footHtml}</div></form></dialog>`)
  if (wide) d.style.width = 'min(720px, calc(100% - 24px))'
  document.body.append(d)
  d.addEventListener('close', () => setTimeout(() => d.remove(), 50))
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close() })
  return d
}
export function confirmDialog({ title, body = '', confirm = 'تأكيد', danger = false }) {
  return new Promise((resolve) => {
    const d = modalShell(title, `<p>${body}</p>`, `<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" data-ok>${esc(confirm)}</button><button type="button" class="btn" data-close>إلغاء</button>`)
    let ok = false
    d.querySelector('[data-ok]').addEventListener('click', () => { ok = true })
    d.addEventListener('close', () => resolve(ok))
    d.showModal(); d.querySelector('[data-ok]').focus()
  })
}
/**
 * Generic form dialog. fields: [{name,label,type,required,hint,placeholder,options,dir,rows,half}]
 * onSubmit(values) may throw {message, field} to show an inline error; resolves when saved.
 */
export function formDialog({ title, fields, values = {}, submit = 'حفظ', onSubmit, validate }) {
  const fieldHtml = (f) => {
    const id = 'f-' + f.name, v = values[f.name] ?? ''
    const common = `id="${id}" name="${f.name}" ${f.required ? 'required aria-required="true"' : ''} ${f.dir ? `dir="${f.dir}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} aria-describedby="${id}-h ${id}-e" ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}`
    let input
    if (f.type === 'textarea') input = `<textarea ${common} rows="${f.rows || 3}">${esc(v)}</textarea>`
    else if (f.type === 'select') input = `<select ${common}>${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`
    else input = `<input ${common} type="${f.type || 'text'}" value="${esc(v)}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`
    return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${input}${f.hint ? `<p class="hint" id="${id}-h">${f.hint}</p>` : ''}<p class="field-error" id="${id}-e"></p></div>`
  }
  const rows = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.half && fields[i + 1]?.half) { rows.push(`<div class="row-2">${fieldHtml(f)}${fieldHtml(fields[i + 1])}</div>`); i++ }
    else rows.push(fieldHtml(f))
  }
  return new Promise((resolve) => {
    const d = modalShell(title, rows.join(''), `<button class="btn btn-primary" type="submit" data-ok>${esc(submit)}</button><button type="button" class="btn" data-close>إلغاء</button>`)
    const form = d.querySelector('form'), btn = d.querySelector('[data-ok]')
    let result = null
    const setErr = (name, msg) => { const inp = form.elements[name]; if (!inp) return; inp.setAttribute('aria-invalid', msg ? 'true' : 'false'); d.querySelector(`#f-${name}-e`).textContent = msg || '' }
    form.addEventListener('input', (e) => { if (e.target.name) setErr(e.target.name, '') })
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const vals = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value.trim()]))
      let first = null
      for (const f of fields) {
        let msg = f.required && !vals[f.name] ? `${f.label} مطلوب.` : ''
        if (!msg && validate) msg = validate(f.name, vals[f.name], vals) || ''
        setErr(f.name, msg); if (msg && !first) first = f.name
      }
      if (first) { form.elements[first].focus(); return }
      btn.setAttribute('aria-busy', 'true'); btn.disabled = true
      try { result = (await onSubmit(vals)) ?? true; d.close() } catch (err) {
        if (err.field) { setErr(err.field, err.message); form.elements[err.field]?.focus() } else toast(err.message || 'تعذّر الحفظ', 'error')
      } finally { btn.removeAttribute('aria-busy'); btn.disabled = false }
    })
    d.addEventListener('close', () => resolve(result))
    d.showModal(); form.elements[fields[0].name].focus()
  })
}
export { modalShell }

// ---- States ----
export const skeleton = (heights = [96, 96, 220]) => `<div class="grid" aria-busy="true" aria-label="جارٍ التحميل">${heights.map((x) => `<div class="skel" style="height:${x}px"></div>`).join('')}</div>`
export const emptyState = (ic, title, text = '', action = '') => `<div class="state">${icon(ic, 32)}<b>${esc(title)}</b>${text ? `<p>${text}</p>` : ''}${action}</div>`
export function errorState(err, retry) {
  const offline = err?.status === 0
  const el = h(`<div class="state state-error" role="alert">${icon(offline ? 'offline' : 'alert', 32)}<b>${offline ? 'لا يوجد اتصال' : 'تعذّر تحميل البيانات'}</b><p>${esc(err?.message || 'حدث خطأ غير متوقع.')}</p><button class="btn" type="button">${icon('refresh', 18)} إعادة المحاولة</button></div>`)
  el.querySelector('button').addEventListener('click', retry)
  return el
}
export async function busy(btn, fn) {
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true
  try { return await fn() } finally { btn.removeAttribute('aria-busy'); btn.disabled = false }
}
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

/** Pages set `leaveGuard.check = () => hasUnsavedChanges` ; the router asks before leaving. */
export const leaveGuard = { check: null }
window.addEventListener('beforeunload', (e) => { if (leaveGuard.check?.()) { e.preventDefault(); e.returnValue = '' } })
