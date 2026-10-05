import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, bars } from '../ui.js';
import { txRow } from './txs.js';

const st = { mode: 'total', ym: null };

export function settleText(balance, ym) {
  const tr = M.settleSummary(balance);
  if (!tr.length) return { text: 'Están al día', amount: 0, tr };
  return { text: tr.map(t => `${M.personName(t.from)} debe a ${M.personName(t.to)}`).join(' · '), amount: tr.reduce((a, t) => a + t.amount, 0), tr };
}

export function renderHome(root) {
  if (!st.ym) st.ym = M.curYm();
  const base = M.base();
  const nw = M.netWorth();
  const ym = st.ym;
  const led = M.ledger(ym);
  const sum = settleText(led.balance, ym);
  const spend = M.spendingByCategory(ym, st.mode);
  const income = M.incomeOfMonth(ym, st.mode === 'mine' ? M.meId() : null);
  const balances = M.accountBalances();
  // últimos 6: se ordenan solo los de las últimas semanas (no los ~7.000 del historial)
  const cut = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  let cand = db.all('tx').filter(t => t.kind !== 'settle' && t.date >= cut);
  if (cand.length < 6) cand = db.all('tx').filter(t => t.kind !== 'settle');
  const recents = M.sortTx(cand).slice(0, 6);
  const multi = M.people().length > 1;

  const accRows = M.accounts().map(a => ({ a, v: balances.get(a.id) || 0 })).filter(x => Math.abs(x.v) > 0.004 || x.a.type !== 'credit');
  const monthNav = h('div', { class: 'monthnav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Mes anterior', onclick: () => { st.ym = M.addMonths(ym, -1); renderHome(root); } }, '‹'),
    h('strong', null, M.monthName(ym)),
    h('button', { class: 'icon-btn', 'aria-label': 'Mes siguiente', onclick: () => { st.ym = M.addMonths(ym, 1); renderHome(root); } }, '›'));

  fill(root, 
    h('section', { class: 'card hero' },
      h('div', { class: 'label' }, 'Patrimonio neto'),
      h('div', { class: 'big' }, M.fmt(nw.total, base)),
      h('div', { class: 'breakdown' },
        h('div', null, h('span', null, 'Cuentas'), M.fmt(nw.cash, base)),
        h('div', null, h('span', null, 'Tarjetas'), M.fmt(nw.cards, base)),
        h('div', null, h('span', null, 'Inversiones'), M.fmt(nw.inv, base)),
        h('div', null, h('span', null, 'Deudas'), M.fmt(nw.debts, base))),
      nw.missing.length ? h('div', { class: 'warn' }, `Falta tipo de cambio de ${nw.missing.join(', ')}; se asumió 1. Actualízalo en Más › Monedas.`) : null),
    monthNav,
    multi ? h('button', { class: 'card settle', onclick: () => { location.hash = '#/cierre'; } },
      h('div', { class: 'label' }, `Cobro del mes · ${M.monthShort(ym)}`),
      h('div', { class: 'big' }, sum.amount ? M.fmt(sum.amount, base) : '—'),
      h('div', { class: 'muted' }, sum.text), h('div', { class: 'muted small' }, 'Toca para ver el detalle del cierre')) : null,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, 'Gasto por categoría'),
        multi ? h('div', { class: 'seg small' },
          h('button', { class: st.mode === 'total' ? 'on' : '', onclick: () => { st.mode = 'total'; renderHome(root); } }, 'Hogar'),
          h('button', { class: st.mode === 'mine' ? 'on' : '', onclick: () => { st.mode = 'mine'; renderHome(root); } }, 'Mi parte')) : null),
      h('div', { class: 'kpis' },
        h('div', null, h('span', null, 'Gastos'), M.fmt(spend.total, base)),
        h('div', null, h('span', null, 'Ingresos'), M.fmt(income, base)),
        h('div', null, h('span', null, 'Balance'), M.fmt(income - spend.total, base))),
      spend.rows.length ? bars(spend.rows.slice(0, 10).map(r => ({ label: ((r.cat.icon || '') + ' ' + r.cat.name).trim(), v: r.v })), { fmt: (v) => M.fmt(v, base) })
        : h('p', { class: 'empty' }, 'Aún no hay gastos este mes.')),
    h('section', { class: 'card' },
      h('h3', null, 'Cuentas'),
      accRows.length ? accRows.map(({ a, v }) => h('div', { class: 'row static' },
        h('div', { class: 'main' }, h('div', { class: 'title' }, a.name), h('div', { class: 'sub' }, a.type === 'credit' ? 'Tarjeta / crédito' : a.type === 'cash' ? 'Efectivo' : 'Cuenta')),
        h('div', { class: 'amt ' + (v < 0 ? 'neg' : '') }, M.fmt(v, a.currency)))) : h('p', { class: 'empty' }, 'Sin cuentas. Agrégalas en Más › Cuentas.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Últimos movimientos'), h('a', { href: '#/movs' }, 'Ver todos')),
      recents.length ? recents.map(t => txRow(t, { showDate: true })) : h('p', { class: 'empty' }, 'Toca ＋ para registrar tu primer movimiento.')));
}
