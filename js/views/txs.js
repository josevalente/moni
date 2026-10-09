import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal } from '../ui.js';
import { openTxForm } from './add.js';
import { renderAccount, openAccount } from './account.js';
import { entryCalendar } from './insights.js';

export function txRow(tx, { showDate = false } = {}) {
  const cat = M.category(tx.categoryId);
  const acc = M.account(tx.accountId);
  const ppl = M.people();
  const base = M.base();
  let title, sub = [], cls = '', amount;
  if (tx.kind === 'transfer') {
    const to = M.account(tx.toAccountId);
    title = `${(acc || {}).name || '?'} → ${(to || {}).name || '?'}`; cls = 'transfer';
    amount = M.fmt(tx.amount, tx.currency) + (tx.toAmount != null && to && to.currency !== tx.currency ? ` → ${M.fmt(tx.toAmount, to.currency)}` : '');
  } else if (tx.kind === 'settle') {
    title = `Pago ${M.personName(tx.paidBy)} → ${M.personName(tx.to)}`;
    sub.push(`cierre ${M.monthName(M.settleMonthOf(tx))}`); cls = 'transfer';
    if (acc) sub.push(acc.name);
    amount = M.fmt(tx.amount, tx.currency);
  } else {
    title = (cat ? ((cat.icon ? cat.icon + ' ' : '') + cat.name) : 'Sin categoría');
    const sign = tx.kind === 'in' ? 1 : -1;
    cls = sign > 0 ? 'pos' : '';
    amount = M.fmt(sign * tx.amount, tx.currency, { sign: sign > 0 });
  }
  if (tx.desc) sub.unshift(tx.desc);
  if (tx.kind !== 'transfer' && tx.kind !== 'settle') {
    if (tx.alloc === 'shared') sub.push('compartido');
    else if (tx.alloc && tx.alloc.startsWith('p:')) sub.push(`solo de ${M.personName(tx.alloc.slice(2))}`);
    if (ppl.length > 1 && tx.paidBy !== M.ownerId()) sub.push(`pagó ${M.personName(tx.paidBy)}`);
    else if (acc && ppl.length > 0) sub.push(acc.name);
  }
  if (tx.tag) sub.push('#' + tx.tag);
  return h('button', { class: 'row tx ' + cls, onclick: () => openTxForm(tx) },
    h('div', { class: 'main' },
      h('div', { class: 'title' }, title),
      h('div', { class: 'sub' }, (showDate ? tx.date.slice(8) + '/' + tx.date.slice(5, 7) + (tx.date.slice(0, 4) !== M.todayStr().slice(0, 4) ? '/' + tx.date.slice(2, 4) : '') + ' · ' : '') + sub.join(' · '))),
    h('div', { class: 'amt' },
      h('div', null, amount),
      tx.currency !== base ? h('div', { class: 'sub' }, `≈ ${M.fmt(M.txBase(tx), base)}`) : null));
}

const state = { ym: null, q: '', filter: 'all' };

// Elegir una cuenta para ver su cartola (con su saldo y cuándo cuadró con el banco).
export function pickAccount() {
  const bal = M.accountBalances();
  const row = (a) => h('button', { class: 'row', onclick: () => { m.close(); openAccount(a.id); } },
    h('div', { class: 'main' },
      h('div', { class: 'title' }, a.name),
      h('div', { class: 'sub' }, [a.currency, a.reconciled && a.reconciled.date ? `✓ cuadró ${new Date(a.reconciled.date + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'amt' + ((bal.get(a.id) || 0) < 0 ? ' neg' : '') }, M.fmt(bal.get(a.id) || 0, a.currency)),
    h('div', { class: 'chev' }, '›'));
  const archived = db.all('accounts').filter(a => a.archived);
  const m = modal('Ver por cuenta', h('div', null,
    h('div', { class: 'list' }, M.accounts().map(row)),
    archived.length ? [h('h4', null, 'Archivadas'), h('div', { class: 'list' }, archived.map(row))] : null));
}

export function renderTxs(root, sub) {
  if (sub) return renderAccount(root, sub);
  if (!state.ym) state.ym = M.curYm();
  const search = h('input', { type: 'search', placeholder: 'Buscar en todo el historial…', value: state.q, 'aria-label': 'Buscar movimientos' });
  let timer;
  search.addEventListener('input', () => { state.q = search.value; clearTimeout(timer); timer = setTimeout(draw, 160); });
  const list = h('div', { class: 'list' });
  const head = h('div', { class: 'monthnav' });

  const filters = [['all', 'Todos'], ['out', 'Gastos'], ['in', 'Ingresos'], ['shared', 'Compartidos'], ['other', 'Transf./pagos']];
  const chips = h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Filtro' });

  function match(tx, words) {
    const f = state.filter;
    if (f === 'out' && tx.kind !== 'out') return false;
    if (f === 'in' && tx.kind !== 'in') return false;
    if (f === 'shared' && tx.alloc !== 'shared') return false;
    if (f === 'other' && tx.kind !== 'transfer' && tx.kind !== 'settle') return false;
    if (words.length) {
      const cat = M.category(tx.categoryId);
      const hay = `${tx.desc || ''} ${cat ? cat.name : ''} ${tx.tag || ''} ${tx.amount} ${(M.account(tx.accountId) || {}).name || ''}`.toLowerCase();
      // "12.500" también encuentra el monto 12500
      if (!words.every(w => hay.includes(w.text) || (w.num != null && Math.abs(tx.amount - w.num) < 0.005))) return false;
    }
    return true;
  }

  function draw() {
    const q = state.q.trim();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).map(text => ({ text, num: /^-?[\d.,]+$/.test(text) && Number.isFinite(M.parseAmount(text)) ? M.parseAmount(text) : null }));
    fill(cal, q ? null : entryCalendar(state.ym));
    fill(chips, h('button', { class: 'chip more', onclick: pickAccount }, '🏦 Por cuenta'),
      ...filters.map(([k, l]) => h('button', { class: 'chip' + (state.filter === k ? ' on' : ''), 'aria-pressed': String(state.filter === k), onclick: () => { state.filter = k; draw(); } }, l)));
    fill(head, q ? h('div', { class: 'muted' }, 'Resultados en todo el historial') : [
      h('button', { class: 'icon-btn', onclick: () => { state.ym = M.addMonths(state.ym, -1); draw(); }, 'aria-label': 'Mes anterior' }, '‹'),
      h('strong', null, M.monthName(state.ym)),
      h('button', { class: 'icon-btn', onclick: () => { state.ym = M.addMonths(state.ym, 1); draw(); }, 'aria-label': 'Mes siguiente' }, '›'),
    ]);
    let txs = q ? db.all('tx') : M.txsInMonth(state.ym);
    txs = M.sortTx(txs.filter(t => match(t, words)));
    const total = txs.length;
    // totales sobre todo lo encontrado; solo gastos e ingresos reales (no inversión, préstamo ni ajuste)
    let sumOut = 0, sumIn = 0;
    for (const tx of txs) {
      const cat = M.category(tx.categoryId);
      if (!cat) continue;
      if (cat.kind === 'expense') sumOut += (tx.kind === 'in' ? -1 : 1) * M.txBase(tx) * M.expenseFactor(tx, cat);
      else if (cat.kind === 'income' && tx.kind === 'in') sumIn += M.txBase(tx);
    }
    const shown = q ? txs.slice(0, 300) : txs;
    const out = [];
    let last = '';
    for (const tx of shown) {
      if (tx.date !== last) {
        last = tx.date;
        const d = new Date(tx.date + 'T12:00:00');
        out.push(h('div', { class: 'dayhead' }, d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'short', year: q ? 'numeric' : undefined })));
      }
      out.push(txRow(tx));
    }
    if (!shown.length) out.push(h('p', { class: 'empty' }, q ? 'Nada coincide con la búsqueda.' : 'Sin movimientos este mes.'));
    if (q && total > 300) out.push(h('p', { class: 'muted center' }, `Mostrando 300 de ${M.fmtInt(total)}. Afina la búsqueda.`));
    fill(list, ...out);
    summary.textContent = total ? `${M.fmtInt(total)} mov. · gastos ${M.fmt(sumOut, M.base())} · ingresos ${M.fmt(sumIn, M.base())}` : '';
  }
  const summary = h('div', { class: 'muted center small' });
  const cal = h('div');
  fill(root, h('div', { class: 'toolbar' }, search, chips), cal, head, summary, list);
  draw();
  return draw;
}
