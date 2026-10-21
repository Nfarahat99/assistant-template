// Tiny SVG charts. Time flows left→right (LTR plot) with explicit start/end labels.
// Pointer + keyboard (arrow keys) scrub a readout, so values are reachable without hover.
import { h, esc, num, ymdLabel } from './ui.js'

function scrubbable(wrap, n, onPick, initial) {
  let idx = initial
  const pick = (i) => { idx = Math.max(0, Math.min(n - 1, i)); onPick(idx) }
  const fromEvent = (e) => {
    const r = wrap.querySelector('svg').getBoundingClientRect()
    pick(Math.round(((e.clientX - r.left) / r.width) * (n - 1)))
  }
  wrap.addEventListener('pointermove', fromEvent)
  wrap.addEventListener('pointerdown', fromEvent)
  wrap.addEventListener('pointerleave', () => onPick(null))
  wrap.addEventListener('keydown', (e) => {
    // Plot is LTR: ArrowRight = later day regardless of page direction.
    if (e.key === 'ArrowRight') { e.preventDefault(); pick((idx ?? n - 1) + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pick((idx ?? n - 1) - 1) }
    else if (e.key === 'Home') pick(0)
    else if (e.key === 'End') pick(n - 1)
  })
  wrap.addEventListener('blur', () => onPick(null))
}

const grid = (W, H) => [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}" stroke="var(--chart-grid)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')

/** Area/line chart. data: [{date:'YYYY-MM-DD', ...}], key: numeric field. */
export function areaChart({ data, key, label, unit = '', summary, describe }) {
  if (!data?.length) return h(`<p class="muted small">لا توجد بيانات بعد.</p>`)
  const W = 600, H = 120, n = data.length
  const max = Math.max(1, ...data.map((d) => d[key] || 0)) * 1.12
  const x = (i) => (n < 2 ? W / 2 : (i * W) / (n - 1)), y = (v) => H - ((v || 0) / max) * H
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('')
  const total = data.reduce((s, d) => s + (d[key] || 0), 0)
  const wrap = h(`<div class="chart" tabindex="0" role="group" aria-label="${esc(label)}. ${esc(summary || '')}. استخدم الأسهم لاستعراض الأيام.">
    <div class="chart-readout" aria-live="polite"></div>
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" height="${H}" dir="ltr" aria-hidden="true">
        ${grid(W, H)}
        <path d="${line}L${W},${H}L0,${H}Z" fill="var(--chart-a)" opacity=".12"/>
        <path d="${line}" fill="none" stroke="var(--chart-a)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        <line class="cursor" y1="0" y2="${H}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" visibility="hidden"/>
      </svg>
      <span class="chart-dot" hidden></span>
      <span class="chart-y num">${num(Math.round(max / 1.12))}</span>
    </div>
    <div class="chart-axis"><span>${ymdLabel(data[0].date)}</span><span>${ymdLabel(data[n - 1].date)}</span></div>
  </div>`)
  const ro = wrap.querySelector('.chart-readout'), cur = wrap.querySelector('.cursor'), dot = wrap.querySelector('.chart-dot')
  const show = (i) => {
    if (i == null) {
      cur.setAttribute('visibility', 'hidden'); dot.hidden = true
      ro.innerHTML = `<b>${num(total)}</b><span>${esc(unit)} خلال ${n} يوماً</span>`
      return
    }
    const d = data[i]
    cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible')
    dot.hidden = false; dot.style.left = (x(i) / W) * 100 + '%'; dot.style.top = (y(d[key]) / H) * 100 + '%'
    ro.innerHTML = `<b>${num(d[key])}</b><span>${esc(unit)} · ${ymdLabel(d.date)}</span>${describe ? `<span>${describe(d)}</span>` : ''}`
  }
  show(null)
  scrubbable(wrap, n, show, null)
  return wrap
}

/** Grouped bars: two series side by side per day. */
export function pairBars({ data, a, b, labelA, labelB, label }) {
  if (!data?.length) return h(`<p class="muted small">لا توجد بيانات بعد.</p>`)
  const W = 600, H = 140, n = data.length, gw = W / n
  const max = Math.max(1, ...data.flatMap((d) => [d[a] || 0, d[b] || 0])) * 1.15
  const bw = Math.min(14, gw * 0.3), bh = (v) => ((v || 0) / max) * H
  const bars = data.map((d, i) => {
    const cx = gw * i + gw / 2
    return `<rect class="hl" x="${gw * i + 1}" y="0" width="${gw - 2}" height="${H}" rx="4" fill="var(--surface-2)" opacity="0"/>
      <rect x="${cx - bw - 1}" y="${H - bh(d[a])}" width="${bw}" height="${bh(d[a])}" rx="2" fill="var(--chart-b)"/>
      <rect x="${cx + 1}" y="${H - bh(d[b])}" width="${bw}" height="${bh(d[b])}" rx="2" fill="var(--chart-a)"/>`
  }).join('')
  const ta = data.reduce((s, d) => s + (d[a] || 0), 0), tb = data.reduce((s, d) => s + (d[b] || 0), 0)
  const wrap = h(`<div class="chart" tabindex="0" role="group" aria-label="${esc(label)}: ${esc(labelA)} ${ta}، ${esc(labelB)} ${tb}. استخدم الأسهم لاستعراض الأيام.">
    <div class="chart-readout" aria-live="polite"></div>
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" height="${H}" dir="ltr" aria-hidden="true">${grid(W, H)}${bars}</svg>
      <span class="chart-y num">${num(Math.round(max / 1.15))}</span>
    </div>
    <div class="chart-axis"><span>${ymdLabel(data[0].date)}</span><span>${ymdLabel(data[n - 1].date)}</span></div>
  </div>`)
  const ro = wrap.querySelector('.chart-readout'), hls = [...wrap.querySelectorAll('.hl')]
  const show = (i) => {
    hls.forEach((r, j) => r.setAttribute('opacity', j === i ? '1' : '0'))
    const d = i == null ? { [a]: ta, [b]: tb } : data[i]
    ro.innerHTML = `<span class="legend"><span><i style="background:var(--chart-b)"></i>${esc(labelA)} <b>${num(d[a])}</b></span><span><i style="background:var(--chart-a)"></i>${esc(labelB)} <b>${num(d[b])}</b></span></span><span>${i == null ? `آخر ${n} يوماً` : ymdLabel(data[i].date)}</span>`
  }
  show(null)
  scrubbable(wrap, n, show, null)
  return wrap
}
