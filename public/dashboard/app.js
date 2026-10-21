// Shell: hash router, navigation, theme, auth.
import { api, isMock } from './api.js'
import { $, $$, icon, errorState, skeleton, confirmDialog, busy, leaveGuard } from './ui.js'

// اسم المساعد يحقنه الخادم في <meta name="assistant-name"> (من الملف الشخصي)
const ASSISTANT = (() => { const v = document.querySelector('meta[name="assistant-name"]')?.content || ''; return v.startsWith('{{') ? '' : v })()

const ROUTES = {
  overview: { title: 'نظرة عامة', icon: 'overview', mod: () => import('./pages/overview.js') },
  tasks: { title: 'المهام', icon: 'tasks', mod: () => import('./pages/tasks.js') },
  jobs: { title: 'طلبات الكود', short: 'الكود', icon: 'pr', mod: () => import('./pages/jobs.js') },
  conversations: { title: 'المحادثات', icon: 'chat', mod: () => import('./pages/conversations.js') },
  contacts: { title: 'جهات الاتصال', icon: 'users', mod: () => import('./pages/contacts.js') },
  projects: { title: 'المشاريع', icon: 'folder', mod: () => import('./pages/projects.js') },
  accounts: { title: 'الحسابات', icon: 'link', mod: () => import('./pages/accounts.js') },
  settings: { title: 'الإعدادات والمزايا', short: 'الإعدادات', icon: 'settings', mod: () => import('./pages/settings.js') },
}
const BOTTOM = ['overview', 'tasks', 'jobs', 'conversations']
const MORE = ['contacts', 'projects', 'accounts', 'settings']

// ---------- Theme ----------
const THEMES = { auto: ['تلقائي', 'auto'], light: ['فاتح', 'sun'], dark: ['داكن', 'moon'] }
const getTheme = () => document.documentElement.dataset.theme || 'auto'
function setTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try { t === 'auto' ? localStorage.removeItem('dash-theme') : localStorage.setItem('dash-theme', t) } catch { /* private mode */ }
  paintThemeButtons()
}
function paintThemeButtons() {
  const [label, ic] = THEMES[getTheme()]
  $$('[data-action="theme"]').forEach((b) => {
    const full = `المظهر: ${label}`
    b.innerHTML = b.classList.contains('icon-btn') ? icon(ic) : `${icon(ic)}<span>${full}</span>`
    b.setAttribute('aria-label', `${full} — اضغط للتبديل`)
  })
}

// ---------- Navigation ----------
const link = (k, cls = 'nav-link') => `<a class="${cls}" href="#/${k}" data-route="${k}">${icon(ROUTES[k].icon)}<span>${ROUTES[k].title}</span></a>`
function buildNav() {
  $('#side-nav').innerHTML = Object.keys(ROUTES).map((k) => `<li>${link(k)}</li>`).join('')
  $('#bottom-nav').innerHTML = BOTTOM.map((k) => `<li><a href="#/${k}" data-route="${k}">${icon(ROUTES[k].icon, 22)}<span>${ROUTES[k].short || ROUTES[k].title}</span></a></li>`).join('') +
    `<li><button type="button" id="more-btn" aria-haspopup="dialog">${icon('more', 22)}<span>المزيد</span></button></li>`
  $('#more-list').innerHTML = MORE.map((k) => `<li>${link(k)}</li>`).join('') +
    `<li><hr></li><li><button class="nav-link" type="button" data-action="theme"></button></li><li><button class="nav-link nav-danger" type="button" data-action="logout">${icon('logout')}<span>تسجيل الخروج</span></button></li>`
  $$('.side-foot [data-action="logout"]').forEach((b) => { b.innerHTML = `${icon('logout')}<span>تسجيل الخروج</span>` })
  $('#more-sheet [data-close]').innerHTML = icon('x')
  paintThemeButtons()
}
function markNav(name) {
  $$('[data-route]').forEach((a) => (a.dataset.route === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
  $('#more-btn')?.classList.toggle('is-active', MORE.includes(name))
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action], #more-btn, #more-sheet a, #more-sheet [data-close]')
  if (!t) return
  const sheet = $('#more-sheet')
  if (t.id === 'more-btn') return sheet.showModal()
  if (t.matches('#more-sheet a, #more-sheet [data-close]')) return sheet.close()
  if (t.dataset.action === 'theme') { const order = ['auto', 'light', 'dark']; setTheme(order[(order.indexOf(getTheme()) + 1) % 3]) }
  if (t.dataset.action === 'logout') {
    sheet.close()
    try { await api('/logout', { method: 'POST' }) } catch { /* ignore */ }
    showLogin()
  }
})
$('#more-sheet').addEventListener('click', (e) => { if (e.target.id === 'more-sheet') e.target.close() })

// ---------- Router ----------
let seq = 0, cleanup = null, lastHash = location.hash, restoring = false, firstRender = true
function parse() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\?(.*))?$/)
  return { name: m && ROUTES[m[1]] ? m[1] : 'overview', params: new URLSearchParams(m?.[2] || '') }
}
async function render() {
  const { name, params } = parse()
  const token = ++seq
  try { cleanup?.() } catch { /* ignore */ }
  cleanup = null; leaveGuard.check = null
  document.querySelectorAll('dialog[open]').forEach((d) => d.close())
  const r = ROUTES[name]
  document.title = ASSISTANT ? `${r.title} · مساعد ${ASSISTANT}` : r.title
  markNav(name)
  const main = $('#main'), view = document.createElement('div')
  view.innerHTML = skeleton()
  main.replaceChildren(view)
  if (!firstRender) { main.focus({ preventScroll: true }); window.scrollTo(0, 0) }
  firstRender = false
  try {
    const mod = await r.mod()
    if (token !== seq) return
    view.innerHTML = ''
    const c = await mod.default(view, { params, title: r.title })
    if (token === seq) cleanup = typeof c === 'function' ? c : null
    else if (typeof c === 'function') c()
  } catch (err) {
    if (token !== seq || err.status === 401) return
    console.error(err)
    view.replaceChildren(errorState(err, render))
  }
}
window.addEventListener('hashchange', async () => {
  if (restoring) { restoring = false; return }
  if (leaveGuard.check?.()) {
    const ok = await confirmDialog({ title: 'تغييرات غير محفوظة', body: 'لديك تعديلات لم تُحفظ بعد. هل تريد المغادرة وتجاهلها؟', confirm: 'مغادرة دون حفظ', danger: true })
    if (!ok) { restoring = true; location.hash = lastHash; return }
  }
  lastHash = location.hash
  render()
})
export const rerender = render

// ---------- Auth ----------
function showLogin() {
  seq++; leaveGuard.check = null
  $('#app').hidden = true; $('#login').hidden = false
  $('#login-pass').value = ''; $('#login-err').textContent = ''
  setTimeout(() => $('#login-pass').focus(), 30)
}
function showApp() {
  $('#login').hidden = true; $('#app').hidden = false
  render()
}
window.addEventListener('auth:required', showLogin)

function initLogin() {
  const pass = $('#login-pass'), tog = $('#login-toggle'), err = $('#login-err')
  const paintTog = () => { const shown = pass.type === 'text'; tog.innerHTML = icon(shown ? 'eyeOff' : 'eye'); tog.setAttribute('aria-pressed', String(shown)); tog.setAttribute('aria-label', shown ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور') }
  tog.addEventListener('click', () => { pass.type = pass.type === 'password' ? 'text' : 'password'; paintTog(); pass.focus() })
  paintTog()
  pass.addEventListener('input', () => { err.textContent = ''; pass.removeAttribute('aria-invalid') })
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!pass.value) { err.textContent = 'أدخل كلمة المرور.'; pass.setAttribute('aria-invalid', 'true'); pass.focus(); return }
    try {
      await busy($('#login-submit'), () => api('/login', { method: 'POST', body: { password: pass.value } }))
      showApp()
    } catch (ex) {
      err.textContent = ex.status === 401 || ex.status === 403 ? 'كلمة المرور غير صحيحة.' : ex.status === 429 ? 'محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة.' : ex.message
      pass.setAttribute('aria-invalid', 'true'); pass.select()
    }
  })
}

// ---------- Boot ----------
buildNav()
initLogin()
if (isMock) $('#mock-pill').hidden = false
if (!location.hash) history.replaceState(null, '', '#/overview')
lastHash = location.hash
showApp() // first API call returns 401 if there is no session → login screen
