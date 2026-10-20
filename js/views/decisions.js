// Herramientas para decidir: prepagar un crédito, arrendar o vender una propiedad, el resumen de un mes,
// metas de ahorro (y lo que conviene apartar para los gastos que no son mensuales) y el patrimonio a 10 años.
// Los campos se crean una sola vez y solo se recalcula el resultado (en el iPhone, recrear un campo mientras se
// usa cierra el teclado o el selector).
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, formModal, confirmDialog } from '../ui.js';
import { lineChart, vizCard, dataTable, compactMoney, legend } from '../charts.js';

const nf = (d = 2) => new Intl.NumberFormat('es-CL', { maximumFractionDigits: d });
const pct = (x, d = 1) => `${nf(d).format(x * 100)}%`;
const uf = (v) => `${nf(2).format(v)} UF`;
const inUF = () => M.rateFor('UF', M.todayStr()) || 0;
const clp = (vUF) => (inUF() ? M.fmt(vUF * inUF(), M.base()) : '');
const ymLong = (ym) => M.monthName(ym).toLowerCase();

// campo numérico que recalcula al escribir, sin recrearse
function numField(label, value, onValue, { hint, suffix } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: value == null ? '' : String(value).replace('.', ',') });
  input.addEventListener('input', () => { const v = M.parseAmount(input.value); if (Number.isFinite(v)) onValue(v); });
  return h('label', { class: 'fc-field' }, h('span', null, label + (suffix ? ` (${suffix})` : '')), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

// ---- Prepago de un hipotecario --------------------------------------------------------------------
export function openPrepay(debtId) {
  const d = db.get('debts', debtId);
  if (!d || !d.mortgage) return;
  const st = { amount: 200 };
  const out = h('div');
  const draw = () => {
    const s = M.prepaySimulation(d, st.amount);
    if (!s) { fill(out, h('p', { class: 'empty' }, 'Este crédito ya está pagado.')); return; }
    const c = s.cuota, p = s.plazo;
    const line = (l, v, strong) => h('div', { class: 'rent-line' + (strong ? ' strong' : '') }, h('span', null, l), h('b', null, v));
    fill(out,
      h('p', { class: 'small' }, `Saldo hoy: ${uf(s.balance)} (${clp(s.balance)}), quedan ${s.remaining} cuotas (hasta ${ymLong(s.endNow)}), tasa ${pct(s.annualRate, 2)} anual sobre UF.`),
      h('section', { class: 'card' }, h('h3', null, 'Si bajas el dividendo'),
        h('div', { class: 'rent' },
          line('Dividendo', `${uf(c.before)} → ${uf(c.dividend)}`),
          line('Menos al mes', `${uf(c.monthlySaving)} · ${clp(c.monthlySaving)}`, true),
          line('Interés que te ahorras', `${uf(c.interestSaved)} · ${clp(c.interestSaved)}`))),
      h('section', { class: 'card' }, h('h3', null, 'Si acortas el plazo'),
        h('div', { class: 'rent' },
          line('Terminas de pagar', `${ymLong(p.end)} (${p.monthsSaved} cuotas antes)`, true),
          line('Interés que te ahorras', `${uf(p.interestSaved)} · ${clp(p.interestSaved)}`),
          p.insuranceSaved > 0.01 ? line('Seguros que no pagas', `${uf(p.insuranceSaved)}`) : null)),
      h('p', { class: 'muted small' }, `Prepagar es como invertir a ${pct(s.annualRate, 2)} sobre la UF sin riesgo: conviene si no tienes una inversión que rinda más después de impuestos y si te queda un colchón para emergencias. Acortar el plazo ahorra más interés; bajar el dividendo libera caja cada mes. El banco puede cobrar una comisión de prepago (hasta 1,5 meses de interés).`));
  };
  const body = h('div', null,
    numField('Monto a prepagar', st.amount, (v) => { st.amount = v; draw(); }, { suffix: d.currency, hint: inUF() ? `1 UF = ${M.fmt(inUF(), M.base())}` : null }),
    out);
  modal(`Prepagar: ${d.name}`, body, { wide: true });
  draw();
}

// ---- ¿Arrendar o vender? ---------------------------------------------------------------------
export function rentVsSellSection(p) {
  const other = db.all('debts').filter(x => x.mortgage && !x.archived && x.id !== p.mortgageId)
    .map(x => ({ x, s: M.prepaySimulation(x, 0) })).filter(o => o.s).sort((a, b) => b.s.annualRate - a.s.annualRate)[0];
  // costos del dueño que siguen al arrendar: contribuciones (en UF al mes), del promedio con la etiqueta
  const contribUF = (() => {
    if (!p.tag) return 0;
    const cut = M.addDays(M.todayStr(), -365);
    const sum = db.all('tx').filter(x => x.date >= cut && x.tag === p.tag && /contribuc/i.test((M.category(x.categoryId) || {}).name || '')).reduce((a, x) => a + M.txBase(x), 0);
    return inUF() ? sum / 12 / inUF() : 0;
  })();
  const st = {
    years: 10, rentUF: p.rentUF || Math.max(1, Math.round((M.propertyStats(p).value || 0) * 0.004)), adminPct: p.adminPct ?? 8.33, vacancyMonths: 0.5,
    appreciation: 2, altReturn: other ? Math.round(other.s.annualRate * 10000) / 100 : 3, sellCostPct: 2, ownerCostsUF: Math.round(contribUF * 100) / 100,
  };
  const out = h('div');
  const draw = () => {
    const r = M.rentVsSell(p, { ...st, appreciation: st.appreciation / 100, altReturn: st.altReturn / 100 });
    const better = r.end.keep >= r.end.sell;
    const diff = Math.abs(r.end.keep - r.end.sell);
    fill(out,
      h('p', { class: 'pace-msg' + (better ? ' down-good' : '') }, `En ${st.years} años: arrendar deja ${uf(r.end.keep)} y vender hoy ${uf(r.end.sell)}. ${better ? 'Arrendar' : 'Vender'} rinde ${uf(diff)} más (${clp(diff)} de hoy).`),
      r.breakEven != null ? h('p', { class: 'small' }, `Empatan si la propiedad sube ${pct(r.breakEven, 1)} al año sobre la UF: ${r.breakEven < st.appreciation / 100 ? 'con tu supuesto, conviene arrendar' : 'con tu supuesto, conviene vender'}.`) : null,
      legend([{ name: 'Arrendar', color: '--viz-1' }, { name: 'Vender e invertir', color: '--viz-2' }]),
      lineChart({
        points: r.series.map(x => ({ short: x.year ? `${x.year}a` : 'hoy', long: x.year ? `En ${x.year} años` : 'Hoy', ym: '' })), cur: 'UF', height: 200,
        series: [{ name: 'Arrendar', values: r.series.map(x => x.keep), color: '--viz-1' }, { name: 'Vender e invertir', values: r.series.map(x => x.sell), color: '--viz-2' }],
        ariaLabel: `Arrendar ${uf(r.end.keep)} contra vender ${uf(r.end.sell)} en ${st.years} años`,
      }),
      h('div', { class: 'rent' },
        h('div', { class: 'rent-line' }, h('span', null, 'Si vendes hoy recibes'), h('b', null, `${uf(r.sellNow)} · ${clp(r.sellNow)}`)),
        h('div', { class: 'rent-line' }, h('span', null, '…valor menos crédito y costo de venta'), h('span', null, `${uf(r.value)} − ${uf(r.debt)}${r.partnerClaim ? ` − socio ${uf(r.partnerClaim)}` : ''}`)),
        h('div', { class: 'rent-line strong' }, h('span', null, 'Arrendando, cada mes te queda'), h('b', { class: r.monthlyFlow < 0 ? 'neg' : '' }, `${uf(r.monthlyFlow)} · ${clp(r.monthlyFlow)}`))),
      h('p', { class: 'muted small' }, `En UF (pesos de hoy). Arrendar: arriendo menos comisión y meses vacíos, menos dividendo y costos del dueño; ese flujo se invierte (o se financia) al mismo ${pct(st.altReturn / 100, 2)}, y al final la propiedad se vende con su costo y la parte del socio. Vender: lo recibido hoy rinde ${pct(st.altReturn / 100, 2)}${other ? ` (como prepagar ${other.x.name}, que cobra esa tasa)` : ''}. No incluye impuestos.`));
  };
  const set = (k) => (v) => { st[k] = v; draw(); };
  const fields = h('div', { class: 'fc-fields rvs-fields' },
    numField('Años', st.years, (v) => { st.years = Math.max(1, Math.min(30, Math.round(v))); draw(); }),
    numField('Arriendo', st.rentUF, set('rentUF'), { suffix: 'UF' }),
    numField('Comisión', st.adminPct, set('adminPct'), { suffix: '%' }),
    numField('Meses vacíos al año', st.vacancyMonths, set('vacancyMonths')),
    numField('Plusvalía al año', st.appreciation, set('appreciation'), { suffix: '% sobre UF' }),
    numField('Rentabilidad si vendes', st.altReturn, set('altReturn'), { suffix: '% sobre UF' }),
    numField('Costo de venta', st.sellCostPct, set('sellCostPct'), { suffix: '%' }),
    numField('Costos del dueño al mes', st.ownerCostsUF, set('ownerCostsUF'), { suffix: 'UF', hint: 'Contribuciones, reparaciones…' }));
  draw();
  return h('section', { class: 'card' }, h('h3', null, '¿Arrendar o vender?'), out, h('h4', null, 'Supuestos'), fields);
}

// ---- Resumen del mes --------------------------------------------------------------------------
export function openMonthSummary(ym) {
  const s = M.monthSummary(ym);
  const base = M.base();
  const c = (v) => compactMoney(v, base);
  const pctDiff = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%` : '');
  const mine = M.people().length > 1;
  const sv = s.savings;
  const lines = [];
  lines.push(`Gasto del hogar: ${c(s.spend.total)} (${pctDiff(s.spend.total, s.spend.typical)} vs un mes típico de ${c(s.spend.typical)})`);
  if (mine) lines.push(`Mi parte: ${c(s.spend.mine)} (${pctDiff(s.spend.mine, s.spend.mineTypical)} vs típico)`);
  if (sv.net) lines.push(`Ingreso líquido ${c(sv.net)} · ahorro ${c(sv.saved)} (${sv.rate != null ? Math.round(sv.rate * 100) + '%' : '—'})`);
  const changes = s.changes.map(x => `${x.icon ? x.icon + ' ' : ''}${x.label}: ${x.diff > 0 ? '+' : ''}${c(x.diff)} (${c(x.now)} vs ${c(x.typical)})`);
  const settle = [...s.paid.map(t => `${M.personName(t.from)} pagó ${c(t.amount)} a ${M.personName(t.to)} (${t.date.slice(8)}/${t.date.slice(5, 7)})`),
    ...s.settle.map(t => `Pendiente: ${M.personName(t.from)} debe ${c(t.amount)} a ${M.personName(t.to)}`)];
  const text = [`Moni · resumen de ${ymLong(ym)}`, ...lines, '', 'Lo que más cambió:', ...changes, ...(settle.length ? ['', 'Cierre:', ...settle] : []), '', `${M.fmtInt(s.entries)} registros, ${s.emptyDays} días sin registros.`].join('\n');
  const body = h('div', { class: 'month-summary' },
    h('div', { class: 'kpis' },
      h('div', null, h('span', null, 'Gasto del hogar'), M.fmt(s.spend.total, base), h('small', { class: s.spend.total > s.spend.typical ? 'neg' : 'pos' }, ` ${pctDiff(s.spend.total, s.spend.typical)} vs típico`)),
      mine ? h('div', null, h('span', null, 'Mi parte'), M.fmt(s.spend.mine, base)) : null,
      sv.net ? h('div', null, h('span', null, 'Ahorro'), `${M.fmt(sv.saved, base)}${sv.rate != null ? ` · ${Math.round(sv.rate * 100)}%` : ''}`) : null),
    h('h4', null, 'Lo que más cambió vs un mes típico'),
    s.changes.length ? s.changes.map(x => h('div', { class: 'rent-line' }, h('span', null, `${x.icon ? x.icon + ' ' : ''}${x.label}`), h('b', { class: x.diff > 0 ? 'neg' : 'pos' }, `${x.diff > 0 ? '+' : ''}${c(x.diff)}`))) : h('p', { class: 'muted' }, 'Un mes como los demás.'),
    settle.length ? [h('h4', null, 'Cierre'), settle.map(l => h('p', { class: 'small' }, l))] : null,
    h('p', { class: 'muted small' }, `${M.fmtInt(s.entries)} registros · ${s.emptyDays} días sin registros. "Típico" = la mediana de los 6 meses anteriores.`));
  modal(`Resumen de ${ymLong(ym)}`, body, {
    actions: [h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: async () => {
      if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(text); toast('Resumen copiado'); } catch { toast('No se pudo compartir'); }
    } }, 'Compartir')],
  });
}

// ---- Metas y provisiones ----------------------------------------------------------------------
export function editGoal(g = {}) {
  const accounts = M.accounts().map(a => ({ v: a.id, l: a.name }));
  const invs = M.investmentSummaries().map(i => ({ v: i.id, l: i.name }));
  formModal({
    title: g.id ? 'Editar meta' : 'Nueva meta',
    value: { source: 'manual', months: 3, ...g, refInv: g.source === 'investment' ? g.ref : undefined },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'Ej: Fondo de emergencia, vacaciones, auto' },
      { key: 'source', label: 'Cómo se mide el avance', type: 'select', options: [
        { v: 'emergency', l: 'Fondo de emergencia: meses de salida cubiertos por tu liquidez' },
        { v: 'account', l: 'Saldo de una cuenta' }, { v: 'investment', l: 'Valor de una inversión' }, { v: 'manual', l: 'Lo anoto yo' }] },
      { key: 'months', label: 'Meses a cubrir', type: 'number', show: (v) => v.source === 'emergency', hint: 'Se recomiendan 3 a 6.' },
      { key: 'target', label: 'Monto meta', type: 'number', show: (v) => v.source !== 'emergency' },
      { key: 'ref', label: 'Cuenta', type: 'select', options: accounts, show: (v) => v.source === 'account' },
      { key: 'refInv', label: 'Inversión', type: 'select', options: invs, show: (v) => v.source === 'investment' },
      { key: 'saved', label: 'Llevo ahorrado', type: 'number', show: (v) => v.source === 'manual' },
      { key: 'due', label: 'Para cuándo (AAAA-MM, opcional)', type: 'month' },
    ],
    onSave: async (v) => {
      if (v.source === 'investment') v.ref = v.refInv;
      delete v.refInv;
      await M.saveGoal(v);
    },
    onDelete: g.id ? async () => { await M.deleteGoal(g.id); toast('Meta eliminada'); } : null,
  });
}

export function goalsCard() {
  const base = M.base();
  const list = M.goals();
  const prov = M.nonMonthlyProvisions();
  const provTotal = prov.reduce((a, x) => a + x.monthly, 0);
  return h('section', { class: 'card goals' },
    h('div', { class: 'card-head' }, h('h3', null, 'Metas'), h('button', { class: 'btn small', type: 'button', onclick: () => editGoal() }, '＋ Meta')),
    list.length ? list.map(g => {
      const pr = M.goalProgress(g);
      return h('button', { type: 'button', class: 'goal-row', onclick: () => editGoal(g) },
        h('div', { class: 'goal-top' }, h('span', { class: 'title' }, g.name), h('span', null, `${compactMoney(pr.current, base)} de ${compactMoney(pr.target, base)}`)),
        h('div', { class: 'goal-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pr.pct * 100)), 'aria-label': g.name },
          h('div', { style: { width: pr.pct * 100 + '%' } })),
        h('div', { class: 'muted small' }, pr.done ? '✓ Lograda' : `${Math.round(pr.pct * 100)}% · faltan ${compactMoney(pr.left, base)}${pr.monthly ? ` · ${compactMoney(pr.monthly, base)} al mes hasta ${ymLong(g.due)}` : ''}`));
    }) : h('p', { class: 'muted small' }, 'Sin metas. Parte por el fondo de emergencia: con tu liquidez, cuántos meses de salida cubres.'),
    prov.length ? [
      h('h4', null, 'Gastos que no son mensuales'),
      h('p', { class: 'small' }, `Aparta ${M.fmt(provTotal, base)} al mes para no llevarte la sorpresa:`),
      prov.slice(0, 6).map(x => h('div', { class: 'rent-line' }, h('span', null, `${x.icon ? x.icon + ' ' : ''}${x.label}`), h('span', null, `${compactMoney(x.monthly, base)}/mes · ${compactMoney(x.total, base)} al año`))),
      h('p', { class: 'muted small' }, 'Categorías con gasto en algunos meses del último año (tu parte).'),
    ] : null);
}

// ---- Patrimonio a 10 años -------------------------------------------------------------------------
const nwView = { appreciation: 2, invReturn: 3 };
export function netWorthProjectionCard(getScenario) {
  const base = M.base();
  const out = h('div'), tableBox = h('div');
  const draw = () => {
    const sc = getScenario ? getScenario() : {};
    const pr = M.netWorthProjection({ years: 10, appreciation: nwView.appreciation / 100, invReturn: nwView.invReturn / 100, rent: sc.rent || null, spend: sc.spend });
    const r0 = pr.rows[0], r10 = pr.rows.at(-1);
    fill(out,
      h('p', { class: 'pace-msg' }, `Hoy ${compactMoney(r0.net, base)}; en 10 años ${compactMoney(r10.net, base)} en pesos de hoy${sc.rent ? ', con el arriendo simulado' : ''}.`),
      legend([{ name: 'Patrimonio', color: '--viz-1' }, { name: 'Créditos hipotecarios', color: '--viz-2' }]),
      lineChart({
        points: pr.rows.map(x => ({ short: x.year ? String(new Date().getFullYear() + x.year).slice(2) : 'hoy', long: x.year ? `En ${x.year} años` : 'Hoy', ym: '' })), cur: base, height: 200,
        series: [{ name: 'Patrimonio', values: pr.rows.map(x => x.net), color: '--viz-1', area: true }, { name: 'Créditos hipotecarios', values: pr.rows.map(x => x.mortgages), color: '--viz-2' }],
        extra: (i) => [{ value: M.fmt(pr.rows[i].props, base), label: 'Propiedades (tu parte)' }, { value: M.fmt(pr.rows[i].inv, base), label: 'Inversiones' }, { value: M.fmt(pr.rows[i].cash, base), label: 'Caja acumulada' }],
        ariaLabel: `Patrimonio de ${compactMoney(r0.net, base)} a ${compactMoney(r10.net, base)} en 10 años`,
      }),
      h('p', { class: 'muted small' }, `Propiedades suben ${nwView.appreciation}% al año sobre la UF; los créditos bajan según su tabla; inversiones rinden ${nwView.invReturn}% sobre la UF; la caja suma lo que deja un año típico de tu proyección (${M.fmt(pr.yearNet, base, { sign: true })} al año en pesos de hoy, incluido el ingreso anual). Es una estimación.`));
    fill(tableBox, dataTable(['Año', 'Propiedades', 'Créditos', 'Inversiones', 'Caja', 'Patrimonio'], pr.rows.map(x => [x.year ? `+${x.year}` : 'Hoy', M.fmt(x.props, base), M.fmt(-x.mortgages, base), M.fmt(x.inv, base), M.fmt(x.cash, base), M.fmt(x.net, base)])));
  };
  const fields = h('div', { class: 'fc-fields' },
    numField('Plusvalía al año', nwView.appreciation, (v) => { nwView.appreciation = v; draw(); }, { suffix: '% s/UF' }),
    numField('Inversiones al año', nwView.invReturn, (v) => { nwView.invReturn = v; draw(); }, { suffix: '% s/UF' }));
  draw();
  const card = vizCard({ title: 'Patrimonio en 10 años', subtitle: 'En pesos de hoy · con tus créditos, propiedades e inversiones', chart: h('div', null, out, fields), table: tableBox });
  card.redraw = draw;
  return card;
}
