// Cierre mensual: cuánto corresponde a cada uno y cuánto se cobra/paga.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, parseNum, numText } from '../ui.js';
import { openTxForm } from './add.js';
import { txRow } from './txs.js';

const st = { ym: null };

// Abre el Cierre en un mes dado (desde los pendientes de Inicio).
export function showCloseMonth(ym) {
  st.ym = ym;
  if (location.hash === '#/cierre') window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = '#/cierre';
}
const pctText = (p) => `${Math.round(p * 1000) / 10}%`;

export function openSplitEditor(ym) {
  const people = M.people();
  const cur = db.all('splits').find(s => s.ym === ym);
  const eff = M.splitFor(ym);
  const prev = cur || eff.source || {};
  const mode = prev.mode === 'pct' ? 'pct' : 'income';
  const inputs = {};
  const modeSel = h('select', null,
    h('option', { value: 'income', selected: mode === 'income' }, 'Según sueldos (se calcula el %)'),
    h('option', { value: 'pct', selected: mode === 'pct' }, 'Porcentaje directo'));
  const grid = h('div', { class: 'grid-people' });
  const drawGrid = () => {
    const isIncome = modeSel.value === 'income';
    fill(grid, ...people.map(p => {
      const initial = isIncome ? (prev.incomes ? prev.incomes[p.id] : '') : (prev.pct ? Math.round(prev.pct[p.id] * 1000) / 10 : Math.round((eff.pct[p.id] || 0) * 1000) / 10);
      const inp = h('input', { type: 'text', inputmode: 'decimal', value: numText(initial ?? ''), placeholder: isIncome ? 'Sueldo mensual' : '%' });
      inputs[p.id] = inp;
      return h('label', { class: 'field' }, h('span', null, `${p.name} ${isIncome ? '(sueldo)' : '(%)'}`), inp);
    }));
  };
  modeSel.addEventListener('change', drawGrid);
  drawGrid();
  const m = modal(`Reparto desde ${M.monthName(ym)}`, h('div', null,
    h('p', { class: 'muted' }, 'Aplica desde este mes hasta que definas otro cambio. Los meses anteriores no se modifican.'),
    h('label', { class: 'field' }, h('span', null, 'Cómo se reparte'), modeSel), grid), {
    actions: [
      cur ? h('button', { class: 'btn danger ghost', onclick: async () => { await db.del('splits', cur.id); m.close(); toast('Cambio de reparto eliminado'); } }, 'Quitar cambio') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => {
        const vals = {};
        for (const p of people) vals[p.id] = parseNum(inputs[p.id].value);
        if (people.some(p => !Number.isFinite(vals[p.id]) || vals[p.id] < 0) || Object.values(vals).reduce((a, b) => a + b, 0) <= 0) { toast('Completa todos los valores'); return; }
        const rec = { ...(cur || {}), ym, mode: modeSel.value };
        delete rec.incomes; delete rec.pct;
        if (modeSel.value === 'income') rec.incomes = vals;
        else { const t = Object.values(vals).reduce((a, b) => a + b, 0); rec.pct = {}; for (const p of people) rec.pct[p.id] = vals[p.id] / t; }
        await db.put('splits', rec);
        m.close(); toast('Reparto actualizado');
      } }, 'Guardar')],
  });
}

function summaryText(led) {
  const base = M.base();
  const tr = M.settleSummary(led.balance);
  const lines = [`Cierre ${M.monthName(led.ym)}`, ''];
  const ppl = M.people();
  lines.push(`Gastos compartidos: ${M.fmt(led.total, base)}`);
  lines.push(`Reparto: ${ppl.map(p => `${p.name} ${pctText(led.pct[p.id])}`).join(' · ')}`);
  lines.push('');
  for (const l of led.lines) {
    lines.push(`• ${l.cat ? l.cat.name : 'Sin categoría'}: ${M.fmt(l.total, base)}`);
  }
  lines.push('');
  for (const p of ppl) lines.push(`${p.name}: pagó ${M.fmt(led.paid[p.id], base)}, le corresponde ${M.fmt(led.owed[p.id], base)}`);
  if (Object.values(led.carry).some(v => Math.abs(v) > 0.5)) {
    lines.push('', 'Saldo anterior: ' + (M.settleSummary(led.carry).map(t => `${M.personName(t.from)} debe ${M.fmt(t.amount, base)} a ${M.personName(t.to)}`).join(', ') || 'al día'));
  }
  lines.push('', tr.length ? '➡️ ' + tr.map(t => `${M.personName(t.from)} paga ${M.fmt(t.amount, base)} a ${M.personName(t.to)}`).join(' · ') : '✅ Están al día');
  return lines.join('\n');
}

export function renderClose(root) {
  if (!st.ym) st.ym = M.addMonths(M.curYm(), M.todayStr().slice(8) <= '10' ? -1 : 0);
  const ym = st.ym;
  const base = M.base();
  const ppl = M.people();
  const led = M.ledger(ym);
  const tr = M.settleSummary(led.balance);
  const nav = h('div', { class: 'monthnav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Mes anterior', onclick: () => { st.ym = M.addMonths(ym, -1); renderClose(root); } }, '‹'),
    h('strong', null, M.monthName(ym)),
    h('button', { class: 'icon-btn', 'aria-label': 'Mes siguiente', onclick: () => { st.ym = M.addMonths(ym, 1); renderClose(root); } }, '›'));

  if (ppl.length < 2) {
    fill(root, h('p', { class: 'empty' }, 'Agrega una segunda persona en Más › Personas para repartir gastos compartidos.'));
    return;
  }

  const src = led.source;
  const srcText = !src ? 'partes iguales (sin sueldos definidos)' : src.mode === 'income'
    ? 'según sueldos: ' + ppl.map(p => `${p.name} ${M.fmt((src.incomes || {})[p.id] || 0, base)}`).join(' / ')
    : 'porcentaje fijo';
  const own = M.ownerId();

  const detailFor = (catId) => M.sortTx(M.txsInMonth(ym).filter(t => (t.kind === 'out' || t.kind === 'in') && (t.categoryId || '_') === catId && t.alloc && (t.alloc === 'shared' || t.alloc.startsWith('p:'))));

  const result = tr.length
    ? h('div', null, tr.map(t => h('div', { class: 'big' }, `${M.personName(t.from)} → ${M.personName(t.to)}  ${M.fmt(t.amount, base)}`)))
    : h('div', { class: 'big ok' }, 'Al día ✓');

  fill(root, 
    nav,
    h('section', { class: 'card hero' },
      h('div', { class: 'label' }, 'A pagar este cierre'),
      result,
      Object.values(led.carry).some(v => Math.abs(v) > 0.5)
        ? h('div', { class: 'muted small' }, `Incluye saldo anterior (desde ${M.monthName(led.start)}): ${M.settleSummary(led.carry).map(t => `${M.personName(t.from)} debe ${M.fmt(t.amount, base)} a ${M.personName(t.to)}`).join(', ')}`) : null,
      h('div', { class: 'actions' },
        tr.length ? h('button', { class: 'btn primary', onclick: () => openTxForm(null, { kind: 'settle', paidBy: tr[0].from, to: tr[0].to, amount: String(Math.round(tr[0].amount)), settleMonth: ym, date: M.todayStr(), currency: base, accountId: null }) }, 'Registrar pago') : null,
        h('button', { class: 'btn', onclick: async () => {
          const text = summaryText(led);
          if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
          try { await navigator.clipboard.writeText(text); toast('Resumen copiado'); } catch { modal('Resumen', h('pre', { class: 'pre' }, text)); }
        } }, 'Compartir resumen'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Reparto del mes'), h('button', { class: 'btn small', onclick: () => openSplitEditor(ym) }, 'Cambiar')),
      h('div', { class: 'pctbar' }, ppl.map(p => h('div', { style: { flex: String(Math.max(led.pct[p.id], 0.001)) }, class: 'pct p' + ppl.indexOf(p) }, `${p.name} ${pctText(led.pct[p.id])}`))),
      h('div', { class: 'muted small' }, srcText + (src && src.ym !== ym ? ` · vigente desde ${M.monthName(src.ym)}` : ''))),
    h('section', { class: 'card' },
      h('h3', null, 'Quién pagó y qué le corresponde'),
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th'), ppl.map(p => h('th', { class: 'r' }, p.name)))),
        h('tbody', null,
          h('tr', null, h('td', null, 'Pagó'), ppl.map(p => h('td', { class: 'r' }, M.fmt(led.paid[p.id], base)))),
          h('tr', null, h('td', null, 'Le corresponde'), ppl.map(p => h('td', { class: 'r' }, M.fmt(led.owed[p.id], base)))),
          h('tr', null, h('td', null, 'Pagos entre ustedes'), ppl.map(p => h('td', { class: 'r' }, M.fmt(led.gave[p.id] - led.got[p.id], base, { sign: true })))),
          h('tr', { class: 'tot' }, h('td', null, 'Saldo del mes'), ppl.map(p => h('td', { class: 'r ' + (led.net[p.id] < -0.5 ? 'neg' : '') }, M.fmt(led.net[p.id], base, { sign: true }))))),
      ),
      h('div', { class: 'muted small' }, 'Saldo positivo = le deben; negativo = debe.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Detalle por categoría'), h('span', { class: 'muted' }, M.fmt(led.total, base))),
      led.lines.length ? led.lines.map(l => h('details', { class: 'cat-detail' },
        h('summary', null, h('span', { class: 'cd-name' }, ((l.cat && l.cat.icon) || '') + ' ' + (l.cat ? l.cat.name : 'Sin categoría')),
          h('span', { class: 'cd-vals' }, h('b', null, M.fmt(l.total, base)), h('small', null, ppl.map(p => `${p.name} ${M.fmt(l.owed[p.id] || 0, base)}`).join(' · ')))),
        h('div', { class: 'inner' }, detailFor(l.cat ? l.cat.id : '_').map(t => txRow(t, { showDate: true }))))) : h('p', { class: 'empty' }, 'No hay gastos compartidos en este mes.')),
    led.settlements.length ? h('section', { class: 'card' }, h('h3', null, 'Pagos registrados para este cierre'), led.settlements.map(t => txRow(t, { showDate: true }))) : null);
}
