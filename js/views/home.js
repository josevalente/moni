// Inicio: primero lo que hay que hacer (pendientes), luego el mes, y al final el panorama.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, bars, modal, toast } from '../ui.js';
import { txRow } from './txs.js';
import { openCategoryDetail } from './reports.js';
import { openTxForm } from './add.js';
import { showCloseMonth } from './close.js';
import { exportBackup } from './settings.js';
import { openAccount } from './account.js';
import { paceCard, netWorthTrend, openNetWorth } from './insights.js';
import { sparkline } from '../charts.js';
import { unusualCard, forecastAlert } from './analysis.js';

const st = { mode: 'total', ym: null, laterOpen: false, zeroOpen: false, fixedOpen: false };

export function settleText(balance) {
  const tr = M.settleSummary(balance);
  if (!tr.length) return { text: 'Están al día', amount: 0, tr };
  return { text: tr.map(t => `${M.personName(t.from)} debe a ${M.personName(t.to)}`).join(' · '), amount: tr.reduce((a, t) => a + t.amount, 0), tr };
}

const lastBackup = () => { try { return localStorage.getItem('moni.lastBackup'); } catch { return null; } };
export const pendingNow = () => M.pendingItems(M.curYm(), { lastBackup: lastBackup() });
const usableAcc = (id) => { const a = id && M.account(id); return a && !a.archived ? id : null; };
const ago = (days) => (days === Infinity ? null : days >= 60 ? `hace ${Math.round(days / 30)} meses` : `hace ${days} días`);

// ---- Pendientes del mes -----------------------------------------------------------

// Cuenta fija de monto estable: se registra en un toque con el monto de la última vez.
async function registerFixed(b) {
  const t = b.template;
  const owner = M.ownerId();
  const tx = {
    kind: 'out', date: M.todayStr(), amount: t.amount, currency: t.currency, categoryId: b.catId,
    alloc: t.alloc || 'none', paidBy: t.paidBy, accountId: t.paidBy === owner ? usableAcc(t.accountId) : null, desc: t.desc || '',
  };
  Object.assign(tx, FX.fxFields(t.currency, tx.date));
  const saved = await db.put('tx', tx);
  toast(`${b.cat.name} registrado: ${M.fmt(t.amount, t.currency)}`, { label: 'Deshacer', onAction: () => db.del('tx', saved.id) });
}

// Todas las cuentas fijas que vencen, en un toque (una sola escritura y un solo "Deshacer").
async function registerMany(list) {
  const owner = M.ownerId();
  const today = M.todayStr();
  const txs = list.map(b => {
    const t = b.template;
    const tx = { id: db.uid(), kind: 'out', date: today, amount: t.amount, currency: t.currency, categoryId: b.catId,
      alloc: t.alloc || 'none', paidBy: t.paidBy, accountId: t.paidBy === owner ? usableAcc(t.accountId) : null, desc: t.desc || '' };
    Object.assign(tx, FX.fxFields(t.currency, today));
    return tx;
  });
  await db.putMany('tx', txs);
  toast(`${txs.length} cuentas fijas registradas`, { label: 'Deshacer', onAction: () => db.delMany('tx', txs.map(t => t.id)), ms: 8000 });
}

// Cuenta fija de monto variable (luz, agua…): abre el formulario listo, solo falta el monto.
function registerVariable(b) {
  const t = b.template;
  const owner = M.ownerId();
  openTxForm(null, {
    kind: 'out', categoryId: b.catId, desc: t.desc || '', paidBy: t.paidBy, alloc: t.alloc || 'none',
    accountId: t.paidBy === owner ? usableAcc(t.accountId) : null,
    lastAmount: { amount: t.amount, currency: t.currency }, focus: 'amount',
  });
}

function skipBill(b, ref) {
  const m = modal(b.cat.name, h('p', null, `¿Qué hacemos con "${b.cat.name}" este mes?`), {
    actions: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn', onclick: async () => { m.close(); await M.skipPending(b.catId, ref, { forever: true }); toast(`"${b.cat.name}" no se volverá a recordar`); } }, 'No recordar más'),
      h('button', { class: 'btn primary', onclick: async () => { m.close(); await M.skipPending(b.catId, ref); toast('Omitido este mes'); } }, 'Omitir este mes'),
    ],
  });
}

function pendingRow(i, ref, root) {
  const base = M.base();
  let icon, title, sub, action;
  if (i.type === 'bill') {
    icon = i.cat.icon || '🧾';
    title = i.cat.name;
    sub = `~día ${i.day} · ${i.fixed ? '' : 'último '}${M.fmt(i.template.amount, i.template.currency)}`;
    action = i.fixed
      ? h('button', { class: 'btn small', onclick: () => registerFixed(i) }, 'Registrar')
      : h('button', { class: 'btn small', onclick: () => registerVariable(i) }, 'Registrar…');
  } else if (i.type === 'close') {
    icon = '⚖️';
    title = `Cierre de ${M.monthName(i.ym).toLowerCase()}`;
    sub = i.transfers.map(t => `${M.personName(t.from)} paga ${M.fmt(t.amount, base)} a ${M.personName(t.to)}`).join(' · ');
    action = h('button', { class: 'btn small', onclick: () => showCloseMonth(i.ym) }, 'Ver cierre');
  } else if (i.type === 'recon') {
    icon = '🏦';
    title = `Cuadrar ${i.acc.name} con el banco`;
    sub = `La última vez fue el ${new Date(i.since + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })} (${ago(i.days)})`;
    action = h('button', { class: 'btn small', onclick: () => openAccount(i.acc.id) }, 'Cuadrar');
  } else if (i.type === 'invest') {
    icon = '📈';
    const f = i.funds;
    title = f.length === 1 ? `${f[0].name} sin actualizar` : `${f.length} inversiones sin actualizar`;
    sub = `${f.slice(0, 3).map(x => x.name).join(', ')}${f.length > 3 ? ` y ${f.length - 3} más` : ''} · ${ago(f[0].days)}`;
    action = h('button', { class: 'btn small', onclick: () => { location.hash = '#/mas/inversiones'; } }, 'Actualizar');
  } else {
    icon = '💾';
    title = i.days === Infinity ? 'Aún no has hecho un respaldo' : `Respaldo ${ago(i.days)}`;
    sub = 'Tus datos están solo en este teléfono';
    action = h('button', { class: 'btn small', onclick: async () => { await exportBackup(); renderHome(root); } }, 'Respaldar');
  }
  return h('div', { class: 'row static pend-row' },
    h('div', { class: 'icon', 'aria-hidden': 'true' }, icon),
    h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'row-actions' }, action,
      i.type === 'bill' ? h('button', { class: 'icon-btn small', 'aria-label': `Omitir ${i.cat.name}`, onclick: () => skipBill(i, ref) }, '✕') : null,
      i.type === 'recon' ? h('button', { class: 'icon-btn small', 'aria-label': `Omitir este mes: cuadrar ${i.acc.name}`, onclick: async () => {
        await M.skipPending('recon:' + i.acc.id, ref);
        toast('Omitido este mes');
      } }, '✕') : null));
}

function pendingCard(root) {
  const ref = M.curYm();
  const { items, bills, done } = pendingNow();
  if (!items.length) return null;
  const day = Number(M.todayStr().slice(8));
  // cuentas fijas que vencen en los próximos 5 días (o ya pasaron); el resto, plegado
  const soon = items.filter(i => i.type !== 'bill' || i.day <= day + 5);
  const later = items.filter(i => i.type === 'bill' && i.day > day + 5);
  // las fijas que vencen se agrupan en una fila con "Registrar todas"
  const fixedSoon = soon.filter(i => i.type === 'bill' && i.fixed);
  const grouped = fixedSoon.length >= 2;
  const rest = soon.filter(i => !(grouped && i.type === 'bill' && i.fixed));
  const fixedTotal = fixedSoon.reduce((a, b) => a + M.txBase(b.template), 0);
  const names = fixedSoon.map(b => b.cat.name);
  const canBadge = 'setAppBadge' in navigator && typeof Notification !== 'undefined' && Notification.permission === 'default';
  return h('section', { class: 'card pend' },
    h('div', { class: 'card-head' },
      h('h3', null, `Pendientes de ${M.monthName(ref).split(' ')[0].toLowerCase()}`),
      bills ? h('span', { class: 'muted small' }, `${done} de ${bills} fijos`) : null),
    bills ? h('div', { class: 'pend-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(bills), 'aria-valuenow': String(done), 'aria-label': 'Cuentas fijas registradas' },
      h('div', { style: { width: (done / bills * 100) + '%' } })) : null,
    grouped ? h('div', { class: 'row static pend-row pend-group' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🧾'),
      h('div', { class: 'main' },
        h('div', { class: 'title' }, `${fixedSoon.length} cuentas fijas`),
        h('div', { class: 'sub' }, `${M.fmt(fixedTotal, M.base())} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` y ${names.length - 3} más` : ''}`)),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn small primary', onclick: () => registerMany(fixedSoon) }, 'Registrar todas'))) : null,
    grouped ? h('button', { class: 'link-row small', onclick: () => { st.fixedOpen = !st.fixedOpen; renderHome(root); } }, st.fixedOpen ? 'Ocultar el detalle' : 'Ver una por una') : null,
    grouped && st.fixedOpen ? fixedSoon.map(i => pendingRow(i, ref, root)) : null,
    rest.map(i => pendingRow(i, ref, root)),
    later.length ? h('button', { class: 'link-row', onclick: () => { st.laterOpen = !st.laterOpen; renderHome(root); } },
      st.laterOpen ? 'Ocultar las de más adelante' : `${later.length} más adelante este mes`) : null,
    st.laterOpen ? later.map(i => pendingRow(i, ref, root)) : null,
    canBadge ? h('button', { class: 'link-row small', onclick: async () => {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      window.dispatchEvent(new Event('moni:badge'));
      renderHome(root);
    } }, 'Mostrar el número de pendientes en el ícono de la app') : null);
}

// ---- Ingresos del mes por categoría (como el gasto); los extraordinarios, marcados ------------
function incomeCard(ym, base) {
  const pid = st.mode === 'mine' ? M.meId() : null;
  const mx = M.categoryMatrix([ym], { kind: 'income', mode: st.mode, pid });
  const rows = mx.rows.filter(r => r.total > 0);
  if (!rows.length) return null;
  const total = mx.totals[0];
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `Ingresos de ${M.monthName(ym).split(' ')[0].toLowerCase()}`), h('span', { class: 'muted small' }, M.fmt(total, base))),
    bars(rows.slice(0, 8).map(r => {
      const c = M.category(r.catId);
      return { label: `${((c && c.icon) || '')} ${r.label}${c && c.extraordinary ? ' · extraordinario' : ''}`.trim(), v: r.total,
        onclick: () => openCategoryDetail({ catId: r.catId, kind: 'income', mode: st.mode, period: '12' }) };
    }), { fmt: (v) => M.fmt(v, base) }),
    h('div', { class: 'card-foot' }, h('span', { class: 'muted small' }, 'Toca una categoría para ver sus meses y movimientos'),
      h('a', { class: 'btn small', href: '#/reportes', onclick: () => { try { sessionStorage.setItem('moni.reportKind', 'income'); } catch { /* ignore */ } } }, 'Ver mes a mes')));
}

// ---- Inicio -------------------------------------------------------------------------

export function renderHome(root) {
  if (!st.ym) st.ym = M.curYm();
  const base = M.base();
  const ym = st.ym;
  const cur = M.curYm();
  const multi = M.people().length > 1;
  const led = M.ledger(ym);
  const sum = settleText(led.balance);
  const spend = M.spendingByCategory(ym, st.mode);
  const income = M.incomeOfMonth(ym, st.mode === 'mine' ? M.meId() : null);
  const extraIncome = income - M.incomeOfMonth(ym, st.mode === 'mine' ? M.meId() : null, { extraordinary: false });
  // "mes típico": la mediana de los 6 meses cerrados anteriores. Con el promedio, una compra puntual
  // (un auto, una propiedad) lo inflaría y cualquier mes normal parecería bajo.
  const prev6 = M.monthsBetween(M.addMonths(ym, -6), M.addMonths(ym, -1));
  const sorted6 = M.categoryMatrix(prev6, { mode: st.mode }).totals.filter(v => v > 0).sort((a, b) => a - b);
  const avg = sorted6.length ? (sorted6.length % 2 ? sorted6[(sorted6.length - 1) / 2] : (sorted6[sorted6.length / 2 - 1] + sorted6[sorted6.length / 2]) / 2) : 0;
  const delta = avg ? Math.round((spend.total / avg - 1) * 100) : 0;

  const monthNav = h('div', { class: 'monthnav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Mes anterior', onclick: () => { st.ym = M.addMonths(ym, -1); renderHome(root); } }, '‹'),
    h('strong', null, M.monthName(ym)),
    h('button', { class: 'icon-btn', 'aria-label': 'Mes siguiente', onclick: () => { st.ym = M.addMonths(ym, 1); renderHome(root); } }, '›'));

  const tiles = h('div', { class: 'tiles' },
    h('div', { class: 'tile' },
      h('span', { class: 'tile-label' }, `Gastado en ${M.monthName(ym).split(' ')[0].toLowerCase()}${st.mode === 'mine' ? ' (mi parte)' : ''}`),
      h('span', { class: 'tile-value' }, M.fmt(spend.total, base)),
      // el mes en curso está incompleto: se muestra el promedio como referencia, no una variación
      ym === cur || !avg ? h('span', { class: 'tile-delta' }, avg ? `mes típico ${M.fmt(avg, base)}` : '')
        : h('span', { class: 'tile-delta ' + (delta > 0 ? 'up-bad' : 'down-good') }, `${delta > 0 ? '+' : ''}${delta}% vs mes típico`)),
    multi ? h('button', { class: 'tile tappable', onclick: () => showCloseMonth(ym) },
      h('span', { class: 'tile-label' }, 'Cobro del mes'),
      h('span', { class: 'tile-value' }, sum.amount ? M.fmt(sum.amount, base) : 'Al día'),
      h('span', { class: 'tile-delta' }, sum.amount ? sum.text : 'sin saldo pendiente')) : null);

  const nw = M.netWorth();
  const balances = M.accountBalances();
  const accAll = M.accounts().map(a => ({ a, v: balances.get(a.id) || 0 }));
  // en cero: menos de $1 (o de 0,005 en monedas con decimales)
  const isZero = (x) => Math.abs(x.v) < (M.currencyInfo(x.a.currency).decimals ? 0.005 : 1);
  const accMain = accAll.filter(x => !isZero(x));
  const accZero = accAll.filter(isZero);
  // cada cuenta abre su cartola: sus movimientos con el saldo de cada día, para cuadrarla con el banco
  const accRow = ({ a, v }) => h('button', { class: 'row', onclick: () => openAccount(a.id) },
    h('div', { class: 'main' }, h('div', { class: 'title' }, a.name), h('div', { class: 'sub' },
      [a.type === 'credit' ? 'Tarjeta / crédito' : a.type === 'cash' ? 'Efectivo' : 'Cuenta',
        a.reconciled && a.reconciled.date ? `✓ cuadró ${new Date(a.reconciled.date + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'amt ' + (v < 0 ? 'neg' : '') }, M.fmt(v, a.currency)),
    h('div', { class: 'chev', 'aria-hidden': 'true' }, '›'));

  // últimos 6: se ordenan solo los de las últimas semanas (no los ~7.000 del historial)
  const cut = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  let cand = db.all('tx').filter(t => t.kind !== 'settle' && t.date >= cut);
  if (cand.length < 6) cand = db.all('tx').filter(t => t.kind !== 'settle');
  const recents = M.sortTx(cand).slice(0, 6);

  fill(root,
    pendingCard(root),
    monthNav,
    tiles,
    ym === M.curYm() ? forecastAlert() : null,
    paceCard(ym, st.mode),
    unusualCard(ym, st.mode),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, 'Gasto por categoría'),
        multi ? h('div', { class: 'seg small', role: 'group', 'aria-label': 'Alcance' },
          h('button', { class: st.mode === 'total' ? 'on' : '', 'aria-pressed': String(st.mode === 'total'), onclick: () => { st.mode = 'total'; renderHome(root); } }, 'Hogar'),
          h('button', { class: st.mode === 'mine' ? 'on' : '', 'aria-pressed': String(st.mode === 'mine'), onclick: () => { st.mode = 'mine'; renderHome(root); } }, 'Mi parte')) : null),
      spend.rows.length ? bars(spend.rows.slice(0, 10).map(r => ({
        label: ((r.cat.icon || '') + ' ' + r.cat.name).trim(), v: r.v,
        onclick: () => openCategoryDetail({ catId: r.cat.id, kind: 'expense', mode: st.mode, period: '12' }),
      })), { fmt: (v) => M.fmt(v, base) })
        : h('p', { class: 'empty' }, 'Aún no hay gastos este mes.'),
      h('div', { class: 'card-foot' },
        h('span', { class: 'muted small' }, extraIncome
          ? `Ingresos ${M.fmt(income - extraIncome, base)} (+ ${M.fmt(extraIncome, base)} extraordinarios) · balance ${M.fmt(income - extraIncome - spend.total, base)}`
          : `Ingresos ${M.fmt(income, base)} · balance ${M.fmt(income - spend.total, base)}`),
        h('a', { class: 'btn small', href: '#/reportes' }, 'Ver mes a mes'))),
    incomeCard(ym, base),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('div', { class: 'label' }, 'Patrimonio neto'), h('div', { class: 'big' }, M.fmt(nw.total, base))),
        sparkline(netWorthTrend(13))),                       // tendencia de 12 meses (el detalle, en "Ver evolución")
      h('div', { class: 'breakdown' },
        h('div', null, h('span', null, 'Cuentas'), M.fmt(nw.cash, base)),
        h('div', null, h('span', null, 'Tarjetas'), M.fmt(nw.cards, base)),
        h('div', null, h('span', null, 'Inversiones'), M.fmt(nw.inv, base)),
        nw.props ? h('div', null, h('span', null, 'Propiedades'), M.fmt(nw.props, base)) : null,
        h('div', null, h('span', null, 'Deudas'), M.fmt(nw.debts, base)),
        nw.points ? h('div', null, h('span', null, 'Puntos y millas'), M.fmt(nw.points, base)) : null),
      nw.missing.length ? h('div', { class: 'warn' }, `Falta tipo de cambio de ${nw.missing.join(', ')}; se asumió 1. Actualízalo en Más › Monedas.`) : null,
      h('div', { class: 'card-foot' }, h('span'), h('button', { class: 'btn small', onclick: openNetWorth }, 'Ver evolución'))),
    h('section', { class: 'card' },
      h('h3', null, 'Cuentas'),
      accMain.length ? accMain.map(accRow) : h('p', { class: 'empty' }, 'Sin cuentas con saldo. Agrégalas en Más › Cuentas.'),
      accZero.length ? h('button', { class: 'link-row', onclick: () => { st.zeroOpen = !st.zeroOpen; renderHome(root); } },
        st.zeroOpen ? 'Ocultar las cuentas en cero' : `${accZero.length} cuentas en cero`) : null,
      st.zeroOpen ? accZero.map(accRow) : null),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Últimos movimientos'), h('a', { href: '#/movs' }, 'Ver todos')),
      recents.length ? recents.map(t => txRow(t, { showDate: true })) : h('p', { class: 'empty' }, 'Toca ＋ para registrar tu primer movimiento.')));
}
