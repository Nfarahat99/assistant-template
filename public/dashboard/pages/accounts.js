// الحسابات: ربط واتساب عبر تسجيل رقم المساعد في الوسيط + بطاقات «قريباً» للبريد والتقويم.
// الحالات: A غير متاح · B النموذج · C مسح الرمز · D تم + إعادة تشغيل · E مربوط.
import { api } from '../api.js'
import { esc, icon, when, toast, confirmDialog, busy } from '../ui.js'

const QR_REFRESH_S = 20
const STATUS_POLL_MS = 3000
const START_HERE = 'docs/START-HERE.md'

// نفس قواعد src/lib/phone.ts (normalizeMsisdn) — مرآة في المتصفح
const AR_DIGITS = /[٠-٩]/g, FA_DIGITS = /[۰-۹]/g
export function normalizePhone(raw) {
  let d = String(raw || '').replace(AR_DIGITS, (c) => c.charCodeAt(0) - 0x0660).replace(FA_DIGITS, (c) => c.charCodeAt(0) - 0x06F0).replace(/[^0-9]/g, '')
  if (!d) return null
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = '966' + d.slice(1)
  else if (d.length === 9 && d.startsWith('5')) d = '966' + d
  return /^9665\d{8}$/.test(d) ? d : null
}
const local = (intl) => (intl && intl.startsWith('966') ? '0' + intl.slice(3) : intl || '')
export const maskPhone = (intl) => { const l = local(intl); return l.length > 6 ? `${l.slice(0, 3)}${'•'.repeat(l.length - 6)}${l.slice(-3)}` : l }

const MISSING = {
  no_gateway: ['رابط الوسيط', 'GATEWAY_URL', 'عنوان وسيط واتساب اللي يشغّل الأرقام.'],
  no_provision_key: ['مفتاح التسجيل', 'GATEWAY_PROVISION_KEY', 'مفتاح من صاحب الوسيط (اللي زوّدك بالقالب) يسمح للمساعد يسجّل رقمه بنفسه.'],
  no_secrets_key: ['مفتاح التشفير', 'SECRETS_KEY', 'يحفظ مفتاح رقم واتساب مشفّراً (64 حرفاً hex).'],
  no_public_url: ['رابط المساعد العام', 'PUBLIC_URL', 'على Railway يُضبط تلقائياً بعد «Generate Domain».'],
  no_webhook_secret: ['سر الاستقبال', 'WEBHOOK_SECRET', 'كلمة سر عشوائية 16 حرفاً أو أكثر يتحقق بها المساعد من رسائل الوسيط.'],
  env_assistant_phone: ['رقم المساعد مضبوط في الخادم', 'ASSISTANT_PHONE', 'احذف هالمتغير عشان تربط الرقم من هنا (الربط من اللوحة يحفظه بنفسه).'],
}
const STATUS = {
  connected: ['chip-ok', 'متصل'], qr: ['chip-info', 'بانتظار المسح'], connecting: ['chip-info', 'جارٍ الاتصال'],
  disconnected: ['', 'غير متصل'], logged_out: ['chip-warn', 'يحتاج ربط'], paused: ['chip-warn', 'متوقف مؤقتاً'],
  banned: ['chip-danger', 'محظور'], unreachable: ['chip-warn', 'الوسيط لا يستجيب'], unknown: ['', 'الحالة غير معروفة'],
}
const chip = ([cls, label], live) => `<span class="chip ${cls} ${live ? 'is-live' : ''}"><span class="dot"></span>${esc(label)}</span>`
const steps = (at) => `<ol class="acct-steps" aria-label="خطوات الربط">${['الأرقام', 'مسح الرمز', 'جاهز'].map((s, i) =>
  `<li class="${i < at ? 'is-done' : i === at ? 'is-current' : ''}" ${i === at ? 'aria-current="step"' : ''}><span>${i < at ? icon('check', 14) : i + 1}</span>${s}</li>`).join('')}</ol>`

export default async function accounts(root) {
  let timers = [], alive = true
  const later = (fn, ms) => { const t = setTimeout(() => alive && fn(), ms); timers.push(t); return t }
  const every = (fn, ms) => { const t = setInterval(() => alive && fn(), ms); timers.push(t); return t }
  const stop = () => { timers.forEach((t) => { clearTimeout(t); clearInterval(t) }); timers = [] }

  root.innerHTML = `
  <div class="page-head"><div class="grow"><h1>الحسابات</h1><p>اربط حسابات المساعد. واتساب الحين، والبريد والتقويم في المرحلة الجاية.</p></div></div>
  <div class="grid acct-grid">
    <section class="card acct-card" aria-labelledby="acc-wa" data-wa></section>
    <div class="grid acct-soon-list">
      ${soonCard('mail', 'البريد', 'يقرأ بريدك ويلخّص المهم ويجهّز ردود تعتمدها.')}
      ${soonCard('calendar', 'التقويم', 'يعرف مواعيدك ويذكّرك ويقترح أوقات فاضية.')}
    </div>
  </div>`
  const card = root.querySelector('[data-wa]')
  const head = (st) => `<div class="card-head">${icon('whatsapp')}<h2 id="acc-wa">واتساب</h2>${st || ''}</div>`

  async function load() {
    stop()
    let s
    try { s = await api('/wa/link') } catch (e) {
      card.innerHTML = `${head()}<div class="banner banner-danger" role="alert">${icon('alert')}<div><b>تعذّر جلب حالة الربط</b>${esc(e.message)}</div></div><button class="btn btn-sm" type="button" data-retry>${icon('refresh', 18)} إعادة المحاولة</button>`
      card.querySelector('[data-retry]').addEventListener('click', load)
      return
    }
    if (!alive) return
    if (s.linked && s.source === 'env') return showEnv(s)
    if (s.linked && s.locked) return showLocked(s)
    // يحتاج مسح رمز (حتى لو الربط مطبّق): انتهت المهلة، جوال غلط، أو غير متصل ← شاشة الرمز مع «رمز جديد»
    const needsScan = ['qr_timeout', 'phone_mismatch'].includes(s.disconnectReason) || ['qr', 'connecting', 'logged_out', 'disconnected'].includes(s.status)
    // متصل، أو مطبّق وحالته unknown/unreachable/error/banned ← بطاقة الربط (فيها الرسالة وزر «فك الربط»)
    // ربط معلّق (pending: ما اكتمل الاتصال بعد) ← شاشة الرمز؛ استطلاع الحالة فيها يكمل الربط ويعيد التشغيل
    if (s.linked && !s.pending && (s.status === 'connected' || (s.active && !needsScan))) return showLinked(s)
    if (s.linked) return showQr(s)
    if (!s.available) return showUnavailable(s)
    return showForm(s)
  }

  // ── A: غير متاح ──
  function showUnavailable(s) {
    const missing = s.missing || [s.reason]
    card.innerHTML = `${head(chip(['', 'غير متاح']))}
      <p class="muted acct-lead">ربط واتساب من هنا يحتاج تعديل في Railway ← Variables:</p>
      <ul class="acct-missing">${missing.map((r) => { const [t, v, d] = MISSING[r] || [r, r, '']; return `<li>${icon('alert', 18)}<div><b>${esc(t)}</b> <code class="mono ltr">${esc(v)}</code><span>${esc(d)}</span></div></li>` }).join('')}</ul>
      <div class="banner banner-info acct-help">${icon('file')}<div>الخطوات كاملة في دليل البداية — الخطوة ٦: <code class="mono ltr">${START_HERE}</code>. أو قل لـ Claude: «اقرأ onboarding/interview.md وجهّز إعدادات ربط واتساب».<br>بعد ما تضيفها أعد النشر وارجع لهالصفحة.</div></div>
      <p class="hint">تيليجرام يشتغل عادي بدون واتساب.</p>`
  }

  // ── B: النموذج ──
  function showForm(s) {
    card.innerHTML = `${head(chip(['', 'غير مربوط']))}${steps(0)}
      <form class="acct-form" novalidate>
        <div class="row-2">
          <div class="field"><label for="wa-asst">رقم المساعد <span class="req" aria-hidden="true">*</span></label>
            <input id="wa-asst" name="assistantPhone" type="tel" inputmode="tel" dir="ltr" autocomplete="off" placeholder="05xxxxxxxx" required aria-required="true" aria-describedby="wa-asst-h wa-asst-e">
            <p class="hint" id="wa-asst-h">رقم مخصص للمساعد على جوال ثاني — مو رقمك الأساسي.</p><p class="field-error" id="wa-asst-e"></p></div>
          <div class="field"><label for="wa-owner">رقمك <span class="req" aria-hidden="true">*</span></label>
            <input id="wa-owner" name="ownerPhone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="05xxxxxxxx" required aria-required="true" aria-describedby="wa-owner-h wa-owner-e" value="${esc(local(s.defaults?.ownerPhone || ''))}" ${s.ownerFromEnv ? 'readonly aria-readonly="true"' : ''}>
            <p class="hint" id="wa-owner-h">${s.ownerFromEnv ? `${icon('settings', 14)} من إعدادات الخادم (<span class="ltr">OWNER_PHONE</span>) — ما يتغيّر من هنا.` : 'المساعد يكلّمك أنت فقط على هالرقم.'}</p><p class="field-error" id="wa-owner-e"></p></div>
        </div>
        <div class="acct-risk" role="group" aria-labelledby="wa-risk-t">
          <div class="acct-risk-head">${icon('alert')}<b id="wa-risk-t">تحذير: احتمال حظر الرقم</b></div>
          <ul>
            <li>الوسيط <b>غير رسمي</b>، وواتساب ممكن يحظر الرقم في أي وقت.</li>
            <li>استخدم رقماً جديداً مخصصاً للمساعد. لا تربط رقمك الشخصي أو رقم شغلك.</li>
            <li>المساعد ما يرسل لأحد غيرك إلا بموافقتك، وتيليجرام يبقى احتياط لو انحظر الرقم.</li>
          </ul>
          <label class="acct-check"><input type="checkbox" name="acceptRisk" aria-describedby="wa-risk-e"><span>فاهم الخطر</span></label>
          <p class="field-error" id="wa-risk-e"></p>
        </div>
        <button class="btn btn-primary btn-block-sm" type="submit">${icon('qr', 18)} ابدأ الربط</button>
      </form>`
    const form = card.querySelector('form')
    const err = (id, msg, inp) => { card.querySelector(`#${id}`).textContent = msg || ''; inp?.setAttribute('aria-invalid', msg ? 'true' : 'false') }
    const checkPhone = (inp, id, label) => {
      if (!inp.value.trim()) { err(id, `${label} مطلوب.`, inp); return null }
      const n = normalizePhone(inp.value)
      err(id, n ? '' : 'رقم جوال سعودي غير صالح — مثال: 05xxxxxxxx', inp)
      return n
    }
    const A = form.elements.assistantPhone, O = form.elements.ownerPhone, R = form.elements.acceptRisk
    A.addEventListener('blur', () => A.value.trim() && checkPhone(A, 'wa-asst-e', 'رقم المساعد'))
    // رقم المالك من إعدادات الخادم (للقراءة فقط) — لا نتحقق منه هنا، الخادم يستخدمه كما هو
    const ownerLocked = O.readOnly
    O.addEventListener('blur', () => !ownerLocked && O.value.trim() && checkPhone(O, 'wa-owner-e', 'رقمك'))
    for (const [inp, id] of [[A, 'wa-asst-e'], [O, 'wa-owner-e']]) inp.addEventListener('input', () => err(id, '', inp))
    R.addEventListener('change', () => err('wa-risk-e', ''))
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const a = checkPhone(A, 'wa-asst-e', 'رقم المساعد'), o = ownerLocked ? (normalizePhone(O.value) || O.value.replace(/[^0-9]/g, '')) : checkPhone(O, 'wa-owner-e', 'رقمك')
      if (a && o && a === o) err('wa-asst-e', 'رقم المساعد لازم يختلف عن رقمك.', A)
      if (!R.checked) err('wa-risk-e', 'علّم «فاهم الخطر» عشان نكمل.')
      const bad = form.querySelector('[aria-invalid="true"]') || (!R.checked && R)
      if (bad) { bad.focus(); return }
      try {
        await busy(form.querySelector('[type=submit]'), () => api('/wa/link', { method: 'POST', body: { assistantPhone: a, ownerPhone: o, acceptRisk: true } }))
        toast('سجّلنا الرقم — امسح الرمز الحين')
        showQr({ assistantPhone: a, ownerPhone: o, status: 'connecting' })
      } catch (ex) {
        card.querySelector('[data-form-err]')?.remove()
        form.insertAdjacentHTML('afterbegin', `<div class="banner banner-danger" role="alert" data-form-err>${icon('alert')}<div><b>ما تم الربط</b>${esc(ex.message)}</div></div>`)
      }
    })
  }

  // ── C: مسح الرمز ──
  function showQr(s) {
    card.innerHTML = `${head(chip(STATUS[s.status] || STATUS.qr, true))}${steps(1)}
      <div class="acct-qr">
        <div class="acct-qr-code">
          <div class="qr-box" data-qr><div class="skel" style="width:80%;height:80%"></div></div>
          <div class="acct-countdown" data-cd-wrap><div class="meter"><i data-cd-bar></i></div><p class="small muted"><span data-cd>جارٍ تجهيز الرمز…</span></p></div>
        </div>
        <div class="acct-qr-help">
          <ol class="acct-howto">
            <li>افتح واتساب على <b>جوال المساعد</b> (<span class="ltr num">${esc(maskPhone(s.assistantPhone))}</span>).</li>
            <li>الإعدادات ← <b>الأجهزة المرتبطة</b> ← ربط جهاز.</li>
            <li>وجّه الكاميرا على الرمز. يتجدد تلقائياً كل ${QR_REFRESH_S} ثانية.</li>
          </ol>
          <div data-problem>${s.message ? `<div class="banner banner-warn" role="alert">${icon('alert')}<div>${esc(s.message)}</div></div>` : ''}</div>
          <p class="acct-status" data-status aria-live="polite">بانتظار المسح…</p>
          <div class="acct-actions">
            <button class="btn btn-sm" type="button" data-new-qr>${icon('refresh', 18)} رمز جديد</button>
            <button class="btn btn-sm btn-ghost" type="button" data-cancel>إلغاء الربط</button>
          </div>
        </div>
      </div>`
    const box = card.querySelector('[data-qr]'), cd = card.querySelector('[data-cd]'), bar = card.querySelector('[data-cd-bar]')
    const st = card.querySelector('[data-status]'), problem = card.querySelector('[data-problem]')
    let left = QR_REFRESH_S, done = false, fetching = false

    const paintCd = () => { cd.textContent = `يتجدد الرمز خلال ${left} ث`; bar.style.transform = `scaleX(${left / QR_REFRESH_S})` }
    async function fetchQr() {
      if (fetching) return
      fetching = true
      try {
        const q = await api('/wa/link/qr')
        if (!alive || done) return
        if (q.qr_png_base64) {
          const src = q.qr_png_base64.startsWith('data:') ? q.qr_png_base64 : `data:image/png;base64,${q.qr_png_base64}`
          box.innerHTML = `<img alt="رمز QR لربط واتساب المساعد" src="${esc(src)}" width="256" height="256">`
          left = QR_REFRESH_S; paintCd()
        } else { cd.textContent = 'جارٍ تجهيز الرمز…'; left = 4 }
      } catch (e) { cd.textContent = e.message; left = 6 } finally { fetching = false }
    }
    every(() => { if (done) return; left -= 1; if (left <= 0) fetchQr(); else paintCd() }, 1000)

    async function pollStatus() {
      if (done) return
      try {
        const r = await api('/wa/link/status')
        if (!alive || done) return
        const c = STATUS[r.status] || ['', r.status]
        card.querySelector('.card-head .chip')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: chip(c, r.status !== 'connected') }).content.firstElementChild)
        if (r.status === 'connected') { done = true; stop(); return showDone(s, r) }
        if (r.message) {
          problem.innerHTML = `<div class="banner banner-warn" role="alert">${icon('alert')}<div><b>${r.reason === 'phone_mismatch' ? 'الجوال غلط' : r.reason === 'qr_timeout' ? 'انتهت المهلة' : 'تنبيه'}</b>${esc(r.message)}</div></div>`
          st.textContent = 'اضغط «رمز جديد» وجرّب مرة ثانية.'
        } else {
          problem.innerHTML = ''
          st.textContent = r.status === 'connecting' ? 'جارٍ الاتصال بواتساب…' : 'بانتظار المسح…'
        }
      } catch (e) { st.textContent = e.message }
      later(pollStatus, STATUS_POLL_MS)
    }

    card.querySelector('[data-new-qr]').addEventListener('click', async (e) => {
      try {
        await busy(e.currentTarget, () => api('/wa/link/relink', { method: 'POST' }))
        problem.innerHTML = ''; st.textContent = 'طلبنا رمزاً جديداً…'
        box.innerHTML = '<div class="skel" style="width:80%;height:80%"></div>'
        left = 3; cd.textContent = 'جارٍ تجهيز الرمز…'
      } catch (ex) { toast(ex.message, 'error') }
    })
    card.querySelector('[data-cancel]').addEventListener('click', (e) => unlink(e.currentTarget, { pending: true }))
    fetchQr(); pollStatus()
  }

  // ── D: تم + إعادة تشغيل ──
  function showDone(s, r) {
    card.innerHTML = `${head(chip(STATUS.connected))}${steps(2)}
      <div class="acct-done" role="status">
        <span class="acct-done-mark">${icon('check', 40)}</span>
        <b>تم ربط واتساب</b>
        <p>أرسل لك المساعد رسالة ترحيب على <span class="ltr num">${esc(maskPhone(s.ownerPhone))}</span>.</p>
        ${r.restarting ? `<p class="acct-restart" data-restart><span class="acct-spin" aria-hidden="true"></span>المساعد يعيد تشغيل نفسه عشان يبدأ يستخدم واتساب — ثوانٍ وترجع الصفحة.</p>` : ''}
      </div>`
    if (!r.restarting) return later(load, 1500)
    // ننتظر رجوع الخادم بعد إعادة التشغيل ثم نعرض الحالة النهائية
    let tries = 0
    const wait = async () => {
      tries++
      try { const x = await api('/wa/link'); if (x.linked && (x.active || tries > 20)) { toast('واتساب شغّال ✅'); return load() } } catch { /* الخادم يعيد التشغيل */ }
      if (tries > 40) { const el = card.querySelector('[data-restart]'); if (el) el.innerHTML = 'طوّل شوي… حدّث الصفحة بعد دقيقة.'; return }
      later(wait, STATUS_POLL_MS)
    }
    later(wait, 4000)
  }

  // ── E: مربوط ──
  function showLinked(s) {
    card.innerHTML = `${head(chip(STATUS[s.status] || STATUS.connected))}
      <dl class="kv acct-kv">
        <dt>رقم المساعد</dt><dd><span class="ltr num">${esc(maskPhone(s.assistantPhone))}</span></dd>
        <dt>رقمك</dt><dd><span class="ltr num">${esc(maskPhone(s.ownerPhone))}</span></dd>
        <dt>تاريخ الربط</dt><dd>${when(s.linkedAt)}</dd>
      </dl>
      ${s.message ? `<div class="banner banner-warn" role="status">${icon('alert')}<div>${esc(s.message)}</div></div>` : ''}
      ${s.status === 'unknown' ? `<div class="banner banner-info" role="status">${icon('clock')}<div>الوسيط بطيء الحين وما قدرت أتأكد من الحالة — حدّث الصفحة بعد شوي.</div></div>` : ''}
      ${s.active === false ? `<div class="banner banner-info" role="status">${icon('refresh')}<div>الربط محفوظ، وبيشتغل بعد إعادة تشغيل المساعد.</div></div>` : ''}
      <div class="acct-danger">
        <div class="grow"><b>فك الربط</b><span>يحذف الرقم من الوسيط ويفك الجهاز من جوال المساعد. تيليجرام يبقى شغّال.</span></div>
        <button class="btn btn-sm acct-btn-danger" type="button" data-unlink>${icon('trash', 18)} فك الربط</button>
      </div>`
    card.querySelector('[data-unlink]').addEventListener('click', (e) => unlink(e.currentTarget))
  }
  function showEnv(s) {
    card.innerHTML = `${head(chip(['chip-ok', 'مربوط']))}
      <dl class="kv acct-kv"><dt>رقم المساعد</dt><dd><span class="ltr num">${esc(maskPhone(s.assistantPhone))}</span></dd><dt>رقمك</dt><dd><span class="ltr num">${esc(maskPhone(s.ownerPhone))}</span></dd></dl>
      <div class="banner banner-info">${icon('settings')}<div>واتساب مضبوط من متغيرات البيئة (<code class="mono ltr">GATEWAY_API_KEY</code>). للتغيير عدّلها في Railway ← Variables.</div></div>`
  }
  function showLocked(s) {
    card.innerHTML = `${head(chip(['chip-danger', 'يحتاج انتباه']))}
      <div class="banner banner-danger" role="alert">${icon('alert')}<div><b>ما قدرت أقرأ الربط المحفوظ</b>${esc(s.message || '')} رجّع قيمة <code class="mono ltr">SECRETS_KEY</code> القديمة، أو فك الربط واربط من جديد.</div></div>
      <div class="acct-danger"><div class="grow"><b>فك الربط</b><span>يحذف الرقم من الوسيط ويمسح الربط المحفوظ.</span></div>
        <button class="btn btn-sm acct-btn-danger" type="button" data-unlink>${icon('trash', 18)} فك الربط</button></div>`
    card.querySelector('[data-unlink]').addEventListener('click', (e) => unlink(e.currentTarget))
  }

  async function unlink(btn, { pending = false } = {}) {
    const ok = await confirmDialog(pending
      ? { title: 'إلغاء الربط؟', body: 'نحذف الرقم من الوسيط ونرجع لخطوة الأرقام.', confirm: 'إلغاء الربط', danger: true }
      : { title: 'فك ربط واتساب؟', body: 'المساعد يوقف واتساب ويحذف الرقم من الوسيط، ويعيد تشغيل نفسه. تقدر تربط من جديد بعدين.', confirm: 'فك الربط', danger: true })
    if (!ok) return
    try {
      const r = await busy(btn, () => api('/wa/link', { method: 'DELETE' }))
      stop()
      if (r.message) toast(r.message, 'error'); else toast('فكّينا الربط')
      if (r.restarting) {
        card.innerHTML = `${head()}<div class="acct-done" role="status"><span class="acct-spin" aria-hidden="true"></span><p>المساعد يعيد تشغيل نفسه…</p></div>`
        later(load, 6000)
      } else load()
    } catch (ex) { toast(ex.message, 'error') }
  }

  await load()
  return () => { alive = false; stop() }
}

function soonCard(ic, title, text) {
  return `<section class="card acct-soon" aria-disabled="true" aria-labelledby="soon-${ic}">
    <div class="card-head">${icon(ic)}<h2 id="soon-${ic}">${title}</h2><span class="chip">قريباً (المرحلة 3)</span></div>
    <p class="small muted">${text}</p></section>`
}
