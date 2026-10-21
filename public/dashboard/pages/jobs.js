import { api } from '../api.js'
import { esc, icon, when, emptyState, skeleton, errorState } from '../ui.js'
const safe = (u) => (/^https:\/\//i.test(u || '') ? u : '')

export const JOB_STATUS = {
  queued: ['', 'في الانتظار'], pending: ['', 'في الانتظار'], dispatched: ['chip-info', 'أُرسل للتشغيل'],
  running: ['chip-info', 'قيد التنفيذ', true], in_progress: ['chip-info', 'قيد التنفيذ', true],
  pr_open: ['chip-warn', 'بانتظار موافقتك'], awaiting_merge: ['chip-warn', 'بانتظار موافقتك'], awaiting_approval: ['chip-warn', 'بانتظار موافقتك'],
  merged: ['chip-ok', 'مدموج'], deployed: ['chip-ok', 'مدموج ومنشور'], no_changes: ['', 'بلا تغييرات'],
  failed: ['chip-danger', 'فشل'], error: ['chip-danger', 'فشل'], rejected: ['', 'مرفوض'], cancelled: ['', 'أُلغي'], closed: ['', 'أُغلق'],
}
const FILTERS = [['all', 'الكل'], ['active', 'نشطة'], ['review', 'بانتظار موافقتك'], ['failed', 'فاشلة']]
const group = (s) => (['pr_open', 'awaiting_merge', 'awaiting_approval'].includes(s) ? 'review' : ['failed', 'error'].includes(s) ? 'failed' : ['queued', 'pending', 'dispatched', 'running', 'in_progress'].includes(s) ? 'active' : 'other')

export default async function jobs(root) {
  const r = await api('/jobs')
  const items = r.items || []
  let f = 'all'
  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>طلبات الكود</h1><p>تعديلات Claude Code على مشاريعك: يُفتح طلب دمج، وبعد موافقتك يُدمج.</p></div>
    <button class="btn btn-sm" type="button" data-refresh>${icon('refresh', 18)} تحديث</button>
  </div>
  ${items.length ? `<div class="toolbar"><div class="segmented" role="group" aria-label="تصفية الطلبات">${FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === f}">${l}<span class="count num">${k === 'all' ? items.length : items.filter((j) => group(j.status) === k).length}</span></button>`).join('')}</div></div>` : ''}
  <div data-list></div>`
  const list = root.querySelector('[data-list]')
  const paint = () => {
    const shown = f === 'all' ? items : items.filter((j) => group(j.status) === f)
    if (!items.length) { list.innerHTML = emptyState('pr', 'لا طلبات بعد', 'اطلب من البوت تعديلاً على أحد مشاريعك، مثل: «في مشروعك أضف زر تصدير».'); return }
    if (!shown.length) { list.innerHTML = emptyState('check', 'لا شيء هنا', 'لا توجد طلبات بهذه الحالة.'); return }
    list.innerHTML = `<ul class="list">${shown.map(row).join('')}</ul>`
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.f) { f = b.dataset.f; root.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint() }
    if (b.hasAttribute('data-refresh')) { const fresh = document.createElement('div'); fresh.innerHTML = skeleton(); root.replaceWith(fresh); jobs(fresh).catch((err) => fresh.replaceChildren(errorState(err, () => location.reload()))) }
  })
  paint()
}

function row(j) {
  j = { ...j, run_url: safe(j.run_url), pr_url: safe(j.pr_url) }
  const [cls, label, live] = JOB_STATUS[j.status] || ['', j.status || '—']
  return `<li class="item">
    <div class="item-body">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px">
        <span class="item-title">${esc(j.project)}</span>
        ${j.repo ? `<span class="mono ltr muted">${esc(j.repo)}</span>` : ''}
        <span class="chip ${cls} ${live ? 'is-live' : ''}" style="margin-inline-start:auto"><span class="dot"></span>${esc(label)}</span>
      </div>
      <p style="margin-top:6px;overflow-wrap:anywhere" dir="auto">${esc(j.request)}</p>
      <div class="item-meta">
        <span>${icon('send', 14)} أُرسل ${when(j.dispatched_at)}</span>
        ${j.updated_at && j.updated_at !== j.dispatched_at ? `<span>${icon('clock', 14)} آخر تحديث ${when(j.updated_at)}</span>` : ''}
        <span class="mono ltr" title="معرّف الطلب">#${esc(String(j.request_id).slice(0, 8))}</span>
      </div>
      ${j.run_url || j.pr_url ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        ${j.pr_url ? `<a class="btn btn-sm ${group(j.status) === 'review' ? 'btn-primary' : ''}" href="${esc(j.pr_url)}" target="_blank" rel="noopener">${icon('pr', 16)} طلب الدمج</a>` : ''}
        ${j.run_url ? `<a class="btn btn-sm" href="${esc(j.run_url)}" target="_blank" rel="noopener">${icon('external', 16)} سجل التشغيل</a>` : ''}
      </div>` : ''}
    </div></li>`
}
