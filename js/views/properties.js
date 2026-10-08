// Propiedades: cada una con su valor (tasación, en UF), su costo (precio + costos de compra + arreglos),
// su crédito hipotecario (saldo según la tabla de desarrollo) y, si corresponde, la parte de un socio en la
// plusvalía. Suman al patrimonio: valor − crédito − parte del socio. Incluye una simulación de arriendo.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, formModal, promptDialog, parseNum } from '../ui.js';
import { lineChart, vizCard, dataTable } from '../charts.js';

const dShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
const ufTxt = (v, cur = 'UF') => M.fmt(v, cur);
const inBase = (v, cur, date = M.todayStr()) => v * (M.rateFor(cur, date) ?? 1);
const pctTxt = (x) => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(x * 100)}%`;

export function editProperty(p) {
  const isNew = !(p && p.id);
  const mortgages = db.all('debts').filter(d => d.mortgage);
  formModal({
    title: isNew ? 'Nueva propiedad' : 'Editar propiedad',
    value: p ? { ...p, partnerId: p.partner ? p.partner.personId : '', partnerContrib: p.partner ? p.partner.contrib : null }
      : { currency: 'UF', date: M.todayStr() },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'Ej: Depto o casa' },
      { key: 'currency', label: 'Moneda del valor', type: 'select', options: M.settings().currencies.filter(c => c.convertible !== false).map(c => ({ v: c.code, l: c.code })) },
      ...(isNew ? [
        { key: '_price', label: 'Precio de compra', type: 'number', required: true },
        { key: 'date', label: 'Fecha de compra', type: 'date', required: true },
      ] : []),
      { key: 'mortgageId', label: 'Crédito hipotecario', type: 'select', options: [{ v: '', l: '— sin crédito —' }, ...mortgages.map(d => ({ v: d.id, l: d.name }))], hint: 'Se crea en Más › Deudas (con su tabla de desarrollo).' },
      { key: 'partnerId', label: 'Socio en la plusvalía (opcional)', type: 'select', options: [{ v: '', l: '— nadie —' }, ...M.people().map(x => ({ v: x.id, l: x.name }))],
        hint: 'Quien aportó a la compra o a los arreglos: al vender le corresponde la parte de la plusvalía proporcional a su aporte.' },
      { key: 'partnerContrib', label: 'Su aporte (en la moneda del valor)', type: 'number', show: (v) => !!v.partnerId },
      { key: 'tag', label: 'Etiqueta de sus gastos (opcional)', type: 'text', placeholder: 'Ej: AvLC', hint: 'Los movimientos de "Contribuciones" con esta etiqueta se usan en la simulación de arriendo.' },
      { key: 'rentUF', label: 'Arriendo mensual estimado (opcional)', type: 'number' },
      { key: 'adminPct', label: 'Comisión de administración (%)', type: 'number', show: (v) => !!v.rentUF, hint: 'Ej: 7% + IVA = 8,33.' },
      { key: 'archived', label: 'Archivada (vendida)', type: 'check' },
    ],
    onSave: async (v) => {
      const price = v._price; delete v._price;
      v.partner = v.partnerId ? { personId: v.partnerId, contrib: Math.abs(v.partnerContrib || 0) } : undefined;
      delete v.partnerId; delete v.partnerContrib;
      if (!v.mortgageId) delete v.mortgageId;
      const saved = await db.put('investments', { ...v, type: 'property', horizon: 'long' });
      if (isNew && price) {
        // el precio es el primer costo y la primera tasación
        await db.putMany('invEntries', [
          { id: db.uid(), invId: saved.id, date: v.date, kind: 'contrib', amount: Math.abs(price), note: 'Precio de compra' },
          { id: db.uid(), invId: saved.id, date: v.date, kind: 'gain', amount: 0, value: Math.abs(price), note: 'Tasación inicial (precio de compra)' },
        ]);
      }
      toast('Propiedad guardada');
    },
    onDelete: !isNew ? async (v) => {
      await db.del('investments', v.id);
      await db.delMany('invEntries', db.all('invEntries').filter(x => x.invId === v.id).map(x => x.id));
    } : null,
  });
}

async function appraise(p) {
  const s = M.propertyStats(p);
  const v = await promptDialog('Actualizar tasación', { label: `Valor de ${p.name} hoy (${p.currency})`, type: 'number', value: '', hint: `Actual: ${ufTxt(s.value, p.currency)}. Puedes usar una tasación o el precio de propiedades parecidas.` });
  if (v == null) return;
  const n = parseNum(v);
  if (!Number.isFinite(n) || n <= 0) { toast('Valor no válido'); return; }
  await db.put('invEntries', { invId: p.id, date: M.todayStr(), kind: 'gain', amount: n - s.value, value: n, note: 'Tasación' });
  toast('Tasación guardada');
}

function addCost(p) {
  formModal({
    title: `Costo o arreglo · ${p.name}`, value: { date: M.todayStr() },
    fields: [
      { key: 'amount', label: `Monto (${p.currency})`, type: 'number', required: true, hint: 'Algo que no está como movimiento en tus cuentas. Lo que pagas desde tus cuentas se suma solo si su categoría está asociada a la propiedad.' },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'note', label: 'Qué fue', type: 'text', required: true },
    ],
    onSave: (v) => db.put('invEntries', { invId: p.id, date: v.date, kind: 'contrib', amount: Math.abs(v.amount), note: v.note }),
  });
}

// Flujo mensual si se arrienda: arriendo − comisión − dividendo − contribuciones; aparte, la amortización
// (deuda que paga el arrendatario) que también es tuya.
function rentBlock(p, s) {
  if (!p.rentUF) return h('p', { class: 'muted small' }, 'Agrega un arriendo estimado en "Editar" para ver cuánto quedaría cada mes.');
  const d = s.mortgage;
  const k = d ? Math.min(d.mortgage.rows.length, M.cuotasPaid(d, M.todayStr()) + 1) : 0;
  const row = d ? d.mortgage.rows[k - 1] : null;
  const ufNow = M.rateFor('UF', M.todayStr()) || 1;
  const toCur = (uf) => uf * ufNow / (M.rateFor(p.currency, M.todayStr()) || 1);
  const fee = p.rentUF * (p.adminPct || 0) / 100;
  const div = row ? toCur(row[6]) : 0, amort = row ? toCur(row[1]) : 0;
  const contrib = contribPerMonth(p) / (M.rateFor(p.currency, M.todayStr()) || 1);
  const flow = p.rentUF - fee - div - contrib;
  const line = (l, v, strong) => h('div', { class: 'rent-line' + (strong ? ' strong' : '') }, h('span', null, l), h('b', null, ufTxt(v, p.currency)));
  return h('div', { class: 'rent' },
    line('Arriendo', p.rentUF), line(`Comisión de administración (${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(p.adminPct || 0)}%)`, -fee),
    d ? line('Dividendo', -div) : null, contrib ? line('Contribuciones (promedio)', -contrib) : null,
    line('Queda cada mes', flow, true),
    d ? h('p', { class: 'muted small' }, `Además, ${ufTxt(amort, p.currency)} al mes de amortización: deuda que baja y patrimonio tuyo. Sin contar meses sin arrendatario, reparaciones ni impuestos.`) : null);
}

// promedio mensual de los últimos 12 meses de la categoría "Contribuciones" con la etiqueta de la propiedad
function contribPerMonth(p) {
  const tag = p.tag;
  if (!tag) return 0;
  const cut = M.addDays(M.todayStr(), -365);
  const t = db.all('tx').filter(x => x.date >= cut && x.tag === tag && /contribuc/i.test((M.category(x.categoryId) || {}).name || ''));
  return t.reduce((a, x) => a + M.txBase(x), 0) / 12;
}

function openProperty(id) {
  const body = h('div');
  let m;
  const draw = () => {
    const p = db.get('investments', id);
    if (!p) { if (m) m.close(); return; }
    const s = M.propertyStats(p);
    const cur = p.currency;
    const entries = M.investmentEntries(id).reverse();
    const first = entries.length ? entries[entries.length - 1].date.slice(0, 7) : M.curYm();
    const months = M.monthsBetween(first, M.curYm());
    const hist = months.map(ym => M.propertyStats(p, ym === M.curYm() ? M.todayStr() : M.monthEnd(ym)));
    const d = s.mortgage;
    const k = d ? M.cuotasPaid(d, M.todayStr()) : 0;
    const next = d ? d.mortgage.rows[Math.min(k, d.mortgage.rows.length - 1)] : null;
    const toCur = (uf) => uf * (M.rateFor('UF', M.todayStr()) || 1) / (M.rateFor(cur, M.todayStr()) || 1);
    const paidInterest = d ? d.mortgage.rows.slice(0, k).reduce((a, r) => a + r[2], 0) : 0;
    const kpi = (l, v) => h('div', null, h('span', null, l), v);
    fill(body,
      h('div', { class: 'kpis' },
        kpi('Valor', ufTxt(s.value, cur)),
        d ? kpi('Crédito', ufTxt(s.debt, cur)) : null,
        p.partner ? kpi(`Parte de ${M.personName(p.partner.personId)}`, ufTxt(s.partnerClaim, cur)) : null,
        kpi('Tuyo', `${ufTxt(s.equity, cur)} · ${M.fmt(inBase(s.equity, cur), M.base())}`),
        kpi('Costo total', ufTxt(s.basis, cur)),
        kpi('Plusvalía', `${M.fmt(s.gain, cur, { sign: true })}`)),
      p.partner ? h('p', { class: 'muted small' }, `${M.personName(p.partner.personId)} aportó ${ufTxt(p.partner.contrib, cur)}: el ${pctTxt(s.share)} del costo total. Al vender le corresponde esa parte de la plusvalía (hoy ${ufTxt(s.partnerClaim, cur)}).`) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => appraise(p) }, 'Actualizar tasación'),
        h('button', { class: 'btn', onclick: () => addCost(p) }, 'Costo o arreglo'),
        h('button', { class: 'btn ghost', onclick: () => editProperty(db.get('investments', id)) }, 'Editar')),
      months.length > 1 ? vizCard({
        title: 'Valor y crédito',
        subtitle: `En ${cur} al cierre de cada mes · la distancia entre las líneas es lo tuyo`,
        legendItems: [{ name: 'Valor', color: '--viz-1' }, { name: 'Crédito', color: '--viz-2' }],
        chart: lineChart({
          points: months.map(ym => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), ym })), cur,
          series: [{ name: 'Valor', values: hist.map(x => x.value), color: '--viz-1', area: true }, { name: 'Crédito', values: hist.map(x => x.debt), color: '--viz-2' }],
          extra: (i) => [{ value: M.fmt(hist[i].equity, cur), label: 'Tuyo' }],
          ariaLabel: `${p.name}: valor ${ufTxt(s.value, cur)}, crédito ${ufTxt(s.debt, cur)}`,
        }),
        table: dataTable(['Mes', 'Valor', 'Crédito', 'Tuyo'], months.map((ym, i) => [M.monthName(ym), ufTxt(hist[i].value, cur), ufTxt(hist[i].debt, cur), ufTxt(hist[i].equity, cur)]).reverse()),
      }) : null,
      d ? h('section', { class: 'card' },
        h('h3', null, 'Dividendo'),
        h('p', { class: 'small' }, k < d.mortgage.rows.length
          ? `Cuota ${k + 1} de ${d.mortgage.rows.length}: ${ufTxt(toCur(next[6]), cur)}. De eso, ${ufTxt(toCur(next[1]), cur)} es amortización (ahorro: baja la deuda) y ${ufTxt(toCur(next[2] + next[4] + next[5]), cur)} interés y seguros (gasto).`
          : 'Crédito pagado.'),
        h('p', { class: 'muted small' }, `Interés pagado hasta hoy: ${ufTxt(toCur(paidInterest), cur)}. En los reportes, del dividendo solo cuentan como gasto el interés y los seguros.`)) : null,
      h('section', { class: 'card' }, h('h3', null, 'Si la arriendas'), rentBlock(p, s)),
      h('h4', null, 'Costos y tasaciones'),
      entries.map(e => h('div', { class: 'row static' },
        h('div', { class: 'main' }, h('div', { class: 'title' }, e.kind === 'gain' ? 'Tasación' : e.fromTx ? (M.category(e.fromCat) || {}).name || 'Movimiento' : 'Costo'),
          h('div', { class: 'sub' }, [dShort(e.date), e.note].filter(Boolean).join(' · '))),
        h('div', { class: 'amt' }, ufTxt(e.kind === 'gain' ? e.value : e.amount, cur)))));
  };
  const unsub = db.subscribe(draw);
  m = modal((db.get('investments', id) || {}).name || 'Propiedad', body, { wide: true, onClose: unsub });
  draw();
}

export function renderProperties(root) {
  const list = M.propertySummaries();
  const base = M.base();
  const tot = (key) => list.reduce((a, p) => a + inBase(p[key], p.currency), 0);
  fill(root,
    h('section', { class: 'card hero' },
      h('div', { class: 'label' }, 'Lo tuyo en propiedades (valor − crédito)'),
      h('div', { class: 'big' }, M.fmt(tot('equity'), base)),
      h('div', { class: 'breakdown' },
        h('div', null, h('span', null, 'Valor'), M.fmt(tot('value'), base)),
        h('div', null, h('span', null, 'Créditos'), M.fmt(-tot('debt'), base)),
        tot('partnerClaim') ? h('div', null, h('span', null, 'Parte de socios'), M.fmt(-tot('partnerClaim'), base)) : null),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => editProperty(null) }, '＋ Nueva propiedad'))),
    list.length ? h('section', { class: 'card' }, list.map(p => h('button', { class: 'row', onclick: () => openProperty(p.id) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, p.name),
        h('div', { class: 'sub' }, [`valor ${ufTxt(p.value, p.currency)}`, p.mortgage ? `crédito ${ufTxt(p.debt, p.currency)}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'amt' }, h('div', null, ufTxt(p.equity, p.currency)), h('div', { class: 'sub' }, `≈ ${M.fmt(inBase(p.equity, p.currency), base)}`)))))
      : h('p', { class: 'empty' }, 'Sin propiedades registradas.'),
    h('p', { class: 'muted small' }, 'Suman a tu patrimonio: valor (última tasación) menos el saldo del crédito y la parte de un socio en la plusvalía. La compra, los costos de compra y los arreglos forman su costo total.'));
}
