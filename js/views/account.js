// Cartola de una cuenta: sus movimientos con el saldo de cada día, para compararlos con la app del banco.
// "Cuadrar con el banco": con el saldo que muestra el banco calcula la diferencia, propone las causas más
// probables (repetido, en otra cuenta, mal tipeado…) y ayuda a revisar uno a uno marcando lo que se encuentra.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { confirmDialog, fill, formModal, h, toast } from '../ui.js';
import { openTxForm } from './add.js';
import { txRow } from './txs.js';
import { editAccount } from './settings.js';

// La comparación en curso (saldo del banco, fecha, desde cuándo y lo ya marcado) se guarda en este
// teléfono: iOS puede cerrar la app mientras se mira la del banco.
const KEY = 'moni.recon';
let mem = null;   // si el navegador no deja guardar (modo privado), queda solo en memoria
const allChecks = () => {
  if (mem) return mem;
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return (mem = {}); }
};
export const getCheck = (accId) => allChecks()[accId] || null;
function setCheck(accId, c) {
  const all = allChecks();
  if (c) all[accId] = c; else delete all[accId];
  if (mem) return;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { mem = all; }
}

const st = { accId: null, q: '', limit: 150, onlyOpen: false, backTo: null };
let redraw = () => {};

// Abre la cartola recordando de dónde se vino (para el botón Volver).
export function openAccount(accId) {
  st.backTo = location.hash || '#/';
  location.hash = '#/movs/' + accId;
}

// las sugerencias recorren todo el historial: se recalculan solo si cambian los datos o la diferencia
let dataVersion = 0;
db.subscribe(() => { dataVersion++; });
let hintCache = { key: null, hints: [] };
function hintsFor(cmp) {
  const key = [cmp.acc.id, cmp.diff, cmp.date, cmp.from, dataVersion].join('|');
  if (hintCache.key !== key) hintCache = { key, hints: M.reconcileHints(cmp.acc, cmp.rows, cmp) };
  return hintCache.hints;
}

// ---- formato ------------------------------------------------------------------------------

const isCard = (a) => a.type === 'credit';
// En tarjetas el saldo se lee como deuda (positiva), igual que en la app del banco.
const balWord = (a, v) => (!isCard(a) ? 'saldo' : v <= 0 ? 'deuda' : 'a favor');
const balAmt = (a, v) => M.fmt(isCard(a) ? Math.abs(v) : v, a.currency);
const balText = (a, v) => `${balWord(a, v)} ${balAmt(a, v)}`;
const balNoun = (a, v) => (balWord(a, v) === 'deuda' ? 'la deuda' : 'el saldo');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const yearOpt = (d) => (d.slice(0, 4) !== M.todayStr().slice(0, 4) ? { year: 'numeric' } : {});
const dShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', ...yearOpt(d) });
const dDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short', ...yearOpt(d) });
const what = (tx) => tx.desc || (M.category(tx.categoryId) || {}).name || 'Movimiento';

// Título y detalle de un movimiento visto desde esta cuenta (lo que el banco muestra es el comercio).
function moveInfo(tx, acc) {
  const sub = [];
  let title;
  if (tx.kind === 'transfer') {
    const out = tx.accountId === acc.id;
    const other = M.account(out ? tx.toAccountId : tx.accountId);
    const where = `Transferencia ${out ? 'a' : 'desde'} ${other ? other.name : '?'}`;
    if (tx.desc) { title = tx.desc; sub.push(where); } else title = where;
    if (other && other.currency !== acc.currency) sub.push(out ? M.fmt(tx.toAmount ?? tx.amount, other.currency) : M.fmt(tx.amount, tx.currency));
  } else if (tx.kind === 'settle') {
    title = tx.paidBy === M.ownerId() ? `Pago a ${M.personName(tx.to)}` : `Pago de ${M.personName(tx.paidBy)}`;
    if (tx.desc) sub.push(tx.desc);
    sub.push(`cierre ${M.monthName(M.settleMonthOf(tx)).toLowerCase()}`);
  } else {
    const cat = M.category(tx.categoryId);
    const catName = cat ? ((cat.icon ? cat.icon + ' ' : '') + cat.name) : 'Sin categoría';
    if (tx.desc) { title = tx.desc; sub.push(catName); } else title = catName;
    if (tx.alloc === 'shared') sub.push('compartido');
    else if (tx.alloc && tx.alloc.startsWith('p:')) sub.push(`solo de ${M.personName(tx.alloc.slice(2))}`);
  }
  if (tx.tag) sub.push('#' + tx.tag);
  return { title, sub: sub.join(' · ') };
}

function moveRow(x, acc, { ticked = false, onTick = null } = {}) {
  const { title, sub } = moveInfo(x.tx, acc);
  const row = h('div', { class: 'row acc-move' + (ticked ? ' ticked' : ''), 'data-id': x.tx.id });
  const tick = onTick ? h('button', {
    type: 'button', class: 'tick' + (ticked ? ' on' : ''), role: 'checkbox', 'aria-checked': String(ticked),
    'aria-label': `Encontrado en el banco: ${title}`, onclick: () => onTick(row, tick),
  }, '✓') : null;
  row.append(...[tick, h('button', { type: 'button', class: 'row-main', onclick: () => openTxForm(x.tx) },
    h('div', { class: 'main' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'sub' }, sub) : null),
    h('div', { class: 'amt' + (x.delta > 0 ? ' pos' : '') }, M.fmt(x.delta, acc.currency, { sign: x.delta > 0 })))].filter(Boolean));
  return row;
}

// ---- acciones ------------------------------------------------------------------------------

async function reconcile(acc, date, balance, msg) {
  const prevRec = acc.reconciled || null, prevCheck = getCheck(acc.id);
  setCheck(acc.id, null);
  await M.markReconciled(acc.id, date, balance);
  toast(msg || `✓ ${acc.name} quedó conciliada al ${dShort(date)}`, {
    label: 'Deshacer', ms: 7000,
    onAction: async () => { if (prevCheck) setCheck(acc.id, prevCheck); await db.put('accounts', { ...M.account(acc.id), reconciled: prevRec }); },
  });
}

function askBank(acc, prev) {
  const card = isCard(acc);
  formModal({
    title: 'Cuadrar con el banco',
    value: { amount: prev ? (card ? -prev.bank : prev.bank) : null, date: prev ? prev.date : M.todayStr() },
    fields: [
      { key: 'amount', type: 'number', signed: true, required: true,
        label: card ? 'Deuda que muestra el banco' : 'Saldo que muestra el banco',
        hint: card ? 'El cupo utilizado o deuda total, incluido lo no facturado. Si muestra saldo a favor, usa ±.' : 'El saldo contable de la cuenta.' },
      { key: 'date', type: 'date', label: 'Saldo al', required: true, hint: 'Hoy, o la fecha de la cartola con la que comparas.' },
    ],
    saveLabel: 'Comparar',
    onSave: async (v) => {
      const date = v.date || M.todayStr();
      const bank = card ? -v.amount : v.amount;
      const from = prev && prev.date === date && prev.from ? prev.from : M.reviewStart(acc, date);
      const check = { bank, date, from, ticks: prev ? prev.ticks || [] : [], at: Date.now() };
      const cmp = M.compareWithBank(acc.id, { ...check, hints: false });
      if (cmp.ok) { await reconcile(acc, date, cmp.bank, `✓ Cuadra con el banco: ${acc.name} quedó conciliada al ${dShort(date)}`); redraw(); return; }
      setCheck(acc.id, check);
      redraw();
    },
  });
}

async function endCheck(acc) {
  const c = getCheck(acc.id);
  if (c && (c.ticks || []).length && !await confirmDialog('Se perderán las marcas de lo que ya revisaste. ¿Terminar la comparación?', { ok: 'Terminar', danger: false })) return;
  setCheck(acc.id, null);
  redraw();
}

async function registerAdjust(acc, cmp) {
  const d = cmp.diff;
  const cat = M.adjustCategoryFor(acc.id);
  const ok = await confirmDialog(`Se registrará un ajuste de ${M.fmt(d, acc.currency, { sign: true })} en ${acc.name} el ${dShort(cmp.date)}${cat ? ` (categoría ${cat.name})` : ''} y la cuenta quedará conciliada. Úsalo solo si no encuentras el movimiento.`, { ok: 'Registrar ajuste', danger: false });
  if (!ok) return;
  const tx = { id: db.uid(), date: cmp.date, kind: d > 0 ? 'in' : 'out', amount: Math.abs(d), currency: acc.currency, accountId: acc.id,
    categoryId: cat ? cat.id : null, alloc: 'none', paidBy: M.ownerId(), desc: 'Descuadre con el banco' };
  Object.assign(tx, FX.fxFields(acc.currency, tx.date));
  const prevRec = acc.reconciled || null, prevCheck = getCheck(acc.id);
  setCheck(acc.id, null);
  await db.put('tx', tx);
  await M.markReconciled(acc.id, cmp.date, cmp.bank);
  toast(`Ajuste registrado: ${acc.name} quedó conciliada al ${dShort(cmp.date)}`, {
    label: 'Deshacer', ms: 8000,
    onAction: async () => {
      if (prevCheck) setCheck(acc.id, prevCheck);
      await db.del('tx', tx.id);
      await db.put('accounts', { ...M.account(acc.id), reconciled: prevRec });
    },
  });
}

// Cambios directos sobre un movimiento sugerido, siempre con "Deshacer".
async function changeTx(prev, next, msg) {
  await db.put('tx', next);
  toast(msg, { label: 'Deshacer', onAction: () => db.put('tx', prev), ms: 7000 });
}
async function removeTx(t) {
  await db.del('tx', t.id);
  toast('Movimiento eliminado', { label: 'Deshacer', onAction: () => db.put('tx', t), ms: 7000 });
}

// Lo que falta en Moni: el formulario listo con esta cuenta, la fecha de la comparación y el monto.
function registerMissing(acc, cmp, tpl, amount) {
  openTxForm(null, {
    kind: tpl.kind === 'in' ? 'in' : 'out', categoryId: tpl.categoryId, desc: tpl.desc || '', alloc: tpl.alloc || 'none',
    paidBy: M.ownerId(), accountId: acc.id, lockAccount: true, date: cmp.date,
    amount: String(M.roundCur(amount, acc.currency)).replace('.', ','),
  });
}

// ---- piezas de la pantalla --------------------------------------------------------------------

function hintRow(acc, cmp, x) {
  const f = (v) => M.fmt(v, acc.currency);
  const t = x.tx;
  const btn = (label, onclick, primary) => h('button', { class: 'btn small' + (primary ? ' primary' : ''), onclick }, label);
  const view = (tx) => btn('Ver', () => openTxForm(tx));
  const other = (k) => (k === 'out' ? 'ingreso' : 'gasto');
  let title, text, actions;
  switch (x.type) {
    case 'small':
      title = 'Diferencia mínima';
      text = 'Suele ser un redondeo de compras en otra moneda o del tipo de cambio.';
      actions = [btn('Registrar ajuste', () => registerAdjust(acc, cmp))];
      break;
    case 'dup':
      title = '¿Registrado dos veces?';
      text = `${what(t)} por ${f(t.amount)} el ${dShort(x.other.date)} y el ${dShort(t.date)}.`;
      actions = [view(t), btn('Eliminar el repetido', () => removeTx(t), true)];
      break;
    case 'later':
      title = 'El banco aún no muestra lo último';
      text = `Los ${x.count} movimientos desde el ${dShort(x.since)} suman justo la diferencia. Si todavía no aparecen en el banco, todo lo anterior cuadra.`;
      actions = [btn(`Conciliar al ${dShort(x.checkpoint)}`, () => reconcile(acc, x.checkpoint, M.balanceOn(cmp.rows, x.checkpoint)).then(redraw), true)];
      break;
    case 'elsewhere':
      title = '¿Era de esta cuenta?';
      text = `${what(t)} por ${f(t.amount)} (${dShort(t.date)}) quedó ${x.other ? 'en ' + x.other.name : 'sin cuenta'}.`;
      actions = [view(t), btn('Mover aquí', () => changeTx(t, { ...t, accountId: acc.id, currency: acc.currency }, `Movido a ${acc.name}`), true)];
      break;
    case 'bill':
      title = `¿Falta ${x.bill.cat.name}?`;
      text = `Es una cuenta fija que sale de esta cuenta y aún no la registras este mes${x.bill.fixed ? ` (${f(x.amount)})` : ` (suele ser ~${f(x.bill.median)})`}.`;
      actions = [btn('Registrar…', () => registerMissing(acc, cmp, x.bill.template, x.amount), true)];
      break;
    case 'repeat':
      title = `¿Falta ${what(t)}?`;
      text = `Hubo ${x.count > 1 ? x.count + ' iguales' : 'uno igual'} antes (el último, el ${dShort(t.date)}) y desde el ${dShort(cmp.from)} no aparece.`;
      actions = [btn('Registrar…', () => registerMissing(acc, cmp, t, t.amount), true)];
      break;
    case 'extra':
      title = 'Este movimiento es justo la diferencia';
      text = `${what(t)} (${dShort(t.date)}, ${f(t.amount)}). ¿Está repetido, no pasó por esta cuenta o el banco aún no lo muestra?`;
      // si es lo último registrado y el banco aún no lo muestra, todo lo anterior cuadra
      actions = [view(t), x.checkpoint ? btn('Aún no aparece en el banco', () => reconcile(acc, x.checkpoint, M.balanceOn(cmp.rows, x.checkpoint), `✓ ${acc.name} quedó conciliada al ${dShort(x.checkpoint)}, antes de ese movimiento`).then(redraw)) : null];
      break;
    case 'sign':
      title = '¿Registrado al revés?';
      text = `${what(t)} (${dShort(t.date)}, ${f(t.amount)}) quedó como ${t.kind === 'out' ? 'gasto' : 'ingreso'}; si era ${other(t.kind)}, cuadra.`;
      actions = [view(t), btn(`Cambiar a ${other(t.kind)}`, () => changeTx(t, { ...t, kind: t.kind === 'out' ? 'in' : 'out' }, `Cambiado a ${other(t.kind)}`))];
      break;
    case 'typo':
      title = `¿Era ${f(x.amount)}?`;
      text = `${what(t)} (${dShort(t.date)}) está por ${f(t.amount)}; con ${f(x.amount)} cuadra.`;
      actions = [view(t), btn(`Corregir a ${f(x.amount)}`, () => changeTx(t, { ...t, amount: x.amount }, `Monto corregido a ${f(x.amount)}`))];
      break;
    default: return null;
  }
  return h('div', { class: 'hint' },
    h('div', { class: 'hint-text' }, h('strong', null, title), h('span', null, text)),
    h('div', { class: 'row-actions' }, actions));
}

// Resumen de la revisión uno a uno; se actualiza en su lugar al marcar, sin mover la lista.
// baseOk: el saldo con que parte la revisión ya cuadró con el banco (conciliado el día anterior y sin cambios).
function tickSummary(acc, cmp, baseOk) {
  const f = (v) => M.fmt(v, acc.currency);
  const n = cmp.win.length;
  const half = 10 ** -M.currencyInfo(acc.currency).decimals / 2;
  const lines = [h('div', null, `Desde el ${dShort(cmp.from)} hay ${n} movimiento${n === 1 ? '' : 's'}. Marca ✓ cada uno que encuentres en la app del banco; lo que falte agrégalo con ＋.`)];
  if (cmp.nTicked) {
    const left = n - cmp.nTicked;
    lines.push(h('div', null, h('b', null, `Encontrados ${cmp.nTicked} de ${n}`), left ? ` · sin marcar ${left} (${M.fmt(cmp.unticked, acc.currency, { sign: true })})` : ''));
    if (Math.abs(cmp.missing) < half) {
      lines.push(h('div', { class: 'recon-verdict' }, `Lo que no marcaste explica toda la diferencia: no está en el banco (aún no aparece, o sobra en Moni).`));
    } else {
      const card = isCard(acc);
      const kind = cmp.missing < 0 ? (card ? 'compras o cargos' : 'gastos o cargos') : (card ? 'pagos o devoluciones' : 'ingresos o abonos');
      lines.push(h('div', { class: 'recon-verdict' }, `Si ya marcaste todo lo que muestra el banco, faltan en Moni ${kind} por ${f(Math.abs(cmp.missing))}`
        + (baseOk ? '.' : ` (o la diferencia viene de antes del ${dShort(cmp.from)}).`)));
    }
  }
  return lines;
}

function cmpCard(acc, cmp, check, summaryBox, baseOk) {
  const f = (v) => M.fmt(v, acc.currency);
  if (cmp.ok) {
    return h('section', { class: 'card recon ok' },
      h('div', { class: 'recon-ok' }, `✓ Ahora cuadra con el banco al ${dShort(cmp.date)}`),
      h('p', { class: 'muted small' }, 'Guárdala como conciliada: la próxima vez solo tendrás que revisar lo nuevo.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => reconcile(acc, cmp.date, cmp.bank).then(redraw) }, 'Conciliar'),
        h('button', { class: 'btn', onclick: () => endCheck(acc) }, 'Cerrar sin guardar')));
  }
  const d = cmp.diff;
  const card = isCard(acc);
  const explain = !card
    ? (d < 0 ? `El banco tiene ${f(-d)} menos que Moni: falta registrar un gasto o cargo, o sobra un ingreso.`
      : `El banco tiene ${f(d)} más que Moni: falta registrar un ingreso o abono, o sobra un gasto.`)
    : (d < 0 ? `El banco registra ${f(-d)} más de deuda que Moni: falta registrar una compra o cargo, o sobra un pago.`
      : `El banco registra ${f(d)} menos de deuda que Moni: falta registrar un pago o devolución, o sobra una compra.`);
  const hints = cmp.hints.map(x => hintRow(acc, cmp, x)).filter(Boolean);
  fill(summaryBox, tickSummary(acc, cmp, baseOk));
  const earlier = M.addMonths(cmp.from.slice(0, 7), -1) + '-01';
  return h('section', { class: 'card recon' },
    h('div', { class: 'card-head' },
      h('h3', null, `Comparación al ${dShort(cmp.date)}`),
      h('button', { class: 'icon-btn small', 'aria-label': 'Terminar la comparación', onclick: () => endCheck(acc) }, '✕')),
    h('div', { class: 'recon-grid' },
      h('span', null, 'Banco'), h('b', null, balText(acc, cmp.bank)),
      h('button', { class: 'link', onclick: () => askBank(acc, check) }, 'Cambiar'),
      h('span', null, 'Moni'), h('b', null, balText(acc, cmp.moni)), h('span'),
      h('span', null, 'Diferencia'), h('b', { class: 'neg' }, f(Math.abs(d))), h('span')),
    h('p', { class: 'small recon-explain' }, explain),
    hints.length ? [h('h4', null, 'Posibles causas'), hints] : null,
    h('h4', null, hints.length ? 'O revisa uno a uno' : 'Revisa uno a uno'),
    summaryBox,
    h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => { setCheck(acc.id, { ...getCheck(acc.id), from: earlier }); redraw(); } }, `Revisar desde el ${dShort(earlier)}`),
      h('button', { class: 'btn small', onclick: () => registerAdjust(acc, cmp) }, 'Registrar la diferencia como ajuste')));
}

function driftBox(acc, d) {
  return h('div', { class: 'warn' },
    h('div', null, `Cambió algo en lo ya conciliado: al ${dShort(d.date)} ${balNoun(acc, d.was)} era ${balAmt(acc, d.was)} y ahora es ${balAmt(acc, d.now)}.`),
    d.changed.length
      ? [h('div', null, 'Movimientos de ese período editados o agregados después de conciliar:'), h('div', { class: 'list drift-list' }, d.changed.slice(0, 5).map(t => txRow(t, { showDate: true })))]
      : h('div', null, 'Puede ser un movimiento que se borró.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => M.markReconciled(acc.id, d.date, d.now) }, 'Está bien así')));
}

function headCard(acc, bal, drift, cmp) {
  const typeL = { bank: 'Cuenta bancaria', credit: 'Tarjeta / línea de crédito', cash: 'Efectivo' }[acc.type] || 'Cuenta';
  const rec = acc.reconciled;
  return h('section', { class: 'card acc-card' },
    h('div', { class: 'acc-top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Volver', onclick: () => { location.hash = st.backTo && st.backTo !== location.hash ? st.backTo : '#/movs'; } }, '‹'),
      h('div', { class: 'main' },
        h('h2', null, acc.name),
        h('div', { class: 'muted small' }, [typeL, acc.currency, acc.archived ? 'archivada' : null].filter(Boolean).join(' · '))),
      h('button', { class: 'btn small', onclick: () => editAccount(acc) }, 'Editar')),
    h('div', { class: 'label' }, `${cap(balWord(acc, bal))} en Moni`),
    h('div', { class: 'big' }, balAmt(acc, bal)),
    h('div', { class: 'muted small' }, rec && rec.date ? `✓ Cuadró con el banco al ${dShort(rec.date)} (${balText(acc, rec.balance)})` : 'Aún no la comparas con el banco.'),
    drift ? driftBox(acc, drift) : null,
    cmp ? null : h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => askBank(acc, null) }, 'Cuadrar con el banco')));
}

// ---- pantalla -------------------------------------------------------------------------------------

export function renderAccount(root, accId) {
  if (!M.account(accId)) {
    fill(root, h('p', { class: 'empty' }, 'No encontré esa cuenta.'), h('div', { class: 'center' }, h('a', { class: 'btn', href: '#/movs' }, 'Ver movimientos')));
    return;
  }
  if (st.accId !== accId) Object.assign(st, { accId, q: '', limit: 150, onlyOpen: false });
  const headBox = h('div');
  const cmpBox = h('div');
  const summaryBox = h('div', { class: 'recon-sum small', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', placeholder: 'Buscar monto o descripción en esta cuenta…', value: st.q, 'aria-label': 'Buscar en esta cuenta' });
  let timer;
  search.addEventListener('input', () => { st.q = search.value; clearTimeout(timer); timer = setTimeout(draw, 160); });
  const chips = h('div', { class: 'chips' });
  const info = h('div', { class: 'muted center small' });
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'center' });
  const elsewhere = h('div');

  function draw() {
    const acc = M.account(accId);
    if (!acc) return renderAccount(root, accId);
    const rows = M.accountLedger(accId);
    const bal = rows.length ? rows[rows.length - 1].balance : 0;
    const check = getCheck(accId);
    const cmp = check ? M.compareWithBank(accId, { ...check, hints: false, rows }) : null;
    if (cmp && !cmp.ok) cmp.hints = hintsFor(cmp);
    const drift = M.reconciledDrift(acc, rows);
    const baseOk = !!(cmp && acc.reconciled && acc.reconciled.date === M.addDays(cmp.from, -1) && !drift);
    fill(headBox, headCard(acc, bal, drift, cmp));
    fill(cmpBox, cmp ? cmpCard(acc, cmp, check, summaryBox, baseOk) : null);

    const review = cmp && !cmp.ok;
    const ticks = new Set(review ? check.ticks || [] : []);
    const inWin = (x) => review && x.tx.date >= cmp.from && x.tx.date <= cmp.date;
    fill(chips, review ? h('button', { class: 'chip small' + (st.onlyOpen ? ' on' : ''), 'aria-pressed': String(st.onlyOpen), onclick: () => { st.onlyOpen = !st.onlyOpen; draw(); } }, 'Solo sin marcar') : null);

    // marcar no vuelve a dibujar la pantalla (la lista no salta): se actualiza la fila y el resumen
    const onTick = (row, btn) => {
      const c = getCheck(accId);
      if (!c) return;
      const id = row.dataset.id;
      const set = new Set(c.ticks || []);
      const on = !set.has(id);
      if (on) set.add(id); else set.delete(id);
      setCheck(accId, { ...c, ticks: [...set] });
      btn.classList.toggle('on', on); btn.setAttribute('aria-checked', String(on));
      row.classList.toggle('ticked', on);
      if (on && st.onlyOpen) row.hidden = true;
      const now = M.compareWithBank(accId, { ...getCheck(accId), hints: false, rows });
      fill(summaryBox, tickSummary(acc, now, baseOk));
    };

    const q = M.stripAccents(st.q.trim().toLowerCase());
    const words = q.split(/\s+/).filter(Boolean).map(text => {
      const n = /^-?[\d.,]+$/.test(text) ? M.parseAmount(text) : NaN;
      return { text, num: Number.isFinite(n) ? Math.abs(n) : null };
    });
    const match = (x) => {
      const { title, sub } = moveInfo(x.tx, acc);
      const hay = M.stripAccents(`${title} ${sub} ${x.tx.amount}`.toLowerCase());
      return words.every(w => hay.includes(w.text) || (w.num != null && (Math.abs(x.tx.amount - w.num) < 0.005 || Math.abs(Math.abs(x.delta) - w.num) < 0.005)));
    };
    let shown = rows.slice().reverse();
    if (words.length) shown = shown.filter(match);
    if (review && st.onlyOpen) shown = shown.filter(x => inWin(x) && !ticks.has(x.tx.id));

    const rec = acc.reconciled && acc.reconciled.date ? acc.reconciled : null;
    const out = [];
    let day = null, recDone = !rec || words.length > 0, fromDone = !review || words.length > 0 || (rec && rec.date === M.addDays(cmp.from, -1));
    for (const x of shown.slice(0, st.limit)) {
      if (!recDone && x.tx.date <= rec.date) {
        recDone = true; day = null;
        out.push(h('div', { class: 'recon-mark' }, `✓ Cuadró con el banco al ${dShort(rec.date)} · ${balText(acc, rec.balance)}`));
      }
      if (!fromDone && x.tx.date < cmp.from) {
        fromDone = true; day = null;
        out.push(h('div', { class: 'recon-mark from' }, `Antes del ${dShort(cmp.from)}: fuera de la revisión`));
      }
      if (x.tx.date !== day) {
        day = x.tx.date;
        out.push(h('div', { class: 'dayhead split' }, h('span', null, dDay(day)), h('span', { class: 'daybal' }, balText(acc, M.balanceOn(rows, day)))));
      }
      out.push(moveRow(x, acc, { ticked: ticks.has(x.tx.id), onTick: inWin(x) ? onTick : null }));
    }
    if (!shown.length) out.push(h('p', { class: 'empty' }, words.length ? 'Nada coincide en esta cuenta.' : review && st.onlyOpen ? 'Marcaste todos los movimientos del período.' : 'Esta cuenta aún no tiene movimientos.'));
    fill(list, out);
    info.textContent = words.length ? `${shown.length} de ${rows.length} movimientos` : `${rows.length} movimientos`;
    fill(more, shown.length > st.limit ? h('button', { class: 'btn', onclick: () => { st.limit += 300; draw(); } }, `Ver más antiguos (${shown.length - st.limit})`) : null);

    // el monto buscado puede estar registrado en otra cuenta o sin cuenta
    const num = words.length === 1 ? words[0].num : null;
    const others = num != null ? M.sortTx(db.all('tx').filter(t => t.accountId !== accId && t.toAccountId !== accId
      && (Math.abs(t.amount - num) < 0.005 || (t.toAmount != null && Math.abs(t.toAmount - num) < 0.005)))).slice(0, 8) : [];
    fill(elsewhere, others.length ? [h('h4', null, 'El mismo monto en otras cuentas'), h('div', { class: 'list' }, others.map(t => txRow(t, { showDate: true })))] : null);
  }

  redraw = () => { if (st.accId === accId && root.isConnected) draw(); };
  fill(root, headBox, cmpBox, h('div', { class: 'toolbar acc-tools' }, search, chips), info, list, more, elsewhere);
  draw();
  return draw;
}
