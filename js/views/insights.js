// Visualizaciones que ayudan a decidir: ritmo de gasto del mes, patrimonio en el tiempo, calendario de
// registros (días que quedaron sin registrar), distribución de las inversiones y si le ganan a la UF.
// Siguen las reglas de los gráficos de la app (charts.js): marcas finas, tooltip, tabla equivalente,
// colores validados en modo claro y oscuro.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal } from '../ui.js';
import { lineChart, vizCard, dataTable, shareBar } from '../charts.js';
import { txRow } from './txs.js';
import { openTxForm } from './add.js';

const pct1 = (x) => `${x > 0 ? '+' : ''}${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(x * 100)}%`;
const dLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

// ---- Ritmo de gasto del mes (Inicio) -------------------------------------------------------------
// ¿Voy gastando más o menos que un mes normal a esta altura? Acumulado día a día contra la mediana de los
// 6 meses anteriores a la misma fecha.
export function paceCard(ym, mode) {
  const base = M.base();
  const p = M.spendPace(ym, mode);
  if (!p.upTo || !p.typical.some(v => v)) return null;
  const n = p.days.length;
  const mon = M.monthShort(ym).toLowerCase();
  const points = p.days.map((_, i) => ({ short: String(i + 1), long: `${i + 1} ${mon}` }));
  const now = p.days.map((v, i) => (i < p.upTo ? v : null));
  const at = p.upTo - 1;
  const diff = p.days[at] - p.typical[at];
  const rel = p.typical[at] ? diff / p.typical[at] : 0;
  const current = ym === M.curYm();
  const near = Math.abs(rel) < 0.05;
  const msg = near ? `Vas en línea con un mes típico${current ? ' a esta altura' : ''}.`
    : `${current ? 'Vas' : 'Terminó'} ${M.fmt(Math.abs(diff), base)} ${diff > 0 ? 'sobre' : 'bajo'} un mes típico${current ? ` al día ${p.upTo}` : ''} (${pct1(rel)}).`;
  // a comienzo de mes un mes típico ya pagó sus cuentas fijas: decir cuánto falta de ellas
  const bills = current ? M.pendingItems(ym).items.filter(i => i.type === 'bill') : [];
  const billSum = bills.reduce((a, b) => a + b.median, 0);
  const billMsg = bills.length && diff < 0 ? ` Faltan cuentas fijas por ~${M.fmt(billSum, base)} (${bills.slice(0, 3).map(b => b.cat.name).join(', ')}${bills.length > 3 ? '…' : ''}).` : '';
  return vizCard({
    title: `Ritmo de gasto de ${M.monthName(ym).split(' ')[0].toLowerCase()}${mode === 'mine' ? ' (mi parte)' : ''}`,
    subtitle: 'Acumulado día a día vs. un mes típico (mediana de los 6 meses anteriores)',
    legendItems: [{ name: current ? 'Este mes' : M.monthName(ym), color: '--viz-1' }, { name: 'Mes típico', color: '--viz-deemph', dash: true }],
    chart: h('div', null,
      h('p', { class: 'pace-msg' + (near ? '' : diff > 0 ? ' up-bad' : ' down-good') }, msg, billMsg ? h('span', { class: 'muted' }, billMsg) : null),
      lineChart({
        points, cur: base, height: 190,
        series: [{ name: current ? 'Este mes' : M.monthName(ym), values: now, color: '--viz-1', area: true }, { name: 'Mes típico', values: p.typical, color: '--viz-deemph', dash: true }],
        ariaLabel: `Gasto acumulado: ${M.fmt(p.days[at], base)} al día ${p.upTo}, mes típico ${M.fmt(p.typical[at], base)}`,
      })),
    table: dataTable(['Día', current ? 'Este mes' : M.monthName(ym), 'Mes típico'], points.map((pt, i) => [pt.long, now[i] == null ? '—' : M.fmt(now[i], base), M.fmt(p.typical[i], base)])),
    footnote: `Mes típico completo: ${M.fmt(p.typicalTotal, base)}. Solo gastos (sin inversiones, préstamos ni ajustes); las devoluciones restan.`,
  });
}

// ---- Patrimonio en el tiempo (Inicio › Patrimonio) ------------------------------------------------
export function netWorthTrend(months = 13) {
  const cur = M.curYm();
  const list = M.monthsBetween(M.addMonths(cur, -(months - 1)), cur);
  return M.netWorthHistory(list).map(p => p.total);
}

const nwView = { span: '36' };
export function openNetWorth() {
  const body = h('div');
  const base = M.base();
  const draw = () => {
    const cur = M.curYm();
    const first = [M.firstInvestmentMonth(), ...db.all('tx').map(t => t.date.slice(0, 7))].filter(Boolean).sort()[0] || cur;
    let months = M.monthsBetween(first, cur);
    if (nwView.span !== 'all') months = months.slice(-Number(nwView.span));
    const hist = M.netWorthHistory(months);
    const last = hist.at(-1), yearAgo = hist.length > 12 ? hist.at(-13) : hist[0];
    const seg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'Período' }, [['12', '1 año'], ['36', '3 años'], ['all', 'Todo']].map(([v, l]) => h('button', {
      type: 'button', class: nwView.span === v ? 'on' : '', 'aria-pressed': String(nwView.span === v), onclick: () => { nwView.span = v; draw(); },
    }, l)));
    // el mes con la mayor caída o subida, para explicar los saltos
    let jump = null;
    for (let k = 1; k < hist.length; k++) { const d = hist[k].total - hist[k - 1].total; if (!jump || Math.abs(d) > Math.abs(jump.d)) jump = { k, d }; }
    const comp = (key) => hist.map(p => p[key]);
    // los movimientos que explican el mayor salto (suele ser algo mal clasificado: un depósito a plazo como
    // gasto o su rescate como ingreso, la compra de un activo como gasto)
    const big = jump && Math.abs(jump.d) > Math.abs(last.total) * 0.15
      ? M.sortTx(db.all('tx').filter(t => t.date.slice(0, 7) === hist[jump.k].ym && (t.kind === 'out' || t.kind === 'in')))
        .sort((a, b) => M.txBase(b) - M.txBase(a)).slice(0, 3)
      : [];
    const liquid = M.accounts().filter(a => a.type !== 'credit' && M.currencyInfo(a.currency).convertible !== false)
      .reduce((s, a) => s + (M.accountBalances().get(a.id) || 0) * (M.rateFor(a.currency, M.todayStr()) ?? 1), 0);
    const typical = M.spendPace(M.addMonths(cur, -1), 'total').typicalTotal;
    fill(body,
      h('div', { class: 'filters' }, seg),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, 'Hoy'), h('span', { class: 'tile-value' }, M.fmt(last.total, base))),
        h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, hist.length > 12 ? 'Hace 12 meses' : `Desde ${M.monthName(hist[0].ym).toLowerCase()}`),
          h('span', { class: 'tile-value' }, M.fmt(yearAgo.total, base)),
          h('span', { class: 'tile-delta ' + (last.total >= yearAgo.total ? 'up-good' : 'down-bad') }, `${M.fmt(last.total - yearAgo.total, base, { sign: true })}`)),
        typical > 0 ? h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, 'Liquidez en cuentas'),
          h('span', { class: 'tile-value' }, `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(Math.max(0, liquid) / typical)} meses`),
          h('span', { class: 'tile-delta' }, `de gasto típico (${M.fmt(typical, base)})`)) : null),
      vizCard({
        title: 'Patrimonio neto',
        subtitle: `En ${base} al cierre de cada mes · cuentas + tarjetas + inversiones + propiedades − deudas`,
        chart: lineChart({
          points: months.map(ym => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), ym })), cur: base,
          series: [{ name: 'Patrimonio', values: comp('total'), color: '--viz-1', area: true }],
          extra: (i) => [
            { value: M.fmt(hist[i].cash + hist[i].cards, base), label: 'Cuentas y tarjetas' },
            { value: M.fmt(hist[i].inv, base), label: 'Inversiones' },
            hist[i].props ? { value: M.fmt(hist[i].props, base), label: 'Propiedades' } : null,
            hist[i].debts ? { value: M.fmt(hist[i].debts, base), label: 'Deudas' } : null].filter(Boolean),
          ariaLabel: `Patrimonio neto: ${M.fmt(last.total, base)} hoy`,
        }),
        table: dataTable(['Mes', 'Patrimonio', 'Cuentas', 'Tarjetas', 'Inversiones', 'Propiedades', 'Deudas'],
          hist.map(p => [M.monthName(p.ym), M.fmt(p.total, base), M.fmt(p.cash, base), M.fmt(p.cards, base), M.fmt(p.inv, base), M.fmt(p.props, base), M.fmt(p.debts, base)]).reverse()),
        footnote: (jump && Math.abs(jump.d) > Math.abs(last.total) * 0.15
          ? `El mayor cambio fue en ${M.monthName(hist[jump.k].ym).toLowerCase()} (${M.fmt(jump.d, base, { sign: true })}). Si fue una compra de un activo registrada como gasto, márcala como Inversión en su categoría. `
          : '') + 'No incluye puntos y millas; las deudas excluidas del patrimonio tampoco.',
      }),
      big.length ? h('section', { class: 'card' },
        h('h3', null, `Lo que movió ${M.monthName(hist[jump.k].ym).toLowerCase()}`),
        h('p', { class: 'muted small' }, 'Si un depósito a plazo está como "Inversión" pero no en una inversión, o su rescate como "Ingreso", el patrimonio salta. Asocia esa categoría a una inversión (Más › Categorías) o corrige el movimiento.'),
        h('div', { class: 'list' }, big.map(t => txRow(t, { showDate: true })))) : null);
  };
  const unsub = db.subscribe(draw);
  modal('Patrimonio en el tiempo', body, { wide: true, onClose: unsub });
  draw();
}

// ---- Calendario de registros (Movimientos) ------------------------------------------------------
// Las últimas semanas día por día: más oscuro = más movimientos registrados; los días vacíos quedan
// marcados para ver qué se olvidó anotar. Un toque abre el día y permite registrar con esa fecha.
const WEEKS = 12;
export function entryCalendar() {
  const today = M.todayStr();
  const dow = (d) => (new Date(d + 'T12:00:00').getDay() + 6) % 7;      // lunes = 0
  const start = M.addDays(today, -(WEEKS - 1) * 7 - dow(today));
  const counts = M.entryCounts(start, today);
  const max = Math.max(1, ...counts.values());
  const bin = (n) => (!n ? -1 : Math.min(5, Math.ceil(n / max * 6) - 1));
  const empty = [];
  const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': `Registros por día de las últimas ${WEEKS} semanas` });
  for (let r = 0; r < 7; r++) grid.append(h('span', { class: 'cal-dow', 'aria-hidden': 'true' }, 'LMMJVSD'[r]));
  for (let k = 0; k < WEEKS * 7; k++) {
    const d = M.addDays(start, k);
    const pos = { gridRow: String(dow(d) + 1), gridColumn: String(Math.floor(k / 7) + 2) };
    if (d > today) { grid.append(h('span', { class: 'cal-cell future', style: pos })); continue; }
    const n = counts.get(d) || 0;
    if (!n) empty.push(d);
    const b = bin(n);
    grid.append(h('button', {
      type: 'button', class: `cal-cell${b < 0 ? ' none' : ' h' + b}${d === today ? ' today' : ''}`,
      style: pos,
      'aria-label': `${dLong(d)}: ${n ? `${n} movimiento${n === 1 ? '' : 's'}` : 'sin registros'}`,
      onclick: () => openDay(d),
    }));
  }
  const recent = empty.filter(d => d >= M.addDays(today, -14) && d < today);
  return h('section', { class: 'card viz cal-card' },
    h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Constancia de registro'),
      h('div', { class: 'muted small' }, `Últimas ${WEEKS} semanas · más oscuro = más movimientos`))),
    grid,
    h('div', { class: 'cal-legend muted small' }, h('span', { class: 'cal-cell none' }), ' sin registros', h('span', { class: 'cal-cell h1' }), h('span', { class: 'cal-cell h3' }), h('span', { class: 'cal-cell h5' }), ' más'),
    h('p', { class: 'small' }, recent.length
      ? `${recent.length} día${recent.length === 1 ? '' : 's'} sin registros en las últimas dos semanas. Toca un día para revisarlo o registrar con esa fecha.`
      : 'Sin días vacíos en las últimas dos semanas. Toca un día para ver lo registrado.'));
}

function openDay(d) {
  const txs = M.sortTx(db.all('tx').filter(t => t.date === d));
  const m = modal(dLong(d).replace(/^./, c => c.toUpperCase()), h('div', null,
    txs.length ? h('div', { class: 'list' }, txs.map(t => txRow(t))) : h('p', { class: 'empty' }, 'Este día no tiene movimientos registrados.')), {
    actions: [h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => { m.close(); openTxForm(null, { date: d }); } }, '＋ Registrar en este día')],
  });
}

// ---- Distribución de las inversiones (Inversiones) ---------------------------------------------
const SLOTS = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5'];
function shareSection(title, parts, base) {
  const total = parts.reduce((a, x) => a + x.value, 0);
  if (!total || parts.length < 1) return null;
  const segs = parts.map((x, i) => ({ ...x, color: SLOTS[Math.min(i, SLOTS.length - 1)] }));
  const pct = (v) => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(v / total * 100)}%`;
  return h('div', { class: 'alloc-block' },
    h('div', { class: 'label' }, title),
    shareBar({ segments: segs, cur: base, ariaLabel: `${title}: ${segs.map(s => `${s.name} ${pct(s.value)}`).join(', ')}` }),
    h('div', { class: 'share-legend' }, segs.map(sg => h('div', { class: 'share-row' },
      h('span', { class: 'viz-key-rect', style: { background: `var(${sg.color})` } }),
      h('span', { class: 's-name' }, sg.name), h('span', { class: 's-amt' }, M.fmt(sg.value, base)), h('span', { class: 's-pct' }, pct(sg.value))))));
}

export function allocationCard() {
  const base = M.base();
  const today = M.todayStr();
  const funds = M.investmentSummaries().filter(f => M.currencyInfo(f.currency).convertible !== false && f.balance > 0);
  if (funds.length < 2) return null;
  const val = (f) => f.balance * (M.rateFor(f.currency, today) ?? 1);
  const group = (keyOf, label) => {
    const m = new Map();
    for (const f of funds) { const k = keyOf(f); m.set(k, (m.get(k) || 0) + val(f)); }
    return [...m.entries()].map(([k, v]) => ({ name: label(k), value: v })).sort((a, b) => b.value - a.value);
  };
  const KIND = { stock: 'Acciones', etf: 'ETF', ffmm: 'Fondos mutuos', crypto: 'Cripto', other: 'Otros' };
  const byCur = group(f => f.currency, k => (k === base ? `Pesos (${k})` : k === 'USD' || k === 'MUSD' ? 'Dólares' : k));
  const byHz = group(f => f.horizon || 'short', k => (k === 'long' ? 'Largo plazo' : 'Corto / mediano plazo'));
  const byKind = group(f => (M.isUnits(f) ? f.assetKind || 'other' : /afp|apv/i.test(f.name) ? 'pension' : 'fund'), k => (k === 'pension' ? 'Previsión (AFP, APV)' : k === 'fund' ? 'Fondos por valor' : KIND[k] || k));
  const all = [...byCur, ...byHz, ...byKind];
  return vizCard({
    title: 'Distribución de tus inversiones',
    subtitle: `Valor actual en ${base}: ¿qué tan concentrado estás en una moneda, un plazo o un tipo?`,
    // una sección que reparte igual que otra ya mostrada no agrega información (hoy: AFP y APV son pesos,
    // largo plazo y previsión a la vez)
    chart: h('div', null, (() => {
      const seen = new Set();
      return [['Por moneda', byCur], ['Por plazo', byHz], ['Por tipo', byKind]].map(([t, parts]) => {
        const sig = parts.map(x => Math.round(x.value)).join('|');
        if (parts.length < 2 || seen.has(sig)) return null;
        seen.add(sig);
        return shareSection(t, parts, base);
      });
    })()),
    table: dataTable(['Grupo', 'Valor'], all.map(x => [x.name, M.fmt(x.value, base)])),
    footnote: 'Los dólares se valorizan al tipo de cambio de hoy. Puntos y millas no se incluyen.',
  });
}

// ---- ¿Le ganan a la UF? (Inversiones) -----------------------------------------------------------
// Rentabilidad anual de cada inversión contra lo que subió la UF en el mismo período. Barra divergente desde
// cero: lo que ganó por sobre la inflación (azul) o lo que perdió frente a ella (naranja), con el valor escrito.
export function inflationCard() {
  const rows = M.returnsVsInflation();
  if (!rows.length) return null;
  const max = Math.max(0.01, ...rows.map(r => Math.abs(r.real)));
  const bar = (r) => {
    const w = Math.abs(r.real) / max * 50;
    return h('div', { class: 'div-track', 'aria-hidden': 'true' },
      h('span', { class: 'div-zero' }),
      h('span', { class: 'div-bar', style: { width: w + '%', [r.real >= 0 ? 'left' : 'right']: '50%', background: `var(${r.real >= 0 ? '--viz-1' : '--viz-2'})` } }));
  };
  return vizCard({
    title: '¿Le ganan a la inflación?',
    subtitle: 'Rentabilidad anual de cada inversión menos lo que subió la UF en el mismo período (rentabilidad real)',
    legendItems: [{ name: 'Sobre la UF', color: '--viz-1', kind: 'rect' }, { name: 'Bajo la UF', color: '--viz-2', kind: 'rect' }],
    chart: h('div', { class: 'div-list' }, rows.map(r => h('div', { class: 'div-row', title: `${r.name}: ${pct1(r.ret)} anual; UF ${pct1(r.uf)} anual desde ${r.since}` },
      h('div', { class: 'div-name' }, h('span', null, r.name), h('small', null, `${pct1(r.ret)} vs UF ${pct1(r.uf)}${r.currency !== M.base() ? ` · en ${r.currency}` : ''}`)),
      bar(r),
      h('div', { class: 'div-val' }, pct1(r.real))))),
    table: dataTable(['Inversión', 'Anual', 'UF anual', 'Real', 'Desde'], rows.map(r => [r.name, pct1(r.ret), pct1(r.uf), pct1(r.real), r.since])),
    footnote: 'Rentabilidad anual con los aportes y retiros en sus fechas (tasa interna de retorno). Las inversiones en dólares se miden en dólares: la UF es la vara en pesos, compárala con cuidado.',
  });
}

