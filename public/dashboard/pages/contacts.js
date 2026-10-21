import { api } from '../api.js'
import { esc, icon, toast, confirmDialog, formDialog, emptyState, initial } from '../ui.js'

const norm = (s) => String(s || '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
const digits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d]/g, '')

export default async function contacts(root) {
  let items = (await api('/contacts')).items || [], q = ''
  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>جهات الاتصال</h1><p>الأسماء والألقاب التي يفهمها البوت عند طلب مراسلة شخص.</p></div>
    <button class="btn btn-primary" type="button" data-add>${icon('plus', 18)} جهة جديدة</button>
  </div>
  <div class="toolbar"><label class="search"><span class="sr-only">بحث في جهات الاتصال</span>${icon('search', 18)}<input type="search" placeholder="ابحث بالاسم أو اللقب أو الرقم"></label></div>
  <p class="list-count" aria-live="polite"></p>
  <div data-list></div>`
  const list = root.querySelector('[data-list]'), count = root.querySelector('.list-count')

  function paint() {
    const nq = norm(q), dq = digits(q)
    const shown = !q ? items : items.filter((c) => norm(c.name).includes(nq) || (c.aliases || []).some((a) => norm(a).includes(nq)) || (dq && digits(c.phone).includes(dq)))
    count.textContent = items.length ? `${shown.length} من ${items.length}` : ''
    if (!items.length) { list.innerHTML = emptyState('users', 'لا توجد جهات اتصال', 'أضف الأشخاص الذين تراسلهم كثيراً مع ألقابهم، مثل «أبو سالم».', `<button class="btn btn-primary" type="button" data-add>${icon('plus', 18)} جهة جديدة</button>`); return }
    if (!shown.length) { list.innerHTML = emptyState('search', 'لا نتائج', `لا توجد جهة تطابق «${esc(q)}».`); return }
    list.innerHTML = `<ul class="list grid-2 grid">${shown.map((c) => `<li class="item" data-id="${esc(c.id)}">
      <span class="avatar" aria-hidden="true">${esc(initial(c.name))}</span>
      <div class="item-body">
        <div class="item-title">${esc(c.name)}</div>
        <a class="ltr num small" href="tel:+${esc(digits(c.phone))}" style="color:var(--text-2);text-decoration:none">+${esc(digits(c.phone))}</a>
        ${c.aliases?.length ? `<div class="tags" style="margin-top:6px">${c.aliases.map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="item-actions">
        <button type="button" class="icon-btn" data-act="edit" aria-label="تعديل: ${esc(c.name)}">${icon('edit', 18)}</button>
        <button type="button" class="icon-btn danger" data-act="del" aria-label="حذف: ${esc(c.name)}">${icon('trash', 18)}</button>
      </div></li>`).join('')}</ul>`
  }

  async function edit(c) {
    const saved = await formDialog({
      title: c ? 'تعديل جهة الاتصال' : 'جهة اتصال جديدة', submit: c ? 'حفظ' : 'إضافة',
      values: c ? { ...c, phone: digits(c.phone), aliases: (c.aliases || []).join('، ') } : {},
      fields: [
        { name: 'name', label: 'الاسم', required: true, autocomplete: 'off' },
        { name: 'phone', label: 'رقم الجوال', type: 'tel', required: true, dir: 'ltr', inputmode: 'tel', placeholder: '9665XXXXXXXX', hint: 'بالصيغة الدولية بدون + أو أصفار بادئة، مثل 966500004567' },
        { name: 'aliases', label: 'الألقاب', hint: 'افصل بينها بفاصلة. يستخدمها البوت لفهم «أرسل لأبو سالم».', placeholder: 'أبو سالم، سالم' },
      ],
      validate: (n, v) => {
        if (n !== 'phone' || !v) return
        const d = digits(v)
        if (d.startsWith('05') && d.length === 10) return 'أضف رمز الدولة: 9665… بدلاً من 05…'
        if (d.length < 10 || d.length > 15) return 'الرقم غير صالح؛ تأكد من رمز الدولة وعدد الأرقام.'
      },
      onSubmit: (v) => {
        const body = { name: v.name, phone: digits(v.phone), aliases: v.aliases.split(/[,،]/).map((a) => a.trim()).filter(Boolean) }
        return c ? api(`/contacts/${encodeURIComponent(c.id)}`, { method: 'PATCH', body }) : api('/contacts', { method: 'POST', body })
      },
    })
    if (saved) { toast(c ? 'حُفظت جهة الاتصال' : 'أُضيفت جهة الاتصال'); items = (await api('/contacts')).items || []; paint() }
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return
    if (b.hasAttribute('data-add')) return edit(null)
    const c = items.find((x) => String(x.id) === b.closest('[data-id]')?.dataset.id); if (!c) return
    if (b.dataset.act === 'edit') edit(c)
    if (b.dataset.act === 'del') {
      if (!(await confirmDialog({ title: 'حذف جهة الاتصال؟', body: `لن يتعرّف البوت على «${esc(c.name)}» بعد الحذف.`, confirm: 'حذف', danger: true }))) return
      try { await api(`/contacts/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); items = items.filter((x) => x !== c); paint(); toast('حُذفت جهة الاتصال') } catch (err) { toast(err.message, 'error') }
    }
  })
  root.querySelector('.search input').addEventListener('input', (e) => { q = e.target.value.trim(); paint() })
  paint()
}
