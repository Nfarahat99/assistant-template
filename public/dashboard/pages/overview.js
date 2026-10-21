import { api } from '../api.js'
import { esc, icon, num, compact, usd, when, duration, toast, modalShell, skeleton } from '../ui.js'
import { areaChart, pairBars } from '../charts.js'

// Gemini free tier is rate-limited per day; backend may send usage.quota_calls to override.
const DEFAULT_DAILY_QUOTA = 250

const WA = {
  connected: ['chip-ok', 'متصل'], open: ['chip-ok', 'متصل'],
  paused: ['chip-warn', 'متوقف مؤقتاً'], connecting: ['chip-info', 'جارٍ الاتصال'], qr: ['chip-info', 'بانتظار المسح'],
  disconnected: ['', 'غير متصل'], closed: ['', 'غير متصل'], banned: ['chip-danger', 'محظور'],
  unreachable: ['chip-warn', 'الوسيط لا يستجيب'], logged_out: ['chip-warn', 'يحتاج إعادة ربط'], unknown: ['', 'غير معروف'],
}
const chip = ([cls, label], live) => `<span class="chip ${cls} ${live ? 'is-live' : ''}"><span class="dot"></span>${esc(label)}</span>`

export default async function overview(root) {
  const d = await api('/overview')
  const wa = d.channels?.whatsapp || {}, tg = d.channels?.telegram || {}
  const waState = wa.banned ? WA.banned : WA[wa.status] || ['', wa.status || 'غير معروف']
  const u = d.usage || {}, today = u.today || {}, month = u.month || {}
  const quota = u.quota_calls || DEFAULT_DAILY_QUOTA
  const pct = Math.min(100, Math.round(((today.llm_calls || 0) / quota) * 100))
  const t = d.tasks || {}, j = d.code_jobs || {}, m = d.messages || {}
  const direct = d.send_mode === 'direct'

  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>نظرة عامة</h1><p>حالة البوت والاستخدام والمهام بتوقيت الرياض.</p></div>
    <button class="btn btn-sm" type="button" data-refresh>${icon('refresh', 18)} تحديث</button>
  </div>
  ${wa.banned ? `<div class="banner banner-danger" role="status">${icon('alert')}<div><b>رقم واتساب محظور</b>${esc(wa.reason || 'تم حظر الرقم من واتساب.')} — تيليجرام هو القناة الأساسية الآن${wa.down_since ? ` · منذ ${when(wa.down_since)}` : ''}.</div></div>` : ''}

  <div class="grid grid-3">
    <section class="card" aria-labelledby="c-bot">
      <div class="card-head">${icon('bot')}<h2 id="c-bot">البوت</h2><span class="chip chip-ok"><span class="dot"></span>يعمل</span></div>
      <dl class="kv">
        <dt>الإصدار</dt><dd><span class="ltr num">${esc(d.bot?.version || '—')}</span></dd>
        <dt>الالتزام</dt><dd><span class="mono ltr">${esc((d.bot?.commit || '—').slice(0, 7))}</span></dd>
        <dt>تاريخ البناء</dt><dd>${when(d.bot?.built_at)}</dd>
        <dt>مدة التشغيل</dt><dd>${duration(d.bot?.uptime_s)}</dd>
      </dl>
    </section>

    <section class="card" aria-labelledby="c-ch">
      <div class="card-head">${icon('activity')}<h2 id="c-ch">القنوات</h2></div>
      <div class="setting"><span class="avatar" style="width:36px;height:36px">${icon('whatsapp', 18)}</span><div class="grow"><b>واتساب</b><span>${wa.banned || wa.status !== 'connected' ? (wa.down_since ? `متوقف ${when(wa.down_since)}` : esc(wa.reason || '')) : 'يستقبل ويرسل'}</span></div>${chip(waState)}</div>
      <div class="setting"><span class="avatar" style="width:36px;height:36px">${icon('telegram', 18)}</span><div class="grow"><b>تيليجرام</b><span>${tg.bound ? 'مربوط بحساب المالك' : 'لم يُربط بعد'}</span></div>${chip(tg.bound ? ['chip-ok', 'مربوط'] : ['chip-warn', 'غير مربوط'])}</div>
      <button class="btn btn-sm btn-block" type="button" data-relink style="margin-top:8px">${icon('qr', 18)} إعادة ربط واتساب</button>
    </section>

    <section class="card" aria-labelledby="c-send">
      <div class="card-head">${icon('send')}<h2 id="c-send">الرسائل</h2>${chip(direct ? ['chip-warn', 'إرسال مباشر'] : ['chip-ok', 'روابط wa.me'])}</div>
      <p class="small muted" style="margin-bottom:12px">${direct ? 'البوت يرسل الرسائل للآخرين مباشرة من رقمك.' : 'البوت يجهّز رابط wa.me وأنت ترسل بنفسك — الوضع الآمن.'}</p>
      <div class="grid grid-4" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat"><b>${num(m.in_today)}</b><span>واردة اليوم</span></div>
        <div class="stat"><b>${num(m.out_today)}</b><span>صادرة اليوم</span></div>
        <div class="stat"><b>${num(m.links_7d)}</b><span>روابط (7 أيام)</span></div>
      </div>
    </section>
  </div>

  <div class="section"><div class="section-head"><h2>الاستخدام</h2><span class="small muted">الشهر: ${num(month.llm_calls)} طلب · <span class="ltr">${usd(month.est_cost_usd)}</span></span></div>
    <div class="grid grid-2">
      <section class="card" aria-labelledby="c-today">
        <div class="card-head">${icon('cpu')}<h3 id="c-today">اليوم</h3></div>
        <div style="display:flex;align-items:baseline;gap:8px"><span class="kpi-value">${num(today.llm_calls)}</span><span class="muted small">طلب للنموذج من ~${num(quota)} يومياً</span></div>
        <div class="meter ${pct >= 90 ? 'is-danger' : pct >= 70 ? 'is-warn' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${quota}" aria-valuenow="${today.llm_calls || 0}" aria-label="استهلاك الحد اليومي التقديري" style="margin-top:8px"><i style="width:${pct}%"></i></div>
        <p class="hint" style="margin-top:6px">${pct}% من الحد التقديري للفئة المجانية في Gemini.</p>
        <div class="stat-row">
          <div class="stat"><b class="ltr">${compact(today.input_tokens)}</b><span>رموز داخلة</span></div>
          <div class="stat"><b class="ltr">${compact(today.output_tokens)}</b><span>رموز خارجة</span></div>
          <div class="stat"><b>${num(Math.round((today.audio_seconds || 0) / 60))}<small class="muted"> د</small></b><span>صوت مُفرَّغ</span></div>
          <div class="stat"><b class="ltr">${usd(today.est_cost_usd)}</b><span>تكلفة تقديرية</span></div>
        </div>
      </section>
      <section class="card" aria-labelledby="c-30">
        <div class="card-head">${icon('activity')}<h3 id="c-30">طلبات النموذج — آخر 30 يوماً</h3></div>
        <div data-usage-chart></div>
      </section>
    </div>
  </div>

  <div class="section"><div class="section-head"><h2>المهام</h2><a class="btn btn-sm btn-ghost" href="#/tasks">عرض الكل</a></div>
    <div class="grid grid-4">
      <a class="card kpi" href="#/tasks?status=open"><span class="kpi-label">مفتوحة</span><span class="kpi-value">${num(t.open)}</span></a>
      <a class="card kpi ${t.overdue ? 'is-danger' : ''}" href="#/tasks?status=overdue"><span class="kpi-label">${t.overdue ? icon('alert', 16) : ''}متأخرة</span><span class="kpi-value">${num(t.overdue)}</span></a>
      <a class="card kpi" href="#/tasks?status=done"><span class="kpi-label">أُنجزت هذا الأسبوع</span><span class="kpi-value">${num(t.done_7d)}</span></a>
      <div class="card kpi"><span class="kpi-label">أُنشئت هذا الأسبوع</span><span class="kpi-value">${num(t.created_7d)}</span></div>
    </div>
    <section class="card" style="margin-top:12px" aria-labelledby="c-14"><div class="card-head">${icon('tasks')}<h3 id="c-14">المُنشأة مقابل المُنجزة — 14 يوماً</h3></div><div data-task-chart></div></section>
  </div>

  <div class="section"><div class="section-head"><h2>طلبات الكود</h2><a class="btn btn-sm btn-ghost" href="#/jobs">عرض الكل</a></div>
    <div class="grid grid-4">
      <a class="card kpi" href="#/jobs"><span class="kpi-label">قيد التنفيذ</span><span class="kpi-value">${num(j.running)}</span></a>
      <a class="card kpi ${j.awaiting_merge ? 'is-warn' : ''}" href="#/jobs"><span class="kpi-label">بانتظار موافقتك</span><span class="kpi-value">${num(j.awaiting_merge)}</span></a>
      <div class="card kpi"><span class="kpi-label">مدموجة (30 يوماً)</span><span class="kpi-value">${num(j.merged_30d)}</span></div>
      <div class="card kpi ${j.failed_30d ? 'is-danger' : ''}"><span class="kpi-label">فاشلة (30 يوماً)</span><span class="kpi-value">${num(j.failed_30d)}</span></div>
    </div>
  </div>`

  const daily = u.daily || []
  root.querySelector('[data-usage-chart]').append(areaChart({
    data: daily, key: 'llm_calls', unit: 'طلب', label: 'طلبات النموذج اليومية',
    summary: daily.length ? `إجمالي ${daily.reduce((s, x) => s + (x.llm_calls || 0), 0)} طلب` : '',
    describe: (x) => `<span class="ltr">${compact(x.input_tokens)} / ${compact(x.output_tokens)}</span> رمز`,
  }))
  root.querySelector('[data-task-chart]').append(pairBars({ data: (t.daily || []).slice(-14), a: 'created', b: 'done', labelA: 'أُنشئت', labelB: 'أُنجزت', label: 'المهام اليومية' }))

  root.querySelector('[data-refresh]').addEventListener('click', () => { root.innerHTML = skeleton(); overview(root).catch((e) => toast(e.message, 'error')) })
  root.querySelector('[data-relink]').addEventListener('click', () => relinkDialog(wa))
}

function relinkDialog(wa) {
  const d = modalShell('إعادة ربط واتساب', `
    ${wa.banned ? `<div class="banner banner-warn">${icon('alert')}<div>الرقم محظور حالياً؛ غالباً لن ينجح الربط حتى يُرفع الحظر.</div></div>` : ''}
    <p>افتح واتساب على الهاتف ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز.</p>
    <div class="qr-box" data-qr><div class="skel" style="width:80%;height:80%"></div></div>
    <p class="small muted" data-qr-status style="text-align:center" aria-live="polite">جارٍ طلب رمز جديد…</p>`,
  `<button type="button" class="btn" data-close>إغلاق</button>`)
  const box = d.querySelector('[data-qr]'), st = d.querySelector('[data-qr-status]')
  let timer = null, alive = true
  d.addEventListener('close', () => { alive = false; clearTimeout(timer) })
  const poll = async () => {
    if (!alive) return
    try {
      const q = await api('/wa/qr')
      if (!alive) return
      if (q.status === 'connected' || q.status === 'open') {
        box.innerHTML = `<span style="color:var(--accent)">${icon('check', 64)}</span>`
        st.textContent = 'تم الربط بنجاح.'; toast('تم ربط واتساب'); return
      }
      if (q.qr_png_base64) {
        const src = q.qr_png_base64.startsWith('data:') ? q.qr_png_base64 : `data:image/png;base64,${q.qr_png_base64}`
        box.innerHTML = `<img alt="رمز QR لربط واتساب" src="${esc(src)}" width="256" height="256">`
        st.textContent = 'بانتظار المسح… يتجدد الرمز تلقائياً.'
      } else st.textContent = 'جارٍ تجهيز الرمز…'
    } catch (e) { st.textContent = e.message }
    timer = setTimeout(poll, 3000)
  }
  d.showModal()
  api('/wa/relink', { method: 'POST' }).then(poll, (e) => { st.textContent = e.message; box.innerHTML = icon('alert', 40) })
}
