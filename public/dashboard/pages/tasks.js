import { api } from '../api.js'
import { h, esc, icon, when, toast, confirmDialog, formDialog, emptyState, errorState, skeleton, debounce, toRiyadhInput, fromRiyadhInput } from '../ui.js'

const FILTERS = [['open', 'مفتوحة'], ['overdue', 'متأخرة'], ['done', 'منجزة'], ['all', 'الكل']]
const PRIO = { high: ['prio-high', 'أولوية عالية'], urgent: ['prio-high', 'عاجلة'], low: ['prio-low', 'أولوية منخفضة'] }
const isOverdue = (t) => t.status !== 'done' && t.due_at && Date.parse(t.due_at) < Date.now()

export default async function tasks(root, { params }) {
  let status = FILTERS.some(([k]) => k === params.get('status')) ? params.get('status') : 'open'
  let q = params.get('q') || '', items = [], seq = 0

  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>المهام</h1><p>المهام الملتقطة من الرسائل الصوتية والنصية. الأوقات بتوقيت الرياض.</p></div>
    <button class="btn btn-primary" type="button" data-add>${icon('plus', 18)} مهمة جديدة</button>
  </div>
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="تصفية المهام">${FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === status}">${l}</button>`).join('')}</div>
    <label class="search"><span class="sr-only">بحث في المهام</span>${icon('search', 18)}<input type="search" placeholder="ابحث في العناوين والملاحظات" value="${esc(q)}" enterkeyhint="search"></label>
  </div>
  <p class="list-count" aria-live="polite"></p>
  <div data-list></div>`
  const list = root.querySelector('[data-list]'), count = root.querySelector('.list-count')

  const syncUrl = () => history.replaceState(null, '', `#/tasks?status=${status}${q ? '&q=' + encodeURIComponent(q) : ''}`)
  async function load() {
    const my = ++seq
    list.innerHTML = skeleton([84, 84, 84, 84]); count.textContent = ''
    try {
      const r = await api(`/tasks?status=${status}&q=${encodeURIComponent(q)}`)
      if (my !== seq) return
      items = r.items || []; paint()
    } catch (e) { if (my === seq && e.status !== 401) list.replaceChildren(errorState(e, load)) }
  }
  function paint() {
    count.textContent = items.length ? `${items.length} ${items.length === 1 ? 'مهمة' : items.length <= 10 ? 'مهام' : 'مهمة'}` : ''
    if (!items.length) {
      list.innerHTML = q ? emptyState('search', 'لا نتائج', `لا توجد مهام تطابق «${esc(q)}».`)
        : status === 'overdue' ? emptyState('check', 'لا شيء متأخر', 'كل المهام في موعدها.')
        : status === 'done' ? emptyState('inbox', 'لا مهام منجزة بعد')
        : emptyState('inbox', 'لا مهام مفتوحة', 'أرسل مهمة للبوت على تيليجرام أو أضفها من هنا.', `<button class="btn btn-primary" type="button" data-add>${icon('plus', 18)} مهمة جديدة</button>`)
      return
    }
    list.innerHTML = `<ul class="list">${items.map(row).join('')}</ul>`
  }
  function row(t) {
    const done = t.status === 'done', over = isOverdue(t), p = PRIO[t.priority]
    return `<li class="item ${done ? 'is-done' : ''}" data-id="${esc(t.id)}">
      <button type="button" class="check" role="checkbox" aria-checked="${done}" data-act="toggle" aria-label="${done ? 'إعادة فتح' : 'إنجاز'}: ${esc(t.title)}"><span>${icon('check', 16)}</span></button>
      <div class="item-body">
        <div class="item-title">${esc(t.title)}</div>
        ${t.notes ? `<div class="item-notes">${esc(t.notes)}</div>` : ''}
        <div class="item-meta">
          ${done ? `<span>${icon('check', 14)} أُنجزت ${when(t.done_at)}</span>` : t.due_at ? `<span class="${over ? 'overdue' : ''}">${icon(over ? 'alert' : 'clock', 14)}${over ? 'متأخرة · ' : 'الموعد '}${when(t.due_at)}</span>` : ''}
          ${!done && t.remind_at ? `<span>${icon('bell', 14)} تذكير ${when(t.remind_at)}</span>` : ''}
          ${p ? `<span class="prio ${p[0]}">${p[1]}</span>` : ''}
          <span>أُنشئت ${when(t.created_at)}</span>
        </div>
      </div>
      <div class="item-actions">
        <button type="button" class="icon-btn" data-act="edit" aria-label="تعديل: ${esc(t.title)}">${icon('edit', 18)}</button>
        <button type="button" class="icon-btn danger" data-act="del" aria-label="حذف: ${esc(t.title)}">${icon('trash', 18)}</button>
      </div></li>`
  }

  async function edit(t) {
    const saved = await formDialog({
      title: t ? 'تعديل المهمة' : 'مهمة جديدة', submit: t ? 'حفظ التعديلات' : 'إضافة',
      values: t ? { ...t, due_at: toRiyadhInput(t.due_at), remind_at: toRiyadhInput(t.remind_at), priority: t.priority || 'normal' } : { priority: 'normal' },
      fields: [
        { name: 'title', label: 'العنوان', required: true, placeholder: 'مثال: الاتصال بالمحاسب بخصوص الفاتورة' },
        { name: 'notes', label: 'ملاحظات', type: 'textarea', rows: 3 },
        { name: 'due_at', label: 'الموعد', type: 'datetime-local', half: true, hint: 'بتوقيت الرياض' },
        { name: 'remind_at', label: 'التذكير', type: 'datetime-local', half: true, hint: 'يصلك على تيليجرام' },
        { name: 'priority', label: 'الأولوية', type: 'select', options: [['normal', 'عادية'], ['high', 'عالية'], ['low', 'منخفضة']] },
      ],
      validate: (name, v) => {
        if (name === 'remind_at' && v && v !== toRiyadhInput(t?.remind_at) && Date.parse(fromRiyadhInput(v)) < Date.now()) return 'وقت التذكير مضى؛ اختر وقتاً لاحقاً.'
      },
      onSubmit: (v) => {
        const body = { title: v.title, notes: v.notes || null, due_at: fromRiyadhInput(v.due_at), remind_at: fromRiyadhInput(v.remind_at), priority: v.priority }
        return t ? api(`/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body }) : api('/tasks', { method: 'POST', body })
      },
    })
    if (saved !== null) { toast(t ? 'حُفظت المهمة' : 'أُضيفت المهمة'); load() }
  }
  async function setStatus(t, st, { undo = true } = {}) {
    try {
      await api(`/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { status: st } })
      t.status = st; t.done_at = st === 'done' ? new Date().toISOString() : null
      if ((status === 'open' || status === 'overdue') && st === 'done') items = items.filter((x) => x !== t)
      else if (status === 'done' && st !== 'done') items = items.filter((x) => x !== t)
      paint()
      if (undo) toast(st === 'done' ? 'أُنجزت المهمة' : 'أُعيد فتح المهمة', 'ok', { label: 'تراجع', fn: () => setStatus(t, st === 'done' ? 'open' : 'done', { undo: false }).then(load) })
    } catch (e) { toast(e.message, 'error'); paint() }
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.add !== undefined) return edit(null)
    if (b.dataset.f) {
      status = b.dataset.f
      root.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      syncUrl(); return load()
    }
    const id = b.closest('[data-id]')?.dataset.id, t = items.find((x) => String(x.id) === id)
    if (!t) return
    if (b.dataset.act === 'toggle') { b.setAttribute('aria-checked', String(t.status !== 'done')); setStatus(t, t.status === 'done' ? 'open' : 'done') }
    if (b.dataset.act === 'edit') edit(t)
    if (b.dataset.act === 'del') {
      if (!(await confirmDialog({ title: 'حذف المهمة؟', body: `سيتم حذف «${esc(t.title)}» نهائياً مع تذكيرها.`, confirm: 'حذف', danger: true }))) return
      try { await api(`/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' }); items = items.filter((x) => x !== t); paint(); toast('حُذفت المهمة') } catch (err) { toast(err.message, 'error') }
    }
  })
  root.querySelector('.search input').addEventListener('input', debounce((e) => { q = e.target.value.trim(); syncUrl(); load() }, 300))
  await load()
}
