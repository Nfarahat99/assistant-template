import { api } from '../api.js'
import { esc, icon, toast, emptyState, busy } from '../ui.js'

const norm = (s) => String(s || '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')

export default async function projects(root) {
  let items = (await api('/projects')).items || [], q = ''
  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>المشاريع</h1><p>الأسماء المختصرة التي تستخدمها في طلبات الكود وما يقابلها من مستودعات.</p></div>
    <button class="btn" type="button" data-reload>${icon('refresh', 18)} تحديث القائمة</button>
  </div>
  <div class="toolbar"><label class="search"><span class="sr-only">بحث في المشاريع</span>${icon('search', 18)}<input type="search" placeholder="ابحث بالاسم أو المستودع"></label></div>
  <p class="list-count" aria-live="polite"></p>
  <div data-list></div>`
  const list = root.querySelector('[data-list]'), count = root.querySelector('.list-count')
  const paint = () => {
    const nq = norm(q)
    const shown = !q ? items : items.filter((p) => [p.alias, p.repo, ...(p.aliases || [])].some((s) => norm(s).includes(nq)))
    const auto = items.filter((p) => p.auto_deploy).length
    count.textContent = items.length ? `${items.length} مشروعاً · ${auto} بنشر تلقائي${q ? ` · يظهر ${shown.length}` : ''}` : ''
    if (!items.length) { list.innerHTML = emptyState('folder', 'لا مشاريع', 'اضغط «تحديث القائمة» لقراءة ملف المشاريع من جديد.'); return }
    if (!shown.length) { list.innerHTML = emptyState('search', 'لا نتائج', `لا يوجد مشروع يطابق «${esc(q)}».`); return }
    list.innerHTML = `<ul class="list grid grid-2">${shown.map((p) => `<li class="item">
      <span class="avatar" aria-hidden="true" style="border-radius:10px">${icon('folder', 18)}</span>
      <div class="item-body">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="item-title">${esc(p.alias)}</span>
          ${p.auto_deploy ? `<span class="chip chip-ok" style="margin-inline-start:auto">${icon('rocket', 14)} نشر تلقائي</span>` : `<span class="chip" style="margin-inline-start:auto">نشر يدوي</span>`}
        </div>
        <a class="mono ltr" href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener" style="display:inline-block;color:var(--text-2);margin-top:2px;overflow-wrap:anywhere">${esc(p.repo)}</a>
        <div class="item-meta" style="margin-top:6px">
          <span>${icon('branch', 14)}<span class="mono ltr">${esc(p.default_branch || 'main')}</span></span>
          ${(p.aliases || []).filter((a) => a !== p.alias).length ? `<span class="tags">${p.aliases.filter((a) => a !== p.alias).map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</span>` : ''}
        </div>
      </div></li>`).join('')}</ul>`
  }
  root.querySelector('[data-reload]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      await api('/projects/reload', { method: 'POST' })
      items = (await api('/projects')).items || []; paint(); toast(`حُدّثت القائمة: ${items.length} مشروعاً`)
    } catch (err) { toast(err.message, 'error') }
  }))
  root.querySelector('.search input').addEventListener('input', (e) => { q = e.target.value.trim(); paint() })
  paint()
}
