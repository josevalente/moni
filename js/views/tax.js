// Resumen para el contador: lo relevante para la declaración anual de renta (Formulario 22 del SII) de un año
// comercial, con lo registrado en Moni. Se comparte como archivo (se abre en cualquier navegador e imprime), como
// PDF (imprimir) o como CSV para Excel. Es de apoyo: los montos oficiales vienen de los certificados y de la
// propuesta del SII.
import * as M from '../model.js';
import { fill, h, shareFile, toast } from '../ui.js';
import { taxNotes, TAX_DOCS, utaOf } from './tax-notes.js';

const st = { year: null, uta: {} };     // uta: valor de la UTA de diciembre de cada año (de mindicador)
const clp = (v) => (v == null ? '—' : M.fmt(v, 'CLP'));
const amt = (v, cur) => (v == null ? '—' : M.fmt(v, cur));
const nf2 = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
const GROUP = { salary: 'Remuneraciones', dividend: 'Dividendos y retiros', interest: 'Intereses', rent: 'Arriendos', other: 'Otros ingresos', extra: 'Ingresos no recurrentes' };

// tabla simple (en pantalla y en el archivo); la primera columna a la izquierda, el resto a la derecha
const table = (head, rows, foot) => h('table', { class: 'tx-tbl' },
  h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: i ? 'r' : '' }, c)))),
  h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', { class: i ? 'r' : '' }, c))))),
  foot ? h('tfoot', null, h('tr', null, foot.map((c, i) => h('td', { class: i ? 'r' : '' }, c)))) : null);
const section = (title, ...kids) => h('section', { class: 'tx-sec' }, h('h2', null, title), ...kids);
const note = (t) => h('p', { class: 'tx-note' }, t);

export function taxReport(t, uta = st.uta[t.year] || null) {
  const T = t.totals;
  const salaryRows = t.income.filter(r => r.group === 'salary');
  const otherRows = t.income.filter(r => r.group !== 'salary');
  const ded = t.deductions;
  // remuneraciones mes a mes: bruto, impuesto retenido y cotizaciones
  const byMonth = t.months.map((ym, i) => {
    const gross = salaryRows.reduce((a, r) => a + r.months[i], 0);
    const tax = ded.filter(r => r.isTax).reduce((a, r) => a + r.months[i], 0);
    const cot = ded.filter(r => !r.isTax).reduce((a, r) => a + r.months[i], 0);
    return [M.monthName(ym), clp(gross), clp(tax), clp(cot)];
  });
  return h('article', { class: 'tax-report' },
    h('header', { class: 'tx-head' },
      h('h1', null, `Resumen para la declaración de renta · año comercial ${t.year}`),
      h('p', null, `Operación Renta ${t.year + 1} · ${t.person} · generado el ${new Date(t.generated + 'T12:00:00').toLocaleDateString('es-CL')} con Moni${t.uf ? ` · UF al 31-12-${t.year}: ${M.fmt(t.uf, 'CLP')}` : ''}${uta ? ` · UTA dic-${t.year}: ${M.fmt(uta, 'CLP')}` : ''}`),
      note('Montos en pesos registrados por la persona (los en otra moneda, al tipo de cambio de cada día). Sirven para cuadrar: los oficiales son los de los certificados del empleador, bancos, AFP y corredoras, y la propuesta del SII.')),
    h('div', { class: 'tx-kpis' },
      [['Remuneraciones brutas', T.salary], ['Impuesto único retenido', T.taxWithheld], ['Cotizaciones y descuentos', T.deductions - T.taxWithheld], ['Intereses hipotecarios pagados', T.mortgageInterest],
        ...(T.dividend ? [['Dividendos y retiros', T.dividend]] : []), ...(T.interest ? [['Intereses', T.interest]] : []), ...(T.rent ? [['Arriendos recibidos', T.rent]] : [])]
        .map(([l, v]) => h('div', null, h('span', null, l), h('b', null, clp(v))))),
    section('1. Remuneraciones (trabajo dependiente)',
      salaryRows.length ? table(['Concepto', 'Total del año'], salaryRows.map(r => [r.cat.name, clp(r.total)]), ['Total', clp(T.salary)]) : note('Sin remuneraciones registradas.'),
      ded.length ? table(['Descuento del sueldo', 'Total del año'], ded.map(r => [r.cat.name + (r.isTax ? ' (impuesto único de 2ª categoría)' : ''), clp(r.total)]), ['Total descuentos', clp(T.deductions)]) : null,
      salaryRows.length ? h('details', null, h('summary', null, 'Mes a mes'), table(['Mes', 'Bruto', 'Impuesto', 'Cotizaciones'], byMonth)) : null),
    otherRows.length ? section('2. Otros ingresos registrados',
      table(['Categoría', 'Tipo', 'Total'], otherRows.map(r => [r.cat.name, GROUP[r.group], clp(r.total)])),
      otherRows.filter(r => r.detail && r.detail.length).map(r => h('div', null, h('h3', null, `${r.cat.name}: lo principal`),
        table(['Descripción', 'Veces', 'Total'], r.detail.map(d => [d.label, String(d.count), clp(d.total)])))),
      note('Para revisar con el contador: qué es remuneración (bonos), qué son asignaciones no imponibles (colación, movilización), qué son traspasos o regalos familiares y qué son devoluciones (por ejemplo, de impuestos), que no son renta.')) : null,
    t.investments.length ? section('3. Inversiones y ahorro',
      table(['Inversión', 'Saldo al 31-12', 'Aportes', 'Rescates', 'Rentab. del año', 'Dividendos'], t.investments.map(x => [
        x.inv.name, `${amt(x.balance, x.currency)}${x.currency !== 'CLP' && x.balanceBase != null ? ` (${clp(x.balanceBase)})` : ''}`,
        amt(x.contrib, x.currency), amt(x.withdraw, x.currency), amt(x.gainYear, x.currency), x.dividends ? amt(x.dividends, x.currency) : '—'])),
      t.investments.some(x => Math.abs(x.realized) > 0.5) ? table(['Ganancia realizada en ventas', 'Monto'], t.investments.filter(x => Math.abs(x.realized) > 0.5).map(x => [x.inv.name, amt(x.realized, x.currency)])) : null,
      note('Rentabilidad del año = cambio de valor menos lo aportado neto, más dividendos pagados. En depósitos a plazo son los intereses (los informa el banco); en fondos y acciones solo tributa lo realizado al rescatar o vender. La AFP y el APV no tributan mientras están ahorrados.')) : null,
    t.properties.length ? section('4. Bienes raíces y créditos hipotecarios',
      table(['', ...t.properties.map(x => x.p.name)], [
        ['Valor registrado (tasación)', ...t.properties.map(x => amt(x.value, x.currency))],
        ['Saldo del crédito al 31-12', ...t.properties.map(x => (x.mortgage ? amt(x.debt, x.currency) : '—'))],
        ['Cuotas pagadas en el año', ...t.properties.map(x => (x.mortgage ? String(x.mortgage.cuotas) : '—'))],
        ['Intereses pagados', ...t.properties.map(x => (x.mortgage ? `${nf2.format(x.mortgage.interestUF)} ${x.mortgage.currency} · ${clp(x.mortgage.interest)}` : '—'))],
        ['Dividendos pagados', ...t.properties.map(x => (x.mortgage ? clp(x.mortgage.paid) : '—'))],
        ['Contribuciones pagadas', ...t.properties.map(x => (x.contrib != null ? clp(x.contrib) : 'sin etiqueta'))],
        ['Arriendos recibidos', ...t.properties.map(x => (x.rentIn ? clp(x.rentIn) : '—'))],
        ...(t.properties.some(x => x.partnerClaim) ? [['Parte de un socio en la plusvalía', ...t.properties.map(x => (x.partnerClaim ? amt(x.partnerClaim, x.currency) : '—'))]] : []),
      ]),
      note('Intereses según la tabla de desarrollo de cada crédito, a la UF de cada vencimiento; el banco emite el certificado de intereses pagados (para la rebaja por intereses hipotecarios). Las contribuciones por propiedad usan la etiqueta de sus gastos.')) : null,
    (T.apv || T.donation || T.education || T.contrib) ? section('5. Gastos con posible beneficio tributario',
      table(['Concepto', 'Total del año'], t.expenses.map(r => [r.cat.name, clp(r.total)])),
      note('Solo cuentan con su certificado (APV de la AFP o institución, donaciones de la entidad, educación con los requisitos de la ley).')) : null,
    section('6. Cuentas y deudas al 31 de diciembre',
      table(['Cuenta', 'Saldo', 'En pesos'], t.accounts.map(x => [x.acc.name + (x.foreign ? ' · moneda extranjera' : ''), amt(x.balance, x.currency), x.currency === 'CLP' ? '' : clp(x.balanceBase)])),
      t.debts.length ? table(['Deuda', 'Saldo', 'En pesos'], t.debts.map(x => [x.debt.name, amt(x.balance, x.currency), x.currency === 'CLP' ? '' : clp(x.balanceBase)])) : null,
      t.accounts.some(x => x.foreign) ? note('Las cuentas en moneda extranjera pueden estar en Chile o en el extranjero: indícale al contador cuáles están fuera de Chile (sus intereses o rentas se declaran).') : null),
    section('7. Para revisar con el contador',
      h('ul', null, taxNotes(t, uta).map(n => h('li', null, n))),
      h('h3', null, 'Documentos que suele pedir'),
      h('ul', null, TAX_DOCS.map(n => h('li', null, n)))),
    h('footer', { class: 'tx-foot' }, note('Resumen informativo generado por Moni a partir de lo registrado. No reemplaza la asesoría tributaria ni los certificados oficiales.')));
}

const PRINT_CSS = `
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#14201f;background:#fff;margin:0;padding:24px;max-width:900px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #0f766e;color:#0f766e}h3{font-size:13px;margin:12px 0 4px}
p{margin:4px 0}.tx-note{color:#55666a;font-size:12px}table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:13px}
th,td{padding:5px 6px;border-bottom:1px solid #e3e8ea;text-align:left;vertical-align:top}th{background:#f1f5f5;font-weight:600}.r{text-align:right;white-space:nowrap}
tfoot td{font-weight:700;border-top:2px solid #cfd8da}.tx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:14px 0}
.tx-kpis div{border:1px solid #e3e8ea;border-radius:8px;padding:8px}.tx-kpis span{display:block;font-size:12px;color:#55666a}.tx-kpis b{font-size:16px}
ul{margin:4px 0 8px 18px;padding:0}li{margin:3px 0}details summary{cursor:pointer;font-weight:600;margin:6px 0}details{margin:6px 0}
@media print{body{padding:0}details{display:block}details>summary{display:none}details>*{display:block}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}`;

export function taxHTML(t) {
  const el = taxReport(t);
  el.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  return `<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Renta ${t.year} · ${t.person}</title><style>${PRINT_CSS}</style></head><body>${el.outerHTML}</body></html>`;
}

const csvCell = (v) => { const s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function taxCSV(t) {
  const rows = [['Sección', 'Concepto', 'Detalle', 'Monto', 'Moneda']];
  const push = (...r) => rows.push(r);
  for (const r of t.income) push(GROUP[r.group], r.cat.name, `${r.count} movimientos`, r.total, 'CLP');
  for (const r of t.income) for (const d of r.detail || []) push(`${GROUP[r.group]} (detalle)`, r.cat.name, d.label, d.total, 'CLP');
  for (const r of t.deductions) push('Descuentos del sueldo', r.cat.name, r.isTax ? 'impuesto único retenido' : '', r.total, 'CLP');
  t.months.forEach((ym, i) => {
    const gross = t.income.filter(r => r.group === 'salary').reduce((a, r) => a + r.months[i], 0);
    const tax = t.deductions.filter(r => r.isTax).reduce((a, r) => a + r.months[i], 0);
    push('Remuneraciones por mes', M.monthName(ym), 'bruto', gross, 'CLP'); push('Remuneraciones por mes', M.monthName(ym), 'impuesto retenido', tax, 'CLP');
  });
  for (const x of t.investments) {
    push('Inversiones', x.inv.name, 'saldo al 31-12', x.balance, x.currency); push('Inversiones', x.inv.name, 'aportes del año', x.contrib, x.currency);
    push('Inversiones', x.inv.name, 'rescates del año', x.withdraw, x.currency); push('Inversiones', x.inv.name, 'rentabilidad del año', x.gainYear, x.currency);
    if (x.dividends) push('Inversiones', x.inv.name, 'dividendos', x.dividends, x.currency);
    if (Math.abs(x.realized) > 0.5) push('Inversiones', x.inv.name, 'ganancia realizada', x.realized, x.currency);
  }
  for (const x of t.properties) {
    push('Bienes raíces', x.p.name, 'valor registrado', x.value, x.currency);
    if (x.mortgage) { push('Bienes raíces', x.p.name, 'saldo crédito 31-12', x.debt, x.currency); push('Bienes raíces', x.p.name, 'intereses pagados', x.mortgage.interest, 'CLP'); push('Bienes raíces', x.p.name, 'intereses pagados', x.mortgage.interestUF, x.mortgage.currency); push('Bienes raíces', x.p.name, 'dividendos pagados', x.mortgage.paid, 'CLP'); }
    if (x.contrib != null) push('Bienes raíces', x.p.name, 'contribuciones pagadas', x.contrib, 'CLP');
    if (x.rentIn) push('Bienes raíces', x.p.name, 'arriendos recibidos', x.rentIn, 'CLP');
  }
  for (const r of t.expenses) push('Gastos con posible beneficio', r.cat.name, '', r.total, 'CLP');
  for (const x of t.accounts) push('Cuentas al 31-12', x.acc.name, x.foreign ? 'moneda extranjera' : '', x.balance, x.currency);
  for (const x of t.debts) push('Deudas al 31-12', x.debt.name, '', x.balance, x.currency);
  return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}

// impresión (PDF): solo el informe, sin la app alrededor
function printReport(t) {
  const area = h('div', { id: 'print-area' });
  area.innerHTML = taxReport(t).outerHTML;
  area.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  document.body.append(area);
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
}

export function renderTax(root, back) {
  const years = M.taxYears();
  const cur = Number(M.curYm().slice(0, 4));
  if (!st.year || !years.includes(st.year)) st.year = years.includes(cur - 1) ? cur - 1 : years[0];   // por defecto, el último año cerrado
  const t = M.taxSummary(st.year);
  // la UTA del año (para los topes en UTA) se consulta una vez y se vuelve a dibujar
  if (st.uta[st.year] === undefined) { st.uta[st.year] = null; utaOf(st.year).then(v => { if (v) { st.uta[st.year] = v; if (root.isConnected) renderTax(root, back); } }); }
  const sel = h('select', { 'aria-label': 'Año comercial', onchange: (e) => { st.year = Number(e.target.value); renderTax(root, back); } },
    years.map(y => h('option', { value: y, selected: y === st.year }, `Año comercial ${y} (renta ${y + 1})`)));
  fill(root, back,
    h('h2', null, 'Resumen para el contador'),
    h('p', { class: 'muted small' }, 'Lo relevante para tu declaración de renta (Formulario 22) de un año: remuneraciones e impuesto retenido, otros ingresos, inversiones, intereses hipotecarios, contribuciones, cuentas y deudas al 31 de diciembre.'),
    h('div', { class: 'filters' }, sel),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => shareFile(`renta-${st.year}-resumen.html`, taxHTML(t), 'text/html') }, 'Compartir con el contador'),
      h('button', { class: 'btn', onclick: () => printReport(t) }, 'Imprimir / PDF'),
      h('button', { class: 'btn', onclick: async () => { await shareFile(`renta-${st.year}-detalle.csv`, taxCSV(t), 'text/csv'); toast('CSV listo para Excel'); } }, 'CSV (Excel)')),
    h('div', { class: 'card tax-preview' }, taxReport(t)));
}
