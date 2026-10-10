// Análisis para decidir (Reportes e Inicio): salud financiera con referencias chilenas, proyección de caja de
// 12 meses (con los dividendos de cada crédito y un escenario de arriendo), este año contra el anterior en
// pesos de hoy (UF), fijos vs variables y gastos fuera de lo normal.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h } from '../ui.js';
import { lineChart, vizCard, dataTable, shareBar, compactMoney, legend } from '../charts.js';
import { openCategoryDetail } from './reports.js';

const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: d }).format(x * 100)}%`);
const sgnPct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${pct(x)}`);
const months1 = (x) => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(x)} ${Math.round(x * 10) === 10 ? 'mes' : 'meses'}`;

// ---- Salud financiera ----------------------------------------------------------------------------
// Cada indicador con su estado (texto + ícono, nunca solo color) y la referencia que usa.
export function healthCard() {
  const base = M.base();
  const hi = M.healthIndicators();
  const level = (v, good, ok, lowerIsBetter) => {
    if (v == null) return null;
    const g = lowerIsBetter ? v <= good : v >= good, o = lowerIsBetter ? v <= ok : v >= ok;
    return g ? { cls: 'is-good', icon: '✓', l: 'Bien' } : o ? { cls: 'is-warn', icon: '!', l: 'Atención' } : { cls: 'is-bad', icon: '✕', l: 'Riesgo' };
  };
  // montos compactos: la tarjeta se lee de un vistazo; el detalle exacto está en cada reporte
  const c = (v) => compactMoney(v, base);
  const item = (title, value, lv, detail, ref, hint) => h('div', { class: 'health-item ' + (lv ? lv.cls : '') },
    h('div', { class: 'health-top' }, h('span', { class: 'health-title' }, title), lv ? h('span', { class: 'health-badge' }, `${lv.icon} ${lv.l}`) : null),
    h('div', { class: 'health-value' }, value),
    h('div', { class: 'health-detail' }, detail),
    lv && lv.cls !== 'is-good' && hint ? h('div', { class: 'health-hint' }, hint) : null,
    h('div', { class: 'health-ref' }, ref));
  const s = hi.savings, e = hi.emergency, m = hi.mortgage, l = hi.leverage;
  return h('section', { class: 'card health' },
    h('div', { class: 'card-head' }, h('div', null, h('h3', null, 'Salud financiera'), h('div', { class: 'muted small' }, 'Últimos 12 meses · tu parte'))),
    h('div', { class: 'health-grid' },
      item('Tasa de ahorro', pct(s.value), level(s.value, 0.2, 0.1),
        `${c(s.saved)} de ${c(s.income)} líquidos. Cuenta como ahorro lo que amortizas de los créditos (${c(s.amort)})${s.invest ? ` y tus aportes a inversiones (${c(s.invest)})` : ''}.`,
        'Referencia: 20% o más.', 'Revisa en "Este año vs el anterior" qué categorías subieron.'),
      item('Fondo de emergencia', e.value == null ? '—' : months1(e.value), level(e.value, 6, 3),
        `${c(e.liquid)} en cuentas; sales ${c(e.monthly)} al mes (gasto + dividendos).`,
        'Referencia: 3 a 6 meses.', e.monthly ? `Para 3 meses te faltan ${c(Math.max(0, 3 * e.monthly - e.liquid))}.` : null),
      item('Dividendos sobre ingreso', pct(m.value), level(m.value, 0.25, 0.3, true),
        `${c(m.dividend)} al mes de ${c(m.income)} líquidos en promedio${m.fixedOnly != null ? `; ${pct(m.fixedOnly)} sin el bono anual` : ''}.`,
        'Los bancos en Chile piden 25%, hasta 30%.', rentHint(m, c)),
      item('Endeudamiento', pct(l.value), level(l.value, 0.5, 0.8, true),
        `Debes ${c(l.debts)} de ${c(l.assets)} en activos.`,
        'Bajo 50% es holgado; los créditos hipotecarios lo suben al comienzo.')));
}

// Con el arriendo simulado abajo, la carga de los dividendos se mide sobre el líquido más el arriendo neto.
function rentHint(m, c) {
  if (!fcView.rent || !fcView.uf || !m.income) return 'Un arriendo lo baja: simúlalo abajo en la caja.';
  const net = fcView.uf * (M.rateFor('UF', M.todayStr()) || 0) * (1 - (fcView.adminPct || 0) / 100);
  return net ? `Con el arriendo simulado (${c(net)} netos al mes): ${pct(m.dividend / (m.income + net))}.` : null;
}

// ---- Proyección de caja ----------------------------------------------------------------------
// comisión típica de las administradoras de arriendo: un mes de arriendo al año (8,33%)
const fcView = { rent: false, uf: null, adminPct: 8.33, from: null, propId: null };
export function forecastCard(redraw) {
  const base = M.base();
  // por defecto la que ya tiene arriendo; si no, la más antigua (la que se suele arrendar al mudarse)
  const since = (p) => { const d = p.mortgageId && db.get('debts', p.mortgageId); return (d && d.mortgage && d.mortgage.from) || '9999'; };
  const props = M.propertySummaries().sort((a, b) => (b.rentUF ? 1 : 0) - (a.rentUF ? 1 : 0) || since(a).localeCompare(since(b)));
  const prop = props.find(p => p.id === fcView.propId) || props[0];
  if (!fcView.from) fcView.from = M.addMonths(M.curYm(), 3);
  // arriendo de partida: el anotado en la propiedad o ~0,4% mensual de su valor, en UF
  if (prop && !fcView.touched && !prop.rentUF) {
    const uf = M.rateFor('UF', M.todayStr());
    const valUF = prop.currency === 'UF' ? prop.value : uf ? prop.value * (M.rateFor(prop.currency, M.todayStr()) ?? 1) / uf : null;
    fcView.uf = valUF ? Math.max(1, Math.round(valUF * 0.004)) : (fcView.uf || 10);
  }
  if (prop && prop.rentUF && !fcView.touched) { fcView.uf = prop.rentUF; fcView.adminPct = prop.adminPct ?? fcView.adminPct; }
  const propPick = props.length > 1 ? h('select', { 'aria-label': 'Propiedad', onchange: (e) => { fcView.propId = e.target.value; fcView.touched = false; redraw(); } },
    props.map(p => h('option', { value: p.id, selected: p.id === prop.id }, p.name))) : null;
  const rent = fcView.rent ? { uf: fcView.uf, adminPct: fcView.adminPct, from: fcView.from } : null;
  const f = M.cashForecast({ months: 12, rent });
  const f0 = rent ? M.cashForecast({ months: 12 }) : null;      // sin arriendo, para comparar
  // parte en hoy (la liquidez actual) y sigue mes a mes
  const pts = [{ short: 'hoy', long: 'Hoy', ym: M.curYm() }, ...f.rows.map(r => ({ short: M.monthShort(r.ym).toLowerCase(), long: M.monthName(r.ym), ym: r.ym }))];
  const low = f.rows.reduce((a, r) => (r.balance < a.balance ? r : a), f.rows[0]);
  const c = (v) => compactMoney(v, base);
  const low0 = f0 && f0.rows.reduce((a, r) => (r.balance < a.balance ? r : a), f0.rows[0]);
  const msg = forecastMessage(f) + (f0 ? ` Sin el arriendo: ${low0.balance < 0 ? `bajaría hasta ${c(low0.balance)}` : `no baja de ${c(low0.balance)}`} y tendrías ${c(f0.rows.at(-1).balance)} (${c(f.rows.at(-1).balance - f0.rows.at(-1).balance)} menos).` : '');
  const num = (key, label, step) => h('label', { class: 'fc-field' }, h('span', null, label),
    h('input', { type: 'text', inputmode: 'decimal', value: String(fcView[key]).replace('.', ','), onchange: (e) => { const v = M.parseAmount(e.target.value); if (Number.isFinite(v)) { fcView[key] = v; fcView.touched = true; redraw(); } } }));
  const scen = prop ? h('div', { class: 'fc-scen' },
    h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: fcView.rent, onchange: (e) => { fcView.rent = e.target.checked; redraw(); } }), h('span', null, propPick ? 'Simular un arriendo' : `Simular arriendo de ${prop.name}`)),
    fcView.rent && propPick ? propPick : null,
    fcView.rent ? h('div', { class: 'fc-fields' },
      num('uf', 'Arriendo (UF)'), num('adminPct', 'Comisión (%)'),
      h('label', { class: 'fc-field' }, h('span', null, 'Desde'), h('input', { type: 'month', value: fcView.from, onchange: (e) => { if (e.target.value) { fcView.from = e.target.value; redraw(); } } }))) : null) : null;
  return vizCard({
    title: 'Caja de los próximos 12 meses',
    subtitle: 'Tus cuentas: ingresos y gastos típicos, dividendos exactos de cada crédito',
    chart: h('div', null,
      h('p', { class: 'pace-msg' + (low.balance < 0 ? ' up-bad' : '') }, msg),
      f0 ? legend([{ name: 'Con arriendo', color: '--viz-1' }, { name: 'Sin arriendo', color: '--viz-deemph', dash: true }]) : null,
      lineChart({
        points: pts, cur: base,
        series: [{ name: f0 ? 'Con arriendo' : 'Caja proyectada', values: [f.liquid, ...f.rows.map(r => r.balance)], color: '--viz-1', area: true },
          ...(f0 ? [{ name: 'Sin arriendo', values: [f0.liquid, ...f0.rows.map(r => r.balance)], color: '--viz-deemph', dash: true }] : [])],
        extra: (i) => {
          if (!i) return [{ value: M.fmt(f.liquid, base), label: 'Liquidez de hoy' }];
          const r = f.rows[i - 1];
          return [{ value: M.fmt(r.income, base), label: r.lump ? 'Ingresos (incl. el ingreso anual de este mes)' : 'Ingresos' }, { value: M.fmt(-r.spend, base), label: 'Gasto' },
            r.div ? { value: M.fmt(-r.div, base), label: 'Dividendos' } : null, r.rent ? { value: M.fmt(r.rent, base), label: 'Arriendo neto' } : null,
            { value: M.fmt(r.net, base, { sign: true }), label: 'Neto del mes' }].filter(Boolean);
        },
        ariaLabel: `Caja proyectada: ${msg}`,
      }),
      scen),
    table: dataTable(['Mes', 'Ingresos', 'Gasto', 'Dividendos', 'Arriendo', 'Neto', 'Caja'], f.rows.map(r => [M.monthName(r.ym), M.fmt(r.income, base), M.fmt(r.spend, base), M.fmt(r.div, base), M.fmt(r.rent, base), M.fmt(r.net, base, { sign: true }), M.fmt(r.balance, base)])),
    footnote: `Parte con tu liquidez de hoy (${compactMoney(f.liquid, base)}: cuentas menos tarjetas). Ingresos: ${compactMoney(f.incomeBase, base)} líquidos al mes${f.deductions ? ` (ya sin ${compactMoney(f.deductions, base)} de descuentos del sueldo)` : ''}${f.lumps.length ? ` más ${f.lumps.map(([mo, v]) => `${compactMoney(v, base)} en ${M.monthName(`2000-${mo}`).split(' ')[0].toLowerCase()}`).join(', ')} como el año pasado` : ''}. Gasto: tu parte promedio de 12 meses (${compactMoney(f.spendBase, base)}), subiendo con la inflación (${pct(f.inflation, 1)} anual). Es una estimación: no incluye compras grandes ni ingresos nuevos.`,
  });
}

// Aviso corto para Inicio si la caja proyectada se pone negativa.
// Mínimo, recuperación y cierre en una frase (montos compactos).
const monthLow = (ym) => M.monthName(ym).toLowerCase();
function forecastMessage(f, short = false) {
  const lead = short ? '' : 'Tu caja ';
  const cap = (x) => (short ? x.charAt(0).toUpperCase() + x.slice(1) : x);
  const base = M.base();
  const c = (v) => compactMoney(v, base);
  const low = f.rows.reduce((a, r) => (r.balance < a.balance ? r : a), f.rows[0]);
  const end = f.rows.at(-1);
  if (low.balance >= 0) return `${lead}${cap('no baja de')} ${c(low.balance)}; en 12 meses tendrías ${c(end.balance)}.`;
  const back = f.rows.find(r => r.ym > low.ym && r.balance >= 0);
  const backName = back && (back.ym.slice(0, 4) === low.ym.slice(0, 4) ? monthLow(back.ym).split(' ')[0] : monthLow(back.ym));
  return `${lead}${cap('bajaría')} hasta ${c(low.balance)} en ${monthLow(low.ym)}${back ? ` y volvería a positivo en ${backName}` : ''}; en 12 meses: ${c(end.balance)}.`;
}

// Aviso corto para Inicio si la caja proyectada se pone negativa; se puede ocultar hasta el mes siguiente.
const HIDE = 'moni.fcAlertHidden';
export function forecastAlert() {
  try { if (localStorage.getItem(HIDE) === M.curYm()) return null; } catch { /* ignore */ }
  const f = M.cashForecast({ months: 12 });
  if (!f.incomeBase) return null;                              // sin historial de ingresos no hay proyección útil
  const neg = f.rows.find(r => r.balance < 0);
  if (!neg) return null;
  const card = h('section', { class: 'card alert-card' },
    h('div', { class: 'title' }, `⚠️ Tu caja quedaría en negativo desde ${monthLow(neg.ym)}`),
    h('div', { class: 'small' }, forecastMessage(f, true)),
    h('div', { class: 'card-foot' },
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { try { localStorage.setItem(HIDE, M.curYm()); } catch { /* ignore */ } card.remove(); } }, 'Ocultar este mes'),
      h('a', { class: 'btn small', href: '#/reportes', onclick: () => { try { sessionStorage.setItem('moni.reportView', 'analysis'); } catch { /* ignore */ } } }, 'Ver proyección')));
  return card;
}

// ---- Este año vs el anterior --------------------------------------------------------------------
export function yoyCard(mode) {
  const base = M.base();
  const y = M.yearOverYear({ mode, real: true });
  if (!y || !y.rows.length || !y.before) return null;
  const top = y.rows.filter(r => Math.abs(r.diff) >= 1).slice(0, 8);
  const max = Math.max(1, ...top.map(r => Math.abs(r.diff)));
  const range = `${M.monthShort(y.months[0]).toLowerCase()}–${M.monthShort(y.months.at(-1)).toLowerCase()}`;
  const total = (y.now / y.before) - 1;
  return vizCard({
    title: `Este año vs el anterior (${range})`,
    subtitle: `En pesos de hoy (UF) · ${mode === 'mine' ? 'mi parte' : 'hogar'} · lo que más cambió`,
    legendItems: [{ name: 'Gastaste más', color: '--viz-2', kind: 'rect' }, { name: 'Gastaste menos', color: '--viz-1', kind: 'rect' }],
    chart: h('div', null,
      h('p', { class: 'pace-msg' + (total > 0.05 ? ' up-bad' : total < -0.05 ? ' down-good' : '') },
        `${compactMoney(y.now, base)} este año contra ${compactMoney(y.before, base)} el anterior en los mismos meses: ${sgnPct(total)} real.`),
      h('div', { class: 'div-list' }, top.map(r => h('button', { type: 'button', class: 'div-row yoy', onclick: () => r.catId && openCategoryDetail({ catId: r.catId, kind: 'expense', mode, period: '24' }) },
        h('div', { class: 'div-name' }, h('span', null, `${r.icon ? r.icon + ' ' : ''}${r.label}`), h('small', null, `${compactMoney(r.before, base)} → ${compactMoney(r.now, base)}`)),
        h('div', { class: 'div-track', 'aria-hidden': 'true' }, h('span', { class: 'div-zero' }),
          h('span', { class: 'div-bar', style: { width: Math.abs(r.diff) / max * 50 + '%', [r.diff >= 0 ? 'left' : 'right']: '50%', background: `var(${r.diff >= 0 ? '--viz-2' : '--viz-1'})` } })),
        h('div', { class: 'div-val' }, `${r.diff > 0 ? '+' : ''}${compactMoney(r.diff, base)}`))))),
    table: dataTable(['Categoría', 'Año anterior', 'Este año', 'Diferencia'], y.rows.map(r => [r.label, M.fmt(r.before, base), M.fmt(r.now, base), M.fmt(r.diff, base, { sign: true })])),
    footnote: 'Cada mes se lleva a pesos de hoy con la UF, así la inflación no hace parecer que todo subió. Toca una categoría para ver su detalle.',
  });
}

// ---- Fijos vs variables ----------------------------------------------------------------------
// Fijos: las cuentas que se pagan todos los meses (detectadas) y los dividendos. Variables: el resto,
// que es lo que se puede ajustar.
export function fixedVarCard(months, mode) {
  const base = M.base();
  const fixedCats = new Set(M.recurringBills().map(b => b.catId));
  for (const c of M.categories()) if (c.debtId) fixedCats.add(c.id);
  const mx = M.categoryMatrix(months, { mode });
  const fixed = months.map((_, i) => mx.rows.filter(r => fixedCats.has(r.catId)).reduce((a, r) => a + r.values[i], 0));
  const vari = months.map((_, i) => mx.totals[i] - fixed[i]);
  const F = fixed.reduce((a, v) => a + v, 0), V = vari.reduce((a, v) => a + v, 0);
  if (!fixedCats.size || F + V <= 0) return null;
  return vizCard({
    title: 'Fijos y variables',
    subtitle: 'Fijos: cuentas de todos los meses y dividendos · variables: lo que puedes ajustar',
    legendItems: [{ name: 'Fijos', color: '--viz-1' }, { name: 'Variables', color: '--viz-2' }],
    chart: h('div', null,
      shareBar({ segments: [{ name: 'Fijos', value: F, color: '--viz-1' }, { name: 'Variables', value: V, color: '--viz-2' }].filter(x => x.value > 0), cur: base, ariaLabel: `Fijos ${pct(F / (F + V))}, variables ${pct(V / (F + V))}` }),
      h('p', { class: 'small' }, `Fijos ${pct(F / (F + V))} (${compactMoney(F / months.length, base)} al mes) · variables ${pct(V / (F + V))} (${compactMoney(V / months.length, base)} al mes).`),
      lineChart({
        points: months.map(ym => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), ym })), cur: base, height: 190,
        series: [{ name: 'Fijos', values: fixed, color: '--viz-1' }, { name: 'Variables', values: vari, color: '--viz-2' }],
        ariaLabel: 'Gastos fijos y variables por mes',
      })),
    table: dataTable(['Mes', 'Fijos', 'Variables'], months.map((ym, i) => [M.monthName(ym), M.fmt(fixed[i], base), M.fmt(vari[i], base)]).reverse()),
    footnote: `Fijos detectados: ${[...fixedCats].map(id => (M.category(id) || {}).name).filter(Boolean).join(', ')}.`,
  });
}

// ---- Gastos fuera de lo normal (Inicio) -------------------------------------------------------------
export function unusualCard(ym, mode) {
  const base = M.base();
  const list = M.unusualSpending(ym, mode).slice(0, 4);
  if (!list.length) return null;
  return h('section', { class: 'card' },
    h('h3', null, `Fuera de lo normal en ${M.monthName(ym).split(' ')[0].toLowerCase()}`),
    list.map(u => h('button', { class: 'row', onclick: () => openCategoryDetail({ catId: u.catId, kind: 'expense', mode, period: '12' }) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${u.icon ? u.icon + ' ' : ''}${u.label}`),
        h('div', { class: 'sub' }, `típico ${M.fmt(u.typical, base)} al mes`)),
      h('div', { class: 'amt' }, h('div', null, M.fmt(u.now, base)), h('div', { class: 'sub neg' }, `▲ ${M.fmt(u.excess, base)}`)))));
}
