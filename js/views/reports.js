// Reportes: gasto (o ingreso) por categoría mes a mes, y detalle de una categoría.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal } from '../ui.js';
import { columnChart, heatTable, vizCard, dataTable, statTiles, compactMoney } from '../charts.js';
import { txRow } from './txs.js';
import { editCategory } from './settings.js';

const st = { period: '12', kind: 'expense', mode: 'total', by: 'category' };

// Meses de un período: últimos N meses (incluido el actual) o un año calendario.
export function monthsOf(period) {
  const cur = M.curYm();
  if (/^\d{4}$/.test(period)) {
    const end = period === cur.slice(0, 4) ? cur : `${period}-12`;
    return M.monthsBetween(`${period}-01`, end);
  }
  const n = Number(period) || 12;
  return M.monthsBetween(M.addMonths(cur, -(n - 1)), cur);
}

const monthLabel = (ym) => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), ym });

// Promedio de los meses ya cerrados (el mes en curso está incompleto y lo bajaría).
function closedAverage(months, values) {
  const cur = M.curYm();
  const idx = months.map((m, i) => i).filter(i => months[i] !== cur);
  if (!idx.length) return 0;
  return idx.reduce((a, i) => a + values[i], 0) / idx.length;
}

const pct = (a, b) => (b ? Math.round((a / b - 1) * 100) : 0);
const signed = (n) => (n > 0 ? '+' : '') + n + '%';

function filterRow(onChange) {
  const ps = M.people();
  const periodSel = h('select', { 'aria-label': 'Período' },
    [['6', 'Últimos 6 meses'], ['12', 'Últimos 12 meses'], ['24', 'Últimos 24 meses'], ...M.txYears().map(y => [y, `Año ${y}`])]
      .map(([v, l]) => h('option', { value: v, selected: st.period === v }, l)));
  periodSel.addEventListener('change', () => { st.period = periodSel.value; onChange(); });
  const seg = (key, opts, label) => h('div', { class: 'seg small', role: 'group', 'aria-label': label }, opts.map(([v, l]) => h('button', {
    type: 'button', class: st[key] === v ? 'on' : '', 'aria-pressed': String(st[key] === v), onclick: () => { st[key] = v; onChange(); },
  }, l)));
  return h('div', { class: 'filters' }, periodSel,
    seg('kind', [['expense', 'Gastos'], ['income', 'Ingresos']], 'Tipo'),
    ps.length > 1 ? seg('mode', [['total', 'Hogar'], ['mine', 'Mi parte']], 'Alcance') : null,
    seg('by', [['category', 'Categorías'], ['group', 'Grupos']], 'Agrupar'));
}

export function renderReports(root) {
  const months = monthsOf(st.period);
  const base = M.base();
  const mx = M.categoryMatrix(months, { kind: st.kind, mode: st.mode, by: st.by });
  const isExp = st.kind === 'expense';
  const noun = isExp ? 'Gasto' : 'Ingreso';
  const cur = M.curYm();
  const avg = closedAverage(months, mx.totals);
  const total = mx.totals.reduce((a, b) => a + b, 0);
  const lastClosed = months.filter(m => m !== cur).at(-1);
  const lastVal = lastClosed ? mx.totals[months.indexOf(lastClosed)] : 0;
  const partial = months.includes(cur);

  const items = months.map((ym, i) => ({
    ...monthLabel(ym), value: mx.totals[i], partial: ym === cur,
    note: `${mx.counts[i]} mov.${ym === cur ? ' · mes en curso' : avg ? ` · ${signed(pct(mx.totals[i], avg))} vs promedio` : ''}`,
  }));

  const monthly = vizCard({
    title: `${noun} por mes`,
    subtitle: `${st.mode === 'mine' ? 'Mi parte' : 'Hogar'} · ${months.length} meses`,
    chart: columnChart({ items, cur: base, reference: avg || null, ariaLabel: `${noun} por mes. Promedio ${M.fmt(avg, base)}` }),
    table: dataTable(['Mes', noun, 'Movimientos'], months.map((ym, i) => [M.monthName(ym), M.fmt(mx.totals[i], base), String(mx.counts[i])])),
    footnote: partial ? 'El último mes está en curso; el promedio considera solo meses cerrados.' : null,
  });

  const cols = months.map((ym, i) => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), year: (i === 0 || ym.endsWith('-01')) ? ym.slice(2, 4) : null }));
  const rows = mx.rows.map(r => ({ ...r, sub: `prom. ${compactMoney(r.total / months.length, base)}` }));
  const matrix = vizCard({
    title: `${noun} por ${st.by === 'group' ? 'grupo' : 'categoría'}, mes a mes`,
    subtitle: `Montos en ${base} · toca una fila para ver su detalle`,
    chart: rows.length
      ? heatTable({ cols, rows, totals: mx.totals, cur: base, rowHeader: st.by === 'group' ? 'Grupo' : 'Categoría', onRow: (r) => openCategoryDetail({ catId: r.catId, group: r.group, kind: st.kind, mode: st.mode, period: st.period }) })
      : h('p', { class: 'empty' }, `Sin ${isExp ? 'gastos' : 'ingresos'} en este período.`),
    footnote: rows.length ? 'El color compara cada mes con el mayor mes de esa misma fila: muestra cómo varía cada una en el tiempo.' : null,
  });

  fill(root,
    filterRow(() => renderReports(root)),
    statTiles([
      { label: 'Promedio mensual', value: M.fmt(avg, base) },
      { label: `Total ${months.length} meses`, value: M.fmt(total, base) },
      lastClosed ? { label: M.monthName(lastClosed), value: M.fmt(lastVal, base), delta: avg ? `${signed(pct(lastVal, avg))} vs promedio` : null, tone: avg && lastVal > avg ? (isExp ? 'up-bad' : 'up-good') : (isExp ? 'down-good' : 'down-bad') } : null,
    ]),
    monthly,
    matrix);
}

// ---- Detalle de una categoría (o grupo) -------------------------------------------
export function openCategoryDetail({ catId = null, group = null, kind = 'expense', mode = 'total', period = '12' } = {}) {
  const base = M.base();
  const cat = catId ? M.category(catId) : null;
  const title = cat ? `${cat.icon ? cat.icon + ' ' : ''}${cat.name}` : (group || 'Detalle');
  const ds = { period, month: null, limit: 80 };
  const body = h('div');
  const inGroup = (t) => { const c = M.category(t.categoryId); return c && (c.group || 'Otras') === group; };
  const mine = (t) => (t.kind === 'out' || t.kind === 'in') && (catId ? (M.category(t.categoryId) || {}).id === catId : inGroup(t));
  // "Todo": desde el primer movimiento de la categoría (o del grupo)
  const firstMonth = () => {
    let first = null;
    for (const t of db.all('tx')) if (mine(t) && (!first || t.date < first)) first = t.date;
    return first ? first.slice(0, 7) : M.curYm();
  };
  const draw = () => {
    const months = ds.period === 'all' ? M.monthsBetween(firstMonth(), M.curYm()) : monthsOf(ds.period);
    const mx = M.categoryMatrix(months, { kind, mode, by: catId ? 'category' : 'group' });
    const row = mx.rows.find(r => (catId ? r.catId === catId : r.group === group));
    const values = row ? row.values : months.map(() => 0);
    const counts = row ? row.counts : months.map(() => 0);
    const total = values.reduce((a, b) => a + b, 0);
    const avg = closedAverage(months, values);
    const cur = M.curYm();
    const lastClosed = months.filter(m => m !== cur).at(-1);
    const lastVal = lastClosed ? values[months.indexOf(lastClosed)] : 0;
    const isExp = kind === 'expense';
    const sel = ds.month && months.includes(ds.month) ? months.indexOf(ds.month) : -1;
    const items = months.map((ym, i) => ({
      ...monthLabel(ym), value: values[i], partial: ym === cur,
      note: `${counts[i]} mov.${avg && ym !== cur ? ` · ${signed(pct(values[i], avg))} vs promedio` : ''}`,
    }));
    // movimientos de la categoría (o del grupo) en el período, o en el mes elegido
    // incluye las categorías combinadas en esta (sus movimientos ya suman aquí en la matriz)
    const txs = M.sortTx(db.all('tx').filter(t => mine(t)
      && (sel >= 0 ? t.date.slice(0, 7) === months[sel] : t.date.slice(0, 7) >= months[0])));
    const periodSeg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'Período' }, [['6', '6 m'], ['12', '12 m'], ['24', '24 m'], ['60', '5 años'], ['all', 'Todo']].map(([v, l]) => h('button', {
      type: 'button', class: ds.period === v ? 'on' : '', 'aria-pressed': String(ds.period === v), onclick: () => { ds.period = v; ds.month = null; ds.limit = 80; draw(); },
    }, l)));
    const catNow = catId ? M.category(catId) : null;
    fill(body,
      h('div', { class: 'filters' }, periodSeg,
        // p. ej. una compra puntual de un activo marcada como gasto: cambiar su naturaleza la saca de los reportes
        catNow ? h('button', { class: 'btn small', type: 'button', onclick: () => editCategory(catNow) }, 'Editar categoría') : null),
      catNow && catNow.kind !== kind ? h('p', { class: 'warn' }, `Esta categoría ahora es de tipo "${({ expense: 'Gasto', income: 'Ingreso', loan: 'Préstamo', invest: 'Inversión', adjust: 'Ajuste' })[catNow.kind]}" y ya no entra en los reportes de ${kind === 'expense' ? 'gastos' : 'ingresos'}.`) : null,
      statTiles([
        { label: 'Promedio mensual', value: M.fmt(avg, base) },
        { label: ds.period === 'all' ? `Total desde ${M.monthName(months[0]).toLowerCase()}` : `Total ${months.length} meses`, value: M.fmt(total, base) },
        lastClosed ? { label: M.monthName(lastClosed), value: M.fmt(lastVal, base), delta: avg ? `${signed(pct(lastVal, avg))} vs promedio` : null, tone: lastVal > avg ? (isExp ? 'up-bad' : 'up-good') : (isExp ? 'down-good' : 'down-bad') } : null,
      ]),
      vizCard({
        title: 'Por mes',
        subtitle: sel >= 0 ? `Mostrando ${M.monthName(months[sel])} · toca de nuevo para ver todo` : 'Toca un mes para ver sus movimientos',
        chart: columnChart({
          items, cur: base, reference: avg || null, highlight: sel,
          ariaLabel: `${title} por mes`,
          onPick: (i) => { ds.month = ds.month === months[i] ? null : months[i]; ds.limit = 80; draw(); },
        }),
        table: dataTable(['Mes', 'Monto', 'Movimientos'], months.map((ym, i) => [M.monthName(ym), M.fmt(values[i], base), String(counts[i])])),
      }),
      h('h4', null, sel >= 0 ? `Movimientos de ${M.monthName(months[sel])}` : `Movimientos (${txs.length})`),
      txs.length ? txs.slice(0, ds.limit).map(t => txRow(t, { showDate: true })) : h('p', { class: 'empty' }, 'Sin movimientos.'),
      txs.length > ds.limit ? h('div', { class: 'center' }, h('button', { class: 'btn', type: 'button', onclick: () => { ds.limit += 200; draw(); } },
        `Ver más (${ds.limit} de ${txs.length})`)) : null);
  };
  const unsub = db.subscribe(draw);
  modal(title, body, { wide: true, onClose: unsub });
  draw();
}
