// Gráficos en SVG propio (sin librerías: funcionan sin conexión y pesan poco).
// Siguen una guía fija: marcas delgadas (columnas <= 24px con punta redondeada de 4px, líneas de 2px),
// grilla en línea fina y recesiva, rótulos selectivos (no un número en cada punto), leyenda solo con
// 2+ series, tooltip al tocar/pasar el puntero o con el teclado, y una tabla equivalente para cada gráfico.
// Los colores vienen de variables CSS (--viz-*, --heat-*) validadas para modo claro y oscuro.
import * as M from './model.js';
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---- Formatos ------------------------------------------------------------------
// Compacto propio (Safari y Chrome no formatean igual "notation: compact" en es-CL).
const nf1 = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
export function compactNumber(v) {
  const a = Math.abs(v);
  const sgn = v < 0 ? '-' : '';
  if (a >= 1e6) return sgn + nf1.format(a / 1e6) + ' M';
  if (a >= 1e4) return sgn + nf1.format(a / 1e3) + ' mil';
  return sgn + (a < 100 && a % 1 ? nf1 : nf0).format(a);
}
export function compactMoney(v, cur) {
  const c = M.currencyInfo(cur || M.base());
  const sym = c.symbol === '$' ? '$' : c.symbol + ' ';
  const a = Math.abs(v);
  const num = a < 1e4 ? new Intl.NumberFormat('es-CL', { maximumFractionDigits: c.decimals ? 1 : 0 }).format(a) : compactNumber(a);
  return (v < 0 ? '-' : '') + sym + num;
}

// Escala "linda": 0 / 500 mil / 1 M / 1,5 M …
function niceScale(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const n = step0 / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

const approxTextW = (str, px = 11) => String(str).length * px * 0.58;

// ---- Contenedor que se dibuja con el ancho real (y se redibuja al cambiar) -------
function responsive(draw, height) {
  const box = h('div', { class: 'viz-plot', style: { height: height + 'px' } });   // la altura incluye el eje X
  let lastW = 0;
  const render = () => {
    const w = Math.round(box.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    draw(box, w);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(render).observe(box);
  requestAnimationFrame(render);
  return box;
}

// Tooltip: el valor manda (fuerte), el rótulo acompaña. Siempre con textContent (los nombres son datos).
function tooltip() {
  const tip = h('div', { class: 'viz-tip', role: 'status', hidden: true });
  return {
    el: tip,
    show(box, x, rows, title) {
      tip.replaceChildren();
      if (title) tip.append(h('div', { class: 'viz-tip-title' }, title));
      for (const r of rows) {
        tip.append(h('div', { class: 'viz-tip-row' + (r.strong ? ' strong' : '') },
          r.key ? h('span', { class: 'viz-key-line', style: { background: `var(${r.key})` } }) : null,
          h('b', null, r.value), r.label ? h('span', null, r.label) : null));
      }
      tip.hidden = false;
      const W = box.clientWidth, tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(W - tw, x - tw / 2)) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

// Interacción común: puntero (mouse, toque) y teclado eligen un índice.
function bindIndex(svg, box, count, xOf, { onActive, onPick, label }) {
  let active = -1;
  const set = (i) => { if (i !== active) { active = i; onActive(i); } };
  const idxAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) * (svg.viewBox.baseVal.width / r.width);
    let best = 0, bd = Infinity;
    for (let i = 0; i < count; i++) { const d = Math.abs(xOf(i) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'img');
  if (label) svg.setAttribute('aria-label', label);
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') set(idxAt(e.clientX)); });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') set(-1); });
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    set(idxAt(e.clientX));
    // un toque fuera del gráfico cierra el tooltip
    const off = (ev) => { if (!box.contains(ev.target)) { set(-1); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  });
  svg.addEventListener('click', (e) => { if (onPick) onPick(idxAt(e.clientX)); });
  svg.addEventListener('focus', () => set(active >= 0 ? active : count - 1));
  svg.addEventListener('blur', () => set(-1));
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { set(Math.max(0, active - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { set(Math.min(count - 1, active + 1)); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === ' ') && onPick && active >= 0) { onPick(active); e.preventDefault(); }
    else if (e.key === 'Escape') set(-1);
  });
}

// Rótulos del eje X: se salta lo necesario para que no choquen. Con varios años los rótulos se cuentan
// desde un enero y con un salto que divide el año (1, 2, 3, 4, 6, 12), así el año queda bajo su "ene"
// y nunca bajo otro mes; el primer rótulo también lleva su año.
function xAxisLabels(g, items, xOf, band, y, { yearLine }) {
  const need = Math.max(1, Math.ceil(30 / Math.max(band, 1)));
  const step = yearLine ? [1, 2, 3, 4, 6, 12].find(d => d >= need) || 12 : need;
  const n = items.length;
  let anchor = n - 1;                                     // sin años: siempre se rotula el último mes
  if (yearLine) { const jan = items.findIndex(it => it.ym && it.ym.endsWith('-01')); if (jan >= 0) anchor = jan; }
  let firstShown = -1;
  items.forEach((it, i) => {
    if (((i - anchor) % step + step) % step !== 0) return;
    if (firstShown < 0) firstShown = i;
    g.append(s('text', { x: xOf(i), y, 'text-anchor': 'middle', class: 'viz-tick' }, it.short));
    if (yearLine && it.ym && (it.ym.endsWith('-01') || i === firstShown)) {
      g.append(s('text', { x: xOf(i), y: y + 13, 'text-anchor': 'middle', class: 'viz-tick viz-year' }, it.ym.slice(0, 4)));
    }
  });
}

// ---- Columnas (una serie) ---------------------------------------------------------
// items: [{ short, long, ym?, value, note? }]
export function columnChart({ items, cur, height = 210, reference, refLabel = 'prom.', onPick, ariaLabel, highlight = -1 }) {
  const tip = tooltip();
  const fmtFull = (v) => M.fmt(v, cur);
  const multiYear = new Set(items.map(it => (it.ym || '').slice(0, 4))).size > 1;
  const box = responsive((box, W) => {
    const vals = items.map(it => it.value);
    const { lo, hi, ticks } = niceScale(Math.min(0, ...vals), Math.max(0, ...vals, reference || 0));
    const padL = Math.max(...ticks.map(t => approxTextW(compactMoney(t, cur)))) + 10;
    const padT = 20, padR = 6, padB = multiYear ? 36 : 24;
    const H = height, plotW = W - padL - padR, plotH = H - padT - padB;
    const y = (v) => padT + (hi - v) / (hi - lo) * plotH;
    const band = plotW / items.length;
    const xOf = (i) => padL + band * (i + 0.5);
    const bw = Math.max(3, Math.min(24, band * 0.62));
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg' });
    const grid = s('g');
    for (const t of ticks) {
      grid.append(s('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }));
      grid.append(s('text', { x: padL - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, compactMoney(t, cur)));
    }
    svg.append(grid);
    const bars = [];
    items.forEach((it, i) => {
      const v = it.value;
      if (!v) { bars.push(null); return; }
      const x0 = xOf(i) - bw / 2, base = y(0), top = y(v);
      const r = Math.min(4, bw / 2, Math.abs(base - top));
      const d = v > 0
        ? `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z`
        : `M${x0},${base}V${top - r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top - r}V${base}Z`;
      const p = s('path', { d, class: 'viz-bar' + (it.partial ? ' partial' : '') });
      svg.append(p); bars.push(p);
    });
    if (reference != null && reference > 0) {
      const yr = y(reference);
      svg.append(s('line', { x1: padL, x2: W - padR, y1: yr, y2: yr, class: 'viz-ref' }));
      svg.append(s('text', { x: padL + 4, y: yr - 4, class: 'viz-ref-label' }, `${refLabel} ${compactMoney(reference, cur)}`));
    }
    // rótulos selectivos: el máximo y el último
    let iMax = 0;
    vals.forEach((v, i) => { if (v > vals[iMax]) iMax = i; });
    for (const i of [...new Set([iMax, items.length - 1])]) {
      const v = vals[i];
      if (!v) continue;
      const label = compactMoney(v, cur);
      const tw = approxTextW(label);
      let x = xOf(i), anchor = 'middle';
      if (x + tw / 2 > W - 2) { x = W - 2; anchor = 'end'; }
      svg.append(s('text', { x, y: v > 0 ? y(v) - 6 : y(v) + 14, 'text-anchor': anchor, class: 'viz-value' }, label));
    }
    const axis = s('g');
    xAxisLabels(axis, items, xOf, band, H - padB + 16, { yearLine: multiYear });
    svg.append(axis);
    const setActive = (i) => {
      bars.forEach((b, k) => b && b.classList.toggle('dim', i >= 0 && k !== i));
      if (i < 0) { tip.hide(); return; }
      const it = items[i];
      tip.show(box, xOf(i), [{ value: fmtFull(it.value), label: '', strong: true }, ...(it.note ? [{ value: '', label: it.note }] : [])], it.long);
    };
    bindIndex(svg, box, items.length, xOf, { onActive: setActive, onPick, label: ariaLabel });
    box.replaceChildren(svg, tip.el);
    if (highlight >= 0) bars.forEach((b, k) => b && b.classList.toggle('dim', k !== highlight));
  }, height);
  return box;
}

// ---- Líneas (1 o más series en la misma unidad; nunca dos ejes) ---------------------
// points: [{ short, long, ym? }] · series: [{ name, values, color: '--viz-1', area?: true }]
export function lineChart({ points, series, cur, height = 230, extra, ariaLabel }) {
  const tip = tooltip();
  const multiYear = new Set(points.map(p => (p.ym || '').slice(0, 4))).size > 1;
  const box = responsive((box, W) => {
    const all = series.flatMap(sr => sr.values);
    const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
    const padL = Math.max(...ticks.map(t => approxTextW(compactMoney(t, cur)))) + 10;
    const lastLabels = series.map(sr => compactMoney(sr.values[sr.values.length - 1], cur));
    const padR = Math.max(...lastLabels.map(l => approxTextW(l))) + 14;
    const padT = 12, padB = 24;
    const H = height, plotW = W - padL - padR, plotH = H - padT - padB;
    const n = points.length;
    const xOf = (i) => padL + (n === 1 ? plotW / 2 : plotW * i / (n - 1));
    const y = (v) => padT + (hi - v) / (hi - lo) * plotH;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg' });
    for (const t of ticks) {
      svg.append(s('line', { x1: padL, x2: padL + plotW, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }));
      svg.append(s('text', { x: padL - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, compactMoney(t, cur)));
    }
    for (const sr of series) {
      const d = sr.values.map((v, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      if (sr.area) svg.append(s('path', { d: `${d}L${xOf(n - 1)},${y(0)}L${xOf(0)},${y(0)}Z`, class: 'viz-area', style: `fill: var(${sr.color})` }));
      svg.append(s('path', { d, class: 'viz-line', style: `stroke: var(${sr.color})` }));
    }
    // rótulo directo del último valor; si dos rótulos chocan, se deja solo el primero (la leyenda y el tooltip cubren)
    const ends = series.map((sr, k) => ({ k, y: y(sr.values[n - 1]), label: lastLabels[k], color: sr.color }));
    const shown = [];
    for (const e of ends) if (!shown.some(o => Math.abs(o.y - e.y) < 13)) shown.push(e);
    for (const e of ends) svg.append(s('circle', { cx: xOf(n - 1), cy: e.y, r: 4, class: 'viz-dot', style: `fill: var(${e.color})` }));
    for (const e of shown) svg.append(s('text', { x: xOf(n - 1) + 8, y: e.y + 4, class: 'viz-value' }, e.label));
    // eje X: meses si son pocos, años si son muchos
    const axis = s('g');
    if (!multiYear || n <= 14) {
      xAxisLabels(axis, points, xOf, plotW / Math.max(1, n - 1), H - padB + 16, { yearLine: false });
    } else {
      // años a intervalos parejos, contados desde el más reciente (que siempre lleva rótulo)
      const minGap = 36;
      const yearPx = plotW / Math.max(1, n - 1) * 12;
      const every = Math.max(1, Math.ceil(minGap / yearPx));
      const jans = [];
      points.forEach((p, i) => { if (p.ym && p.ym.endsWith('-01')) jans.push(i); });
      const marks = jans.filter((_, k) => (jans.length - 1 - k) % every === 0);
      // el primer punto lleva su año solo si no choca con el primer enero rotulado
      if (points[0].ym && !points[0].ym.endsWith('-01') && (!marks.length || xOf(marks[0]) - xOf(0) >= minGap)) marks.unshift(0);
      for (const i of marks) {
        axis.append(s('line', { x1: xOf(i), x2: xOf(i), y1: H - padB, y2: H - padB + 4, class: 'viz-base' }));
        axis.append(s('text', { x: xOf(i), y: H - padB + 16, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'viz-tick' }, points[i].ym.slice(0, 4)));
      }
    }
    svg.append(axis);
    const cross = s('g', { class: 'viz-cross', visibility: 'hidden' });
    const vline = s('line', { y1: padT, y2: H - padB, class: 'viz-crossline' });
    cross.append(vline);
    const dots = series.map(sr => { const c = s('circle', { r: 4, class: 'viz-dot', style: `fill: var(${sr.color})` }); cross.append(c); return c; });
    svg.append(cross);
    const setActive = (i) => {
      if (i < 0) { cross.setAttribute('visibility', 'hidden'); tip.hide(); return; }
      const x = xOf(i);
      vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      series.forEach((sr, k) => { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', y(sr.values[i])); });
      cross.setAttribute('visibility', 'visible');
      const rows = series.map(sr => ({ key: sr.color, value: M.fmt(sr.values[i], cur), label: sr.name }));
      tip.show(box, x, rows.concat(extra ? extra(i) : []), points[i].long);
    };
    bindIndex(svg, box, n, xOf, { onActive: setActive, label: ariaLabel });
    box.replaceChildren(svg, tip.el);
  }, height);
  return box;
}

// ---- Mini línea de tendencia (decorativa: los valores están en la fila) -----------
export function sparkline(values, { width = 72, height = 26 } = {}) {
  const vals = values.filter(v => Number.isFinite(v));
  if (vals.length < 2) return null;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pad = 4;
  const x = (i) => pad + (width - 2 * pad) * i / (vals.length - 1);
  const y = (v) => pad + (mx === mn ? (height - 2 * pad) / 2 : (mx - v) / (mx - mn) * (height - 2 * pad));
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'viz-spark', 'aria-hidden': 'true' },
    s('path', { d, class: 'viz-spark-line' }),
    s('circle', { cx: x(vals.length - 1), cy: y(vals[vals.length - 1]), r: 3, class: 'viz-spark-dot' }));
}

// ---- Matriz de calor (categoría × mes) ----------------------------------------------
// El color compara cada mes con el máximo de esa misma fila (cómo varía la categoría mes a mes).
// Cada celda muestra su monto: el color nunca es la única forma de leer el valor.
export function heatTable({ cols, rows, totals, cur, onRow, rowHeader = 'Categoría' }) {
  // sin símbolo de moneda en las celdas (lo dice el subtítulo): caben más meses en el teléfono
  const fmtC = (v) => (Math.abs(v) < 0.5 ? '–' : compactNumber(v));
  const wrap = h('div', { class: 'heat-wrap' });
  const head = h('tr', null,
    h('th', { class: 'heat-name', scope: 'col' }, rowHeader),
    cols.map(c => h('th', { scope: 'col', title: c.long }, c.short, c.year ? h('small', null, c.year) : null)),
    h('th', { scope: 'col', class: 'heat-total' }, 'Total'));
  const body = rows.map(r => {
    const mx = Math.max(0, ...r.values);
    const tr = h('tr', onRow ? { tabindex: '0', class: 'heat-row', onclick: () => onRow(r), onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } } : null,
      h('th', { scope: 'row', class: 'heat-name' },
        h('span', { class: 'heat-label' }, `${r.icon ? r.icon + ' ' : ''}${r.label}`),
        r.sub ? h('small', null, r.sub) : null),
      r.values.map((v, i) => {
        const bin = v > 0 && mx > 0 ? Math.min(5, Math.floor(v / mx * 6 - 1e-9)) : -1;
        return h('td', { class: bin >= 0 ? `h${bin}` : 'h-none', title: `${r.label} · ${cols[i].long}: ${M.fmt(v, cur)}` }, fmtC(v));
      }),
      h('td', { class: 'heat-total' }, fmtC(r.total)));
    return tr;
  });
  const foot = totals ? h('tr', { class: 'heat-foot' },
    h('th', { scope: 'row', class: 'heat-name' }, 'Total'),
    totals.map(v => h('td', null, fmtC(v))),
    h('td', { class: 'heat-total' }, fmtC(totals.reduce((a, b) => a + b, 0)))) : null;
  wrap.append(h('table', { class: 'heat' }, h('thead', null, head), h('tbody', null, body), foot ? h('tfoot', null, foot) : null));
  // empieza mostrando los meses más recientes (a la derecha)
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
  return wrap;
}

// ---- Piezas comunes -----------------------------------------------------------------
export function legend(items) {
  return h('div', { class: 'viz-legend' }, items.map(it => h('span', { class: 'viz-legend-item' },
    h('span', { class: it.kind === 'rect' ? 'viz-key-rect' : 'viz-key-line', style: { background: `var(${it.color})` } }),
    h('span', null, it.name))));
}

// Barra 100% (parte de un todo): un segmento por parte, 2px de separación del color de fondo, extremos
// redondeados, tooltip al tocar o pasar el puntero y recorrible con el teclado. Solo admite partes positivas.
export function shareBar({ segments, cur, ariaLabel }) {
  const total = segments.reduce((a, x) => a + x.value, 0);
  const tip = tooltip();
  const box = h('div', { class: 'viz-plot share-plot' });
  const bar = h('div', { class: 'share-bar', role: 'group', 'aria-label': ariaLabel });
  const pctOf = (v) => `${nf1.format(v / total * 100)}%`;
  let active = null;
  const hide = () => { tip.hide(); if (active) active.classList.remove('on'); active = null; };
  segments.forEach((sg) => {
    const el = h('button', {
      type: 'button', class: 'share-seg', style: { flexGrow: String(sg.value), background: `var(${sg.color})` },
      'aria-label': `${sg.name}: ${compactMoney(sg.value, cur)}, ${pctOf(sg.value)}`,
    });
    const show = () => {
      if (active) active.classList.remove('on');
      active = el; el.classList.add('on');
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      tip.show(box, r.left - b.left + r.width / 2, [{ key: sg.color, value: pctOf(sg.value), label: compactMoney(sg.value, cur) }], sg.name);
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('click', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
    bar.append(el);
  });
  box.append(bar, tip.el);
  return box;
}

// Tabla equivalente (accesible) de cualquier gráfico.
export function dataTable(headers, rows) {
  return h('div', { class: 'viz-table-wrap' }, h('table', { class: 'tbl viz-table' },
    h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h(i ? 'td' : 'th', { class: i ? 'r' : '', scope: i ? null : 'row' }, c)))))));
}

// Tarjeta de gráfico con título, leyenda y botón Gráfico/Tabla.
export function vizCard({ title, subtitle, legendItems, chart, table, footnote, actions }) {
  const tableBox = h('div', { hidden: true }, table);
  const chartBox = h('div', null, legendItems && legendItems.length > 1 ? legend(legendItems) : null, chart);
  let showingTable = false;
  const toggle = table ? h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', onclick: () => {
    showingTable = !showingTable;
    tableBox.hidden = !showingTable; chartBox.hidden = showingTable;
    toggle.textContent = showingTable ? 'Gráfico' : 'Tabla';
    toggle.setAttribute('aria-pressed', String(showingTable));
  } }, 'Tabla') : null;
  return h('section', { class: 'card viz' },
    h('div', { class: 'card-head' },
      h('div', null, h('h3', null, title), subtitle ? h('div', { class: 'muted small' }, subtitle) : null),
      h('div', { class: 'row-actions' }, actions, toggle)),
    chartBox, tableBox,
    footnote ? h('p', { class: 'muted small viz-foot' }, footnote) : null);
}

// Fichas de cifras: rótulo · valor · variación opcional (con signo y período nombrado).
export function statTiles(tiles) {
  return h('div', { class: 'tiles' }, tiles.filter(Boolean).map(t => h('div', { class: 'tile' },
    h('span', { class: 'tile-label' }, t.label),
    h('span', { class: 'tile-value' }, t.value),
    t.delta ? h('span', { class: 'tile-delta ' + (t.tone || '') }, t.delta) : null)));
}
