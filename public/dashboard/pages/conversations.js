import { api } from '../api.js'
import { esc, icon, when, emptyState, riyadhDay, dayLabel, skeleton, errorState } from '../ui.js'

const CH = { telegram: ['telegram', 'تيليجرام'], whatsapp: ['whatsapp', 'واتساب'], dashboard: ['overview', 'اللوحة'] }

export default async function conversations(root, { params }) {
  let limit = [50, 100, 200].includes(+params.get('limit')) ? +params.get('limit') : 50
  root.innerHTML = `
  <div class="page-head">
    <div class="grow"><h1>المحادثات</h1><p>آخر الرسائل بينك وبين البوت على كل القنوات. للقراءة فقط.</p></div>
    <label class="small" style="display:flex;align-items:center;gap:8px">عرض
      <select class="input" style="width:auto;min-height:40px;padding:4px 10px" data-limit>${[50, 100, 200].map((n) => `<option value="${n}" ${n === limit ? 'selected' : ''}>${n}</option>`).join('')}</select> رسالة</label>
    <button class="icon-btn" type="button" data-refresh aria-label="تحديث">${icon('refresh')}</button>
  </div>
  <div data-list></div>`
  const list = root.querySelector('[data-list]')
  async function load() {
    list.innerHTML = skeleton([60, 90, 60, 120])
    try {
      const items = ((await api(`/conversations?limit=${limit}`)).items || []).slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      if (!items.length) { list.innerHTML = emptyState('chat', 'لا محادثات بعد', 'ستظهر هنا رسائلك للبوت وردوده.'); return }
      let day = ''
      list.innerHTML = `<div class="convo">${items.map((m) => {
        const d = riyadhDay(m.created_at), sep = d !== day ? `<div class="day-sep">${esc(dayLabel(m.created_at))}</div>` : ''
        day = d
        const [ic, chName] = CH[m.channel] || ['chat', m.channel || '']
        const owner = m.role === 'owner' || m.role === 'user'
        return `${sep}<div class="bubble ${owner ? 'owner' : 'bot'}" dir="auto"><span class="sr-only">${owner ? 'أنت' : 'البوت'}:</span>${esc(m.text)}<div class="bubble-meta">${icon(ic, 12, chName)}${owner ? 'أنت' : 'البوت'} · ${when(m.created_at)}</div></div>`
      }).join('')}</div>`
      window.scrollTo({ top: document.body.scrollHeight })
    } catch (e) { if (e.status !== 401) list.replaceChildren(errorState(e, load)) }
  }
  root.querySelector('[data-limit]').addEventListener('change', (e) => { limit = +e.target.value; history.replaceState(null, '', `#/conversations?limit=${limit}`); load() })
  root.querySelector('[data-refresh]').addEventListener('click', load)
  await load()
}
