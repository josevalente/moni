import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h } from '../ui.js';
import { openTxForm } from './add.js';

export function txRow(tx, { showDate = false } = {}) {
  const cat = M.category(tx.categoryId);
  const acc = M.account(tx.accountId);
  const ppl = M.people();
  let title, sub = [], sign = 0, cls = '';
  if (tx.kind === 'transfer') {
    title = `${(acc || {}).name || '?'} → ${(M.account(tx.toAccountId) || {}).name || '?'}`; cls = 'transfer';
  } else if (tx.kind === 'settle') {
    title = `Pago ${M.personName(tx.paidBy)} → ${M.personName(tx.to)}`;
    sub.push(`cierre ${M.monthName(M.settleMonthOf(tx))}`); cls = 'transfer';
  } else {
    title = (cat ? ((cat.icon ? cat.icon + ' ' : '') + cat.name) : 'Sin categoría');
    sign = tx.kind === 'in' ? 1 : -1;
    cls = sign > 0 ? 'pos' : '';
  }
  if (tx.desc) sub.unshift(tx.desc);
  if (tx.kind !== 'transfer' && tx.kind !== 'settle') {
    if (tx.alloc === 'shared') sub.push('compartido');
    else if (tx.alloc && tx.alloc.startsWith('p:')) sub.push(`solo de ${M.personName(tx.alloc.slice(2))}`);
    if (ppl.length > 1 && tx.paidBy !== M.ownerId()) sub.push(`pagó ${M.personName(tx.paidBy)}`);
    else if (acc && ppl.length > 0) sub.push(acc.name);
  }
  if (tx.tag) sub.push('#' + tx.tag);
  const base = M.base();
  return h('button', { class: 'row tx ' + cls, onclick: () => openTxForm(tx) },
    h('div', { class: 'main' },
      h('div', { class: 'title' }, title),
      h('div', { class: 'sub' }, (showDate ? tx.date.slice(8) + '/' + tx.date.slice(5, 7) + ' · ' : '') + sub.join(' · '))),
    h('div', { class: 'amt' },
      h('div', null, M.fmt(sign * tx.amount, tx.currency, { sign: sign > 0 })),
      tx.currency !== base ? h('div', { class: 'sub' }, `≈ ${M.fmt(M.txBase(tx), base)}`) : null));
}

const state = { ym: null, q: '', filter: 'all' };

export function renderTxs(root) {
  if (!state.ym) state.ym = M.curYm();
  const search = h('input', { type: 'search', placeholder: 'Buscar en todo el historial…', value: state.q });
  search.addEventListener('input', () => { state.q = search.value; draw(); });
  const list = h('div', { class: 'list' });
  const head = h('div', { class: 'monthnav' });

  const filters = [['all', 'Todos'], ['out', 'Gastos'], ['in', 'Ingresos'], ['shared', 'Compartidos'], ['other', 'Transf./pagos']];
  const chips = h('div', { class: 'chips scroll' });

  function match(tx) {
    const f = state.filter;
    if (f === 'out' && tx.kind !== 'out') return false;
    if (f === 'in' && tx.kind !== 'in') return false;
    if (f === 'shared' && tx.alloc !== 'shared') return false;
    if (f === 'other' && tx.kind !== 'transfer' && tx.kind !== 'settle') return false;
    const q = state.q.trim().toLowerCase();
    if (q) {
      const cat = M.category(tx.categoryId);
      const hay = `${tx.desc || ''} ${cat ? cat.name : ''} ${tx.tag || ''} ${tx.amount} ${(M.account(tx.accountId) || {}).name || ''}`.toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  }

  function draw() {
    const q = state.q.trim();
    fill(chips, ...filters.map(([k, l]) => h('button', { class: 'chip' + (state.filter === k ? ' on' : ''), onclick: () => { state.filter = k; draw(); } }, l)));
    fill(head, q ? h('div', { class: 'muted' }, 'Resultados en todo el historial') : [
      h('button', { class: 'icon-btn', onclick: () => { state.ym = M.addMonths(state.ym, -1); draw(); }, 'aria-label': 'Mes anterior' }, '‹'),
      h('strong', null, M.monthName(state.ym)),
      h('button', { class: 'icon-btn', onclick: () => { state.ym = M.addMonths(state.ym, 1); draw(); }, 'aria-label': 'Mes siguiente' }, '›'),
    ]);
    let txs = q ? db.all('tx') : M.txsInMonth(state.ym);
    txs = M.sortTx(txs.filter(match));
    const total = txs.length;
    if (q) txs = txs.slice(0, 300);
    const out = [];
    let last = '';
    let sumOut = 0, sumIn = 0;
    for (const tx of txs) {
      if (tx.kind === 'out') sumOut += M.txBase(tx); else if (tx.kind === 'in') sumIn += M.txBase(tx);
      if (tx.date !== last) {
        last = tx.date;
        const d = new Date(tx.date + 'T12:00:00');
        out.push(h('div', { class: 'dayhead' }, d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'short', year: q ? 'numeric' : undefined })));
      }
      out.push(txRow(tx));
    }
    if (!txs.length) out.push(h('p', { class: 'empty' }, q ? 'Nada coincide con la búsqueda.' : 'Sin movimientos este mes.'));
    if (q && total > 300) out.push(h('p', { class: 'muted center' }, `Mostrando 300 de ${total}. Afina la búsqueda.`));
    fill(list, ...out);
    summary.textContent = txs.length ? `${total} mov. · gastos ${M.fmt(sumOut, M.base())} · ingresos ${M.fmt(sumIn, M.base())}` : '';
  }
  const summary = h('div', { class: 'muted center small' });
  fill(root, h('div', { class: 'toolbar' }, search, chips), head, summary, list);
  draw();
  return draw;
}
