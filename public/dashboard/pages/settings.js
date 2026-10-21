import { api } from '../api.js'
import { icon, esc, when, toast, confirmDialog, busy, leaveGuard, num } from '../ui.js'

const FEATURES = [
  ['voice', 'الرسائل الصوتية', 'تفريغ الرسائل الصوتية وفهمها كأي رسالة نصية.'],
  ['reminders', 'التذكيرات', 'إرسال تنبيه عند حلول وقت تذكير المهمة.'],
  ['briefs', 'الملخّص الصباحي والمسائي', 'ملخّص يومي بالمهام والمواعيد، ومراجعة في المساء.'],
  ['youtube', 'تلخيص يوتيوب', 'تلخيص أي رابط يوتيوب ترسله.'],
  ['third_party_replies', 'ملخّص ردود الآخرين', 'تلخيص ما يرد به الأشخاص على رسائلك وإبلاغك.'],
  ['code_changes', 'تعديلات الكود', 'تشغيل Claude Code على مشاريعك وفتح طلبات دمج بموافقتك.'],
  ['web_research', 'البحث في الويب', 'البحث والمقارنات التقنية عند طلبك.'],
  ['ai_news_digest', 'نشرة أخبار الذكاء الاصطناعي', 'ملخّص يومي لأهم أخبار الذكاء الاصطناعي.'],
  ['db_access', 'قواعد بيانات المشاريع', 'قراءة بيانات مشاريعك، والتعديل فقط بعد معاينة وموافقتك.'],
  ['project_status_daily', 'موجز المشاريع اليومي', 'أهم الخطوات الناقصة في مشاريعك (دومين، إطلاق، تسويق…)، والأحد ملخّص أسبوعي.'],
  ['quran_wird', 'تذكيرات الورد القرآني', 'عدة تذكيرات يومياً بأوقات عشوائية متفرقة (٣ افتراضياً بين ٨ص و٩م).'],
  ['weekly_insights', 'تقرير الإنتاجية الأسبوعي', 'كل جمعة: تحليل طلباتك ونشاطك ونصائح لترتيب الأولويات.'],
]
// النماذج لكل دور — التسميات كما تظهر للمالك
const ROLE_UI = {
  understand: ['فهم الرسائل', 'chat'],
  general: ['المهام العامة والملخصات', 'bot'],
  voice: ['الصوتيات', 'mic'],
  vision: ['قراءة الصور', 'eye'],
  video: ['فيديوهات يوتيوب', 'external'],
  research: ['البحث في الإنترنت', 'search'],
}
const NEED_AR = { text: 'نص', audio: 'صوت', vision: 'صور', video: 'فيديو', search: 'بحث في الويب' }
const PROVIDER_AR = { gemini: 'Gemini', anthropic: 'Claude (Anthropic)', groq: 'Groq', nvidia: 'NVIDIA', openai: 'OpenAI' }
// اقتراحات النماذج لكل مزوّد (datalist) — الأول هو الافتراضي عند تبديل المزوّد
const SUGGEST = {
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  groq: ['openai/gpt-oss-120b'],
  nvidia: ['nvidia/nemotron-3-super-120b-a12b'],
  openai: [],
}
const MODEL_RE = /^[A-Za-z0-9._/:-]{3,80}$/
const clone = (o) => JSON.parse(JSON.stringify(o))
/** شكل الدور كما يُرسل للخادم: نصوص مقصوصة، والاحتياطي يُحذف إن لم يُختر مزوّد */
const normRole = (m) => {
  const out = { provider: m.provider, model: String(m.model ?? '').trim() }
  if (m.fallback?.provider) out.fallback = { provider: m.fallback.provider, model: String(m.fallback.model ?? '').trim() }
  return out
}
const sameRole = (a, b) => JSON.stringify(normRole(a || {})) === JSON.stringify(normRole(b || {}))

function modelsSection(meta) {
  const providersFor = (role) => meta.providers.filter((p) => (meta.caps[p] || []).includes(meta.needs[role]))
  const opts = (role) => providersFor(role).map((p) => `<option value="${esc(p)}">${esc(PROVIDER_AR[p] || p)}</option>`).join('')
  const roles = meta.roles.filter((r) => ROLE_UI[r])
  return `
  <section class="section" aria-labelledby="s-m">
    <div class="section-head">${icon('cpu')}<h2 id="s-m">النماذج</h2></div>
    <p class="small muted models-intro">اختر المزوّد والنموذج لكل مهمة. يُستخدم الاحتياطي تلقائياً عند فشل الأساسي أو غياب مفتاحه. المفاتيح تُضبط في متغيرات البيئة على الخادم.</p>
    ${Object.entries(SUGGEST).map(([p, list]) => `<datalist id="models-${p}">${list.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>`).join('')}
    <div class="grid grid-2 models-grid">${roles.map((r) => {
      const [label, ic] = ROLE_UI[r]
      return `<div class="card model-role" data-role="${r}" role="group" aria-labelledby="mr-${r}">
        <div class="card-head">${icon(ic)}<h3 id="mr-${r}">${label}</h3><span class="chip" data-badge="${r}" aria-live="polite" hidden></span></div>
        <p class="hint model-need">يحتاج قدرة: ${esc(NEED_AR[meta.needs[r]] || meta.needs[r])} — تظهر فقط المزوّدات الداعمة لها.</p>
        <div class="row-2">
          <div class="field"><label for="mp-${r}">المزوّد</label><select id="mp-${r}" data-m="${r}.provider">${opts(r)}</select></div>
          <div class="field"><label for="mm-${r}">النموذج</label><input id="mm-${r}" data-m="${r}.model" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="me-${r}"></div>
        </div>
        <div class="row-2 model-fb">
          <div class="field"><label for="fp-${r}">المزوّد الاحتياطي</label><select id="fp-${r}" data-m="${r}.fbProvider"><option value="">بلا احتياطي</option>${opts(r)}</select></div>
          <div class="field"><label for="fm-${r}">النموذج الاحتياطي</label><input id="fm-${r}" data-m="${r}.fbModel" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="me-${r}"></div>
        </div>
        <p class="field-error" id="me-${r}" data-merr="${r}" role="alert"></p>
      </div>`
    }).join('')}</div>
  </section>`
}

/** شارة المفتاح للدور حسب المسودة: المفاتيح المعروفة تأتي من status (آخر حالة محفوظة) */
function keyBadge(m, keys) {
  const p = keys[m.provider]
  const f = m.fallback?.provider ? keys[m.fallback.provider] : false
  if (p === true) return ['chip-ok', 'المفتاح موجود']
  if (p === undefined) return ['', 'يُفحص المفتاح بعد الحفظ']
  if (f === true) return ['chip-warn', 'المفتاح ناقص — يستخدم الاحتياطي']
  if (f === undefined) return ['', 'يُفحص الاحتياطي بعد الحفظ']
  return ['chip-danger', 'لا يوجد مفتاح']
}
function keysFrom(status) {
  const keys = {}
  for (const st of status || []) {
    keys[st.provider] = !!st.hasKey
    if (st.fallbackProvider) keys[st.fallbackProvider] = !!st.fallbackHasKey
  }
  return keys
}

export default async function settings(root) {
  const [s, knData, meta0] = await Promise.all([api('/settings'), api('/knowledge'), api('/models').catch(() => null)])
  // قسم النماذج يظهر فقط إن دعمه الخادم (GET /models) وكانت الإعدادات تحمل models
  const meta = meta0 && s.models ? meta0 : null
  let keys = keysFrom(meta?.status)
  const modelErrors = {}
  let orig = { ...clone(s), features: { ...(s.features || {}) } }, draft = clone(orig)
  // textarea يوحّد نهايات الأسطر إلى \n — نوحّد الأصل كذلك وإلا ظهرت «تعديلات غير محفوظة» زائفة مع CRLF
  let knOrig = String(knData?.markdown || '').replace(/\r\n?/g, '\n'), knUpdated = knData?.updated_at

  root.innerHTML = `
  <div class="page-head"><div class="grow"><h1>الإعدادات والمزايا</h1><p>تُطبَّق التغييرات على البوت فور الحفظ.</p></div></div>
  <div class="grid grid-2" style="align-items:start">
    <section class="card" aria-labelledby="s-f">
      <div class="card-head"><h2 id="s-f">المزايا</h2></div>
      <div>${FEATURES.map(([k, t, d]) => `<div class="setting"><div class="grow"><b id="lf-${k}">${t}</b><span id="df-${k}">${d}</span></div>
        <button type="button" class="switch" role="switch" data-feature="${k}" aria-labelledby="lf-${k}" aria-describedby="df-${k}"></button></div>`).join('')}</div>
    </section>
    <div class="grid">
      <section class="card" aria-labelledby="s-b">
        <div class="card-head"><h2 id="s-b">مواعيد الملخّصات</h2><span class="small muted">توقيت الرياض</span></div>
        <div class="row-2">
          <div class="field"><label for="s-morning">الملخّص الصباحي</label><input id="s-morning" type="time" data-k="morning_brief_at" dir="ltr"></div>
          <div class="field"><label for="s-evening">المراجعة المسائية</label><input id="s-evening" type="time" data-k="evening_review_at" dir="ltr"></div>
        </div>
        <div class="field" style="margin-top:12px"><label for="s-proj">موجز المشاريع</label><input id="s-proj" type="time" data-k="project_status_at" dir="ltr"></div>
        <div class="field" style="margin-top:12px"><label for="s-weekly">تقرير الإنتاجية الأسبوعي (الجمعة)</label><input id="s-weekly" type="time" data-k="weekly_insights_at" dir="ltr"></div>
        <div class="field" style="margin-top:12px"><label for="s-news">نشرة أخبار الذكاء الاصطناعي</label><input id="s-news" type="time" data-k="ai_news_at" dir="ltr"></div>
        <p class="hint" data-brief-off hidden>الملخّصات معطّلة من المزايا؛ لن تُرسل حتى تفعّلها.</p>
      </section>
      <section class="card" aria-labelledby="s-s">
        <div class="card-head"><h2 id="s-s">إرسال الرسائل للآخرين</h2></div>
        <fieldset style="border:0;margin:0;padding:0"><legend class="sr-only">وضع الإرسال</legend>
          <div class="radio-cards">
            <label class="radio-card"><input type="radio" name="send_mode" value="link"><div><b>رابط wa.me</b><span>يجهّز البوت الرسالة وأنت ترسلها بضغطة. آمن ولا يعرّض رقمك للحظر.</span></div></label>
            <label class="radio-card"><input type="radio" name="send_mode" value="direct"><div><b>إرسال مباشر</b><span>يرسل البوت من رقم واتساب مباشرة.</span></div></label>
          </div>
        </fieldset>
        <div class="banner banner-warn" data-direct-warn hidden style="margin:12px 0 0">${icon('alert')}<div><b>انتبه</b>الإرسال الآلي المباشر قد يؤدي لحظر الرقم من واتساب — وهو سبب الحظر الحالي غالباً.</div></div>
        <div class="field" style="margin:14px 0 0"><label for="s-sig">توقيع المالك</label><input id="s-sig" data-k="owner_signature" placeholder="مثال: — اسمك"><p class="hint">يُضاف في نهاية الرسائل التي يصيغها البوت باسمك.</p></div>
      </section>
    </div>
  </div>
  ${meta ? modelsSection(meta) : ''}
  <div class="savebar" data-savebar hidden role="region" aria-label="حفظ الإعدادات"><p>لديك تغييرات غير محفوظة</p><button type="button" class="btn btn-sm btn-ghost" data-discard>تجاهل</button><button type="button" class="btn btn-sm btn-primary" data-save>حفظ التغييرات</button></div>

  <section class="section" aria-labelledby="s-k">
    <div class="section-head">${icon('file')}<h2 id="s-k">ملف المعرفة</h2></div>
    <div class="card">
      <p class="small muted" style="margin-bottom:10px">معلومات يعتمد عليها البوت في فهمك والرد عنك: أشخاص، مشاريع، تفضيلات. بصيغة Markdown.</p>
      <label for="kn" class="sr-only">محتوى ملف المعرفة</label>
      <textarea id="kn" class="editor" dir="auto" spellcheck="false"></textarea>
      <div class="editor-foot"><span class="muted" data-kn-meta aria-live="polite"></span><button type="button" class="btn" data-kn-reset disabled>تراجع</button><button type="button" class="btn btn-primary" data-kn-save disabled>حفظ الملف</button></div>
      <div class="editor-foot" style="border-top:1px solid var(--border);padding-top:10px"><span class="muted" id="ob-hint">المقابلة الشخصية: أسئلة قصيرة في المحادثة يبني منها البوت هذا الملف.</span><button type="button" class="btn" data-ob-restart aria-describedby="ob-hint">${icon('refresh', 18)} إعادة المقابلة</button></div>
    </div>
  </section>`

  const $ = (sel) => root.querySelector(sel)
  const kn = $('#kn'); kn.value = knOrig

  function diff() {
    const out = {}
    for (const k of ['morning_brief_at', 'evening_review_at', 'ai_news_at', 'send_mode', 'owner_signature']) if ((draft[k] ?? '') !== (orig[k] ?? '')) out[k] = draft[k]
    const f = {}
    for (const [k] of FEATURES) if (!!draft.features[k] !== !!orig.features[k]) f[k] = !!draft.features[k]
    if (Object.keys(f).length) out.features = f
    if ((draft.project_status_at ?? '') !== (orig.project_status_at ?? '')) out.project_status_at = draft.project_status_at
    if ((draft.weekly_insights_at ?? '') !== (orig.weekly_insights_at ?? '')) out.weekly_insights_at = draft.weekly_insights_at
    // النماذج: الأدوار المتغيّرة فقط
    if (meta) {
      const m = {}
      for (const r of meta.roles) if (draft.models?.[r] && !sameRole(draft.models[r], orig.models?.[r])) m[r] = normRole(draft.models[r])
      if (Object.keys(m).length) out.models = m
    }
    return out
  }
  function paintModels() {
    if (!meta) return
    const hasStatus = !!meta.status?.length
    for (const r of meta.roles) {
      const m = draft.models?.[r]
      const card = root.querySelector(`.model-role[data-role="${r}"]`)
      if (!m || !card) continue
      const set = (sel, v) => { const el = card.querySelector(sel); if (el && document.activeElement !== el) el.value = v }
      set(`[data-m="${r}.provider"]`, m.provider)
      set(`[data-m="${r}.model"]`, m.model ?? '')
      set(`[data-m="${r}.fbProvider"]`, m.fallback?.provider ?? '')
      set(`[data-m="${r}.fbModel"]`, m.fallback?.model ?? '')
      card.querySelector(`[data-m="${r}.model"]`).setAttribute('list', `models-${m.provider}`)
      const fbModel = card.querySelector(`[data-m="${r}.fbModel"]`)
      fbModel.disabled = !m.fallback?.provider
      if (m.fallback?.provider) fbModel.setAttribute('list', `models-${m.fallback.provider}`); else fbModel.removeAttribute('list')
      const badge = card.querySelector(`[data-badge="${r}"]`)
      badge.hidden = !hasStatus
      if (hasStatus) { const [cls, text] = keyBadge(m, keys); badge.className = `chip ${cls}`; badge.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(text)}` }
      const err = modelErrors[r] || ''
      card.querySelector(`[data-merr="${r}"]`).textContent = err
      card.classList.toggle('is-dirty', !sameRole(m, orig.models?.[r]))
      card.classList.toggle('has-error', !!err)
      card.querySelectorAll('input, select').forEach((el) => { if (err) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid') })
    }
  }
  /** تحقق محلي قبل الإرسال — الخادم يبقى المرجع (رسالة 400 تُعرض تحت الدور نفسه) */
  function validateModels(models) {
    let first = null
    for (const [r, m] of Object.entries(models || {})) {
      const bad = !MODEL_RE.test(m.model) ? 'اكتب اسم نموذج صالح: حروف لاتينية وأرقام و . _ / : - (من 3 إلى 80).'
        : m.fallback && !MODEL_RE.test(m.fallback.model) ? 'اكتب اسم النموذج الاحتياطي، أو اختر «بلا احتياطي».' : ''
      if (bad) { modelErrors[r] = bad; first ??= r }
    }
    return first
  }
  function focusRole(r) {
    const card = root.querySelector(`.model-role[data-role="${r}"]`)
    card?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    card?.querySelector('select')?.focus({ preventScroll: true })
  }
  /** 400 من الخادم: "models.voice: voice: المزوّد ما يدعم audio؛ …" ← رسالة تحت كل دور معنيّ */
  function applyServerError(msg) {
    let first = null
    for (const part of String(msg).split('؛')) {
      const path = part.trim().split(':')[0]
      const r = meta?.roles.find((x) => path === x || path.startsWith(`models.${x}`))
      if (!r) continue
      modelErrors[r] = part.trim().replace(/^models\.\w+(\.\w+)*:\s*/, '').replace(new RegExp(`^${r}:\\s*`), '')
        .replace(/\b(text|audio|vision|video|search)\b/, (c) => NEED_AR[c])
      first ??= r
    }
    return first
  }
  function paint() {
    root.querySelectorAll('[data-feature]').forEach((b) => b.setAttribute('aria-checked', String(!!draft.features[b.dataset.feature])))
    root.querySelectorAll('[data-k]').forEach((i) => { if (document.activeElement !== i) i.value = draft[i.dataset.k] ?? '' })
    root.querySelectorAll('input[name=send_mode]').forEach((r) => { r.checked = r.value === (draft.send_mode || 'link') })
    $('[data-direct-warn]').hidden = draft.send_mode !== 'direct'
    $('[data-brief-off]').hidden = !!draft.features.briefs
    $('#s-morning').disabled = $('#s-evening').disabled = !draft.features.briefs
    $('#s-news').disabled = !draft.features.ai_news_digest
    $('#s-proj').disabled = !draft.features.project_status_daily
    $('#s-weekly').disabled = !draft.features.weekly_insights
    paintModels()
    $('[data-savebar]').hidden = !Object.keys(diff()).length
    paintKn()
  }
  function paintKn() {
    const dirty = kn.value !== knOrig
    $('[data-kn-save]').disabled = $('[data-kn-reset]').disabled = !dirty
    $('[data-kn-meta]').innerHTML = `${num(kn.value.length)} حرف · ${dirty ? '<b style="color:var(--warn-text)">تعديلات غير محفوظة</b>' : `آخر حفظ ${when(knUpdated, 'غير معروف')}`}`
  }
  leaveGuard.check = () => Object.keys(diff()).length > 0 || kn.value !== knOrig

  root.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-feature]')
    if (sw) { draft.features[sw.dataset.feature] = !draft.features[sw.dataset.feature]; paint() }
  })
  // تعديل حقل نموذج: data-m="role.provider|model|fbProvider|fbModel"
  function onModel(el) {
    const [r, f] = el.dataset.m.split('.')
    const m = draft.models[r]
    if (f === 'provider') {
      if (m.provider === el.value) return
      m.provider = el.value
      const list = SUGGEST[el.value] || []
      if (!list.includes(m.model)) m.model = list[0] ?? ''
    } else if (f === 'model') m.model = el.value
    else if (f === 'fbProvider') {
      if (!el.value) delete m.fallback
      else if (m.fallback?.provider !== el.value) {
        const list = SUGGEST[el.value] || []
        m.fallback = { provider: el.value, model: list[list.length > 1 && el.value === m.provider ? 1 : 0] ?? '' }
      }
    } else if (f === 'fbModel' && m.fallback) m.fallback.model = el.value
    delete modelErrors[r]
    paint()
  }
  root.addEventListener('input', (e) => {
    if (e.target.dataset.m) return onModel(e.target)
    if (e.target.dataset.k) { draft[e.target.dataset.k] = e.target.value; paint() }
    if (e.target.name === 'send_mode') { draft.send_mode = e.target.value; paint() }
    if (e.target === kn) paintKn()
  })
  root.addEventListener('change', (e) => {
    if (e.target.dataset.m) return onModel(e.target)
    if (e.target.name === 'send_mode') { draft.send_mode = e.target.value; paint() }
  })

  $('[data-discard]').addEventListener('click', () => { draft = clone(orig); for (const r in modelErrors) delete modelErrors[r]; paint() })
  $('[data-save]').addEventListener('click', (e) => {
    const body = diff()
    const badRole = validateModels(body.models)
    if (badRole) { paint(); focusRole(badRole); return toast('راجع الحقول المعلَّمة في قسم النماذج', 'error') }
    if (body.send_mode === 'direct' && !confirmPending) {
      confirmPending = true
      return confirmDialog({ title: 'تفعيل الإرسال المباشر؟', body: 'سيرسل البوت الرسائل من رقم واتساب دون مراجعتك، وقد يعرّض ذلك الرقم للحظر.', confirm: 'تفعيل وحفظ', danger: true })
        .then((ok) => { confirmPending = false; if (ok) save(e.target, { ...body, confirm_direct: true }) })
    }
    save(e.target, body)
  })
  let confirmPending = false
  async function save(btn, body) {
    try {
      const res = await busy(btn, () => api('/settings', { method: 'PUT', body }))
      const next = res && typeof res === 'object' && res.features ? res : { ...draft, features: { ...draft.features } }
      orig = clone(next); draft = clone(next)
      for (const r in modelErrors) delete modelErrors[r]
      // شارات المفاتيح تتبع المزوّدين المحفوظين — نحدّثها بعد كل حفظ يمسّ النماذج
      if (meta && body.models) {
        try { const fresh = await api('/models'); meta.status = fresh.status; keys = keysFrom(fresh.status) } catch { /* نبقي الحالة السابقة */ }
      }
      paint(); toast('حُفظت الإعدادات')
    } catch (err) {
      const r = err.status === 400 && body.models ? applyServerError(err.message) : null
      if (r) { paint(); focusRole(r); toast('رفض الخادم إعداد النماذج — التفاصيل تحت الدور', 'error') } else toast(err.message, 'error')
    }
  }

  async function saveKn() {
    if (kn.value === knOrig) return
    if (!kn.value.trim()) return toast('لا يمكن حفظ ملف معرفة فارغ.', 'error')
    const ok = await confirmDialog({ title: 'حفظ ملف المعرفة؟', body: 'سيستبدل هذا الملف الحالي ويبدأ البوت باستخدامه فوراً في كل الردود.', confirm: 'حفظ' })
    if (!ok) return
    try {
      const res = await busy($('[data-kn-save]'), () => api('/knowledge', { method: 'PUT', body: { markdown: kn.value } }))
      knOrig = kn.value; knUpdated = res?.updated_at || new Date().toISOString(); paintKn(); toast('حُفظ ملف المعرفة')
    } catch (err) { toast(err.message, 'error') }
  }
  $('[data-kn-save]').addEventListener('click', saveKn)
  $('[data-kn-reset]').addEventListener('click', async () => {
    if (await confirmDialog({ title: 'تجاهل التعديلات؟', body: 'سيعود النص إلى آخر نسخة محفوظة.', confirm: 'تجاهل', danger: true })) { kn.value = knOrig; paintKn() }
  })
  $('[data-ob-restart]').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const ok = await confirmDialog({ title: 'إعادة المقابلة؟', body: 'تبدأ المقابلة من جديد مع رسالتك التالية للبوت. الملف الحالي يبقى كما هو حتى تنتهي المقابلة.', confirm: 'إعادة المقابلة' })
    if (!ok) return
    try {
      await busy(btn, () => api('/onboarding/restart', { method: 'POST', body: {} }))
      toast('أُعيدت المقابلة — تبدأ مع رسالتك التالية للبوت')
    } catch (err) { toast(err.message, 'error') }
  })
  kn.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveKn() }
  })
  paint()
}
