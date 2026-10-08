// Inversiones. Dos formas de llevarlas:
// - por valor: aportes, retiros y "Actualizar valor" (la diferencia es la ganancia). Ej: AFP, APV.
// - por cantidad: compras y ventas (cantidad × precio); el valor es cantidad × último precio, que se
//   consulta en la web (acciones, ETF, cripto) o se ingresa a mano (valor cuota de fondos mutuos).
// En ambas se registran dividendos. Los puntos y millas van aparte (ver points.js).
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import * as PX from '../prices.js';
import { fill, h, modal, toast, formModal, promptDialog, parseNum, confirmDialog } from '../ui.js';
import { lineChart, sparkline, vizCard, dataTable } from '../charts.js';

const HORIZONS = [{ v: 'short', l: 'Corto / mediano plazo' }, { v: 'long', l: 'Largo plazo (AFP, APV…)' }];
const TYPES = [{ v: 'fund', l: 'Por valor: actualizo el saldo total' }, { v: 'units', l: 'Por cantidad: acciones, ETF, fondos mutuos, cripto' }];
const ASSETS = [{ v: 'stock', l: 'Acciones' }, { v: 'etf', l: 'ETF' }, { v: 'ffmm', l: 'Fondo mutuo' }, { v: 'crypto', l: 'Cripto' }, { v: 'other', l: 'Otro' }];
const UNIT_WORD = { stock: 'acciones', etf: 'cuotas', ffmm: 'cuotas', crypto: 'unidades', other: 'unidades' };
const unitWord = (inv) => UNIT_WORD[inv.assetKind] || 'unidades';
const UNIT_ONE = { stock: 'acción', etf: 'cuota', ffmm: 'cuota', crypto: 'unidad', other: 'unidad' };
const unitOne = (inv) => UNIT_ONE[inv.assetKind] || 'unidad';
// precio por unidad: con 2 decimales más que la moneda ($78,31 por acción; un promedio no es entero)
export function fmtPrice(v, cur) {
  const c = M.currencyInfo(cur);
  const s = new Intl.NumberFormat('es-CL', { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals + 2 }).format(Math.abs(v || 0));
  return `${v < 0 ? '-' : ''}${c.symbol === '$' ? '$' : c.symbol + ' '}${s}`;
}

const kindLabel = (inv, e) => (e.kind === 'dividend' ? 'Dividendo' : e.kind === 'gain' ? 'Valorización'
  : M.isUnits(inv) && e.units ? (e.kind === 'contrib' ? 'Compra' : 'Venta') : (e.kind === 'contrib' ? 'Aporte' : 'Retiro'));
export const fmtQty = (n) => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 6 }).format(n || 0);
const pct = (x) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const v = Math.round(x * 1000) / 10 + 0;              // + 0: sin "-0,0%"
  return `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}%`;
};
const dShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', ...(d.slice(0, 4) !== M.todayStr().slice(0, 4) ? { year: 'numeric' } : {}) });

function categoryIdOf(kind, name, extra) {
  const c = M.categories().find(x => x.kind === kind && !x.archived && (!name || x.name === name));
  return c ? c.id : null;
}
// Dividendos de inversiones (ojo: "Dividendo" en Chile también es la cuota del hipotecario; es otra categoría)
async function dividendCategoryId() {
  const id = categoryIdOf('income', 'Dividendos recibidos');
  if (id) return id;
  const c = await db.put('categories', { name: 'Dividendos recibidos', kind: 'income', icon: '💵', group: 'Inversiones', defaultAlloc: 'none' });
  return c.id;
}

// Movimiento en una cuenta ligado a un registro de inversión (compra, venta, aporte, dividendo).
async function accountTx(inv, { accountId, date, kind, amount, desc, categoryId, prevTxId }) {
  if (!accountId) { if (prevTxId) await db.del('tx', prevTxId); return null; }
  const prev = prevTxId ? db.get('tx', prevTxId) : null;
  const tx = { ...(prev || {}), date, kind, amount: Math.abs(amount), currency: inv.currency, accountId, categoryId, alloc: 'none', paidBy: M.ownerId(), desc };
  delete tx.fx; delete tx.fxPending;
  Object.assign(tx, FX.fxFields(inv.currency, date));
  const saved = await db.put('tx', tx);
  return saved.id;
}
// para depositar (ventas, retiros, dividendos) no se ofrecen tarjetas de crédito
const accountOptions = (inv, deposit = false) => [{ v: '', l: '— no registrar en cuentas —' },
  ...M.accounts().filter(a => a.currency === inv.currency && !(deposit && a.type === 'credit')).map(a => ({ v: a.id, l: a.name }))];

// ---- registros por valor ---------------------------------------------------------------

async function updateValue(inv) {
  const s = M.fundStats(inv);
  const info = M.currencyInfo(inv.currency);
  const v = await promptDialog('Actualizar valor', {
    label: `Valor actual total de ${inv.name} (${inv.currency})`, type: 'number', value: '',
    hint: `Saldo registrado: ${M.fmt(s.balance, inv.currency)}. Se guarda la diferencia como ganancia o pérdida.`,
  });
  if (v == null) return;
  const n = parseNum(v);
  if (!Number.isFinite(n)) { toast('Valor no válido'); return; }
  const diff = n - s.balance;
  if (Math.abs(diff) < Math.pow(10, -info.decimals) / 2) { toast('Sin cambios'); return; }
  await db.put('invEntries', { invId: inv.id, date: M.todayStr(), kind: 'gain', amount: diff, note: 'Actualización de valor' });
  toast(`Valorización ${M.fmt(diff, inv.currency, { sign: true })}`);
}

function moneyForm(inv, kind, e = null) {
  const label = kind === 'contrib' ? 'Aporte' : 'Retiro';
  formModal({
    title: `${label} · ${inv.name}`, value: e ? { ...e, accountId: e.txId && db.get('tx', e.txId) ? db.get('tx', e.txId).accountId : '' } : { date: M.todayStr(), accountId: '' },
    fields: [
      { key: 'amount', label: `Monto (${inv.currency})`, type: 'number', required: true },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'accountId', label: kind === 'contrib' ? 'Descontar de la cuenta (opcional)' : 'Depositar en la cuenta (opcional)', type: 'select', options: accountOptions(inv, kind !== 'contrib') },
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    onSave: async (v) => {
      const txId = await accountTx(inv, { accountId: v.accountId, date: v.date, kind: kind === 'contrib' ? 'out' : 'in', amount: v.amount, desc: `${label} ${inv.name}`, categoryId: categoryIdOf('invest'), prevTxId: e && e.txId });
      await db.put('invEntries', { ...(e || {}), invId: inv.id, date: v.date, kind, amount: Math.abs(v.amount), note: v.note || '', txId: txId || undefined });
      toast(`${label} registrado`);
    },
    onDelete: e ? (v) => removeEntry(e) : null,
  });
}

async function removeEntry(e) {
  if (e.txId && db.get('tx', e.txId)) await db.del('tx', e.txId);
  await db.del('invEntries', e.id);
}

// ---- por cantidad: compra, venta, precio -------------------------------------------------

// Compra o venta: se ingresa el precio por unidad (+ comisión) o el monto total de la operación, como lo
// muestra la corredora (Zesty muestra el total); con el total se calcula el precio promedio por unidad.
const TRADE_MODE = 'moni.tradeMode';
function tradeForm(inv, kind, e = null) {
  const buy = kind === 'contrib';
  const st = M.fundStats(inv);
  const held = st.qty + (e && !buy ? e.units : 0);
  const word = unitWord(inv);
  const one = unitOne(inv);
  let lastMode = 'total';
  try { lastMode = localStorage.getItem(TRADE_MODE) || 'total'; } catch { /* ignore */ }
  const mode0 = e ? (e.byTotal ? 'total' : 'price') : lastMode;
  const value = e
    ? { ...e, mode: mode0, total: e.amount, accountId: e.txId && db.get('tx', e.txId) ? db.get('tx', e.txId).accountId : '' }
    : { date: M.todayStr(), accountId: '', mode: mode0, price: st.price ? st.price.price : null };
  const byTotal = (v) => v.mode === 'total';
  const fm = formModal({
    title: `${buy ? 'Compra' : 'Venta'} · ${inv.name}`,
    value,
    fields: [
      { key: 'units', label: `Cantidad (${word})`, type: 'number', required: true, hint: buy ? 'Acepta decimales (acciones fraccionadas).' : `Tienes ${fmtQty(held)} ${word}.` },
      { key: 'mode', label: 'Cómo ingresas el valor', type: 'select', options: [
        { v: 'total', l: buy ? 'Monto total pagado' : 'Monto total recibido' },
        { v: 'price', l: `Precio por ${one} y comisión` }] },
      { key: 'total', label: `${buy ? 'Total pagado' : 'Total recibido'} (${inv.currency})`, type: 'number', required: true, show: byTotal,
        hint: buy ? `Todo lo que pagaste, con comisiones: el precio promedio por ${one} se calcula solo.` : 'Lo que recibiste, ya descontadas las comisiones.' },
      { key: 'price', label: `Precio por ${one} (${inv.currency})`, type: 'number', required: true, show: (v) => !byTotal(v) },
      { key: 'fee', label: `Comisión (${inv.currency}, opcional)`, type: 'number', show: (v) => !byTotal(v) },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'accountId', label: buy ? 'Pagado desde la cuenta (opcional)' : 'Depositado en la cuenta (opcional)', type: 'select', options: accountOptions(inv, !buy) },
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    extra: h('p', { class: 'trade-total', 'aria-live': 'polite' }),
    onSave: async (v) => {
      const units = Math.abs(v.units || 0);
      if (!units) { toast('Ingresa la cantidad'); return false; }
      if (!buy && units > held + 1e-9) { toast(`Solo tienes ${fmtQty(held)} ${word}`); return false; }
      let amount, price, fee;
      if (byTotal(v)) {
        amount = Math.abs(v.total || 0);
        if (!amount) { toast(buy ? 'Ingresa el total pagado' : 'Ingresa el total recibido'); return false; }
        price = amount / units; fee = 0;
      } else {
        price = Math.abs(v.price || 0); fee = Math.abs(v.fee || 0);
        if (!price) { toast(`Ingresa el precio por ${one}`); return false; }
        amount = buy ? units * price + fee : units * price - fee;
      }
      try { localStorage.setItem(TRADE_MODE, v.mode); } catch { /* ignore */ }
      const txId = await accountTx(inv, { accountId: v.accountId, date: v.date, kind: buy ? 'out' : 'in', amount, desc: `${buy ? 'Compra' : 'Venta'} ${fmtQty(units)} ${inv.symbol || inv.name}`, categoryId: categoryIdOf('invest'), prevTxId: e && e.txId });
      const rec = { ...(e || {}), invId: inv.id, date: v.date, kind, units, price, fee: fee || undefined, amount, byTotal: byTotal(v) || undefined, note: v.note || '', txId: txId || undefined };
      delete rec.mode; delete rec.total;
      await db.put('invEntries', rec);
      toast(`${buy ? 'Compra' : 'Venta'} registrada: ${fmtQty(units)} ${word} a ${fmtPrice(price, inv.currency)} promedio · total ${M.fmt(amount, inv.currency)}`, { ms: 6000 });
    },
    onDelete: e ? () => removeEntry(e) : null,
  });
  // cálculo en vivo: precio promedio (con el total) o total (con el precio)
  const form = fm.sheet.querySelector('form');
  const out = fm.sheet.querySelector('.trade-total');
  const field = (label) => [...form.querySelectorAll('label.field')].find(l => (l.querySelector('span') || {}).textContent.startsWith(label));
  const num = (label) => { const f = field(label); return f ? parseNum(f.querySelector('input').value) : NaN; };
  const sel = field('Cómo ingresas').querySelector('select');
  const upd = () => {
    const u = num('Cantidad');
    if (sel.value === 'total') {
      const t = num(buy ? 'Total pagado' : 'Total recibido');
      out.textContent = Number.isFinite(u) && u > 0 && Number.isFinite(t) && t > 0 ? `Precio promedio: ${fmtPrice(t / u, inv.currency)} por ${one}` : '';
    } else {
      const p = num(`Precio por ${one}`), f = num('Comisión');
      const fee = Number.isFinite(f) ? f : 0;
      out.textContent = Number.isFinite(u) && Number.isFinite(p) ? `Total ${M.fmt(buy ? u * p + fee : u * p - fee, inv.currency)}` : '';
    }
  };
  form.addEventListener('input', upd); form.addEventListener('change', upd); upd();
}

async function priceAction(inv) {
  if (inv.priceSource && inv.priceSource !== 'manual') {
    if (PX.sourceOf(inv) === 'twelve' && !PX.getKey()) { askKey(); return; }
    toast('Consultando precio…');
    const r = await PX.refreshPrices({ only: inv.id });
    toast(r.errors.length ? `${inv.name}: ${r.errors[0].message}` : 'Precio actualizado', { ms: 5000 });
    return;
  }
  const p = M.priceAt(inv, M.todayStr());
  formModal({
    title: `Precio · ${inv.name}`, value: { date: M.todayStr() },
    fields: [
      { key: 'price', label: `Precio por unidad hoy (${inv.currency})`, type: 'number', required: true, hint: p ? `Último: ${M.fmt(p.price, inv.currency)} (${dShort(p.date)}). En fondos mutuos es el valor cuota.` : 'En fondos mutuos es el valor cuota.' },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
    ],
    onSave: async (v) => { await PX.setManualPrice(inv, v.date, Math.abs(v.price)); toast('Precio guardado'); },
  });
}

// ---- dividendos (por valor y por cantidad) ------------------------------------------------

function dividendForm(inv, e = null) {
  const units = M.isUnits(inv);
  const st = M.fundStats(inv);
  const dest = e ? (e.reinvested ? 'reinvest' : (e.txId && db.get('tx', e.txId) ? db.get('tx', e.txId).accountId : '')) : '';
  formModal({
    title: `Dividendo · ${inv.name}`, value: e ? { ...e, dest } : { date: M.todayStr(), dest: '' },
    fields: [
      ...(units ? [{ key: 'perUnit', label: `Por ${unitWord(inv).replace(/s$/, '')} (${inv.currency}, opcional)`, type: 'number', hint: `Si lo escribes, el total se calcula con tus ${fmtQty(st.qty)} ${unitWord(inv)}.` }] : []),
      { key: 'amount', label: `Total recibido (${inv.currency})`, type: 'number', required: !units, hint: 'Lo que llegó, después de impuestos.' },
      { key: 'date', label: 'Fecha de pago', type: 'date', required: true },
      { key: 'dest', label: '¿Dónde quedó?', type: 'select', options: [
        ...accountOptions(inv, true).map(o => (o.v === '' ? { v: '', l: 'Se pagó, no lo registro en una cuenta' } : { v: o.v, l: `Depositado en ${o.l}` })),
        { v: 'reinvest', l: 'Reinvertido en esta inversión' }] },
      ...(units ? [{ key: 'units', label: `${unitWord(inv)} compradas con el dividendo`, type: 'number', show: (v) => v.dest === 'reinvest' }] : []),
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    onSave: async (v) => {
      let amount = Math.abs(v.amount || 0);
      if (!amount && units && v.perUnit) amount = Math.abs(v.perUnit) * st.qty;
      if (!amount) { toast('Ingresa el total o el monto por unidad'); return false; }
      const reinvested = v.dest === 'reinvest';
      const txId = reinvested ? await accountTx(inv, { accountId: null, prevTxId: e && e.txId })
        : await accountTx(inv, { accountId: v.dest, date: v.date, kind: 'in', amount, desc: `Dividendo ${inv.symbol || inv.name}`, categoryId: await dividendCategoryId(), prevTxId: e && e.txId });
      const rec = { ...(e || {}), invId: inv.id, date: v.date, kind: 'dividend', amount, reinvested: reinvested || undefined, note: v.note || '', txId: txId || undefined };
      if (units && reinvested && v.units) { rec.units = Math.abs(v.units); rec.price = amount / rec.units; } else { delete rec.units; delete rec.price; }
      delete rec.perUnit; delete rec.dest;
      await db.put('invEntries', rec);
      toast(`Dividendo registrado: ${M.fmt(amount, inv.currency)}`);
    },
    onDelete: e ? () => removeEntry(e) : null,
  });
}

function editEntry(inv, e) {
  if (e.kind === 'dividend') return dividendForm(inv, e);
  if (M.isUnits(inv) && e.units) return tradeForm(inv, e.kind, e);
  if ((e.kind === 'contrib' || e.kind === 'withdraw') && e.txId) return moneyForm(inv, e.kind, e);
  formModal({
    title: 'Editar registro', value: e,
    fields: [
      { key: 'kind', label: 'Tipo', type: 'select', options: [{ v: 'contrib', l: 'Aporte' }, { v: 'withdraw', l: 'Retiro' }, { v: 'gain', l: 'Valorización' }] },
      { key: 'amount', label: 'Monto', type: 'number', required: true, signed: true },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    onSave: (v) => db.put('invEntries', v), onDelete: () => removeEntry(e),
  });
}

// ---- clave de Twelve Data ----------------------------------------------------------------

export function askKey() {
  const input = h('input', { type: 'text', value: PX.getKey(), placeholder: 'Pega aquí tu clave', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const m = modal('Precios de acciones y ETF', h('div', null,
    h('p', null, 'Los precios se consultan en Twelve Data con una clave gratuita tuya (800 consultas al día).'),
    h('ol', { class: 'steps' },
      h('li', null, 'Abre ', h('a', { href: 'https://twelvedata.com/register', target: '_blank', rel: 'noopener' }, 'twelvedata.com/register'), ' y crea una cuenta gratis (plan Basic).'),
      h('li', null, 'Confirma tu correo y entra a ', h('a', { href: 'https://twelvedata.com/account/api-keys', target: '_blank', rel: 'noopener' }, 'API Keys'), '.'),
      h('li', null, 'Copia la clave y pégala aquí.')),
    h('label', { class: 'field' }, h('span', null, 'Clave (API key)'), input),
    h('p', { class: 'muted small' }, 'Queda guardada solo en este teléfono (no va en los respaldos). A Twelve Data solo le llega el símbolo, nunca tus montos ni cantidades.')), {
    actions: [
      PX.getKey() ? h('button', { class: 'btn danger ghost', onclick: () => { PX.setKey(''); m.close(); toast('Clave eliminada'); } }, 'Quitar') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => {
        PX.setKey(input.value); m.close();
        if (!input.value.trim()) return;
        toast('Consultando precios…');
        const r = await PX.refreshPrices({ force: true });
        toast(r.errors.length ? `${r.errors[0].name ? r.errors[0].name + ': ' : ''}${r.errors[0].message}` : `Clave guardada. ${r.updated} precio${r.updated === 1 ? '' : 's'} al día.`, { ms: 6000 });
      } }, 'Guardar'),
    ],
    dismissable: false,
  });
}

// ---- fondo: crear / editar ----------------------------------------------------------------------

// Campo de símbolo con búsqueda: al elegir un resultado fija símbolo, bolsa y moneda.
function symbolField(state) {
  return {
    key: 'symbol', label: 'Símbolo', type: 'custom', show: (v) => v.type === 'units' && v.priceSource !== 'manual',
    build: (v, all) => {
      const input = h('input', { type: 'text', value: v || '', placeholder: 'Ej: VOO, AAPL, bitcoin', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
      const results = h('div', { class: 'sym-results' });
      input.addEventListener('input', () => { state.mic = null; state.picked = null; });
      const search = async () => {
        const src = input.closest('form').querySelector('select[data-key="priceSource"]').value;
        fill(results, h('p', { class: 'muted small' }, 'Buscando…'));
        try {
          const list = await PX.searchSymbols(input.value, src);
          fill(results, list.length ? list.slice(0, 8).map(r => h('button', { type: 'button', class: 'row sym-row', onclick: () => {
            input.value = r.symbol; state.mic = r.mic || null; state.picked = r;
            const srcSel = input.closest('form').querySelector('select[data-key="priceSource"]');
            if (srcSel && r.source && srcSel.value !== 'coingecko') { srcSel.value = r.source; srcSel.dispatchEvent(new Event('change', { bubbles: true })); }
            const curSel = input.closest('form').querySelector('select[data-key="currency"]');
            if (curSel && [...curSel.options].some(o => o.value === r.currency)) curSel.value = r.currency;
            fill(results, h('p', { class: 'muted small' }, `${r.name} · ${r.exchange} · ${r.currency}`));
          } }, h('div', { class: 'main' }, h('div', { class: 'title' }, `${r.symbol} · ${r.name}`),
            h('div', { class: 'sub' }, `${r.exchange}${r.type ? ' · ' + r.type : ''} · ${r.currency}`),
            r.source === 'santiago' ? h('div', { class: 'sub ok-note' }, 'Precio diario de la Bolsa de Santiago, sin clave') : null,
            r.adr ? h('div', { class: 'sub ok-note' }, 'Versión en EE.UU. (ADR) · precio gratis · revisa que sea la misma empresa') : null,
            !r.free ? h('div', { class: 'sub warn-note' }, 'Esta bolsa no está en el plan gratis: usa precio manual') : null))) : h('p', { class: 'muted small' }, 'Sin resultados.'));
        } catch (e) { fill(results, h('p', { class: 'muted small' }, 'No se pudo buscar: ' + e.message)); }
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); search(); } });
      return { el: h('div', null, h('div', { class: 'sym-search' }, input, h('button', { type: 'button', class: 'btn small', onclick: search }, 'Buscar')), results), get: () => input.value.trim() };
    },
  };
}

export function editFund(f) {
  const isNew = !(f && f.id);
  const hasEntries = !isNew && db.all('invEntries').some(e => e.invId === f.id);
  const wasUnits = M.isUnits(f);
  const state = { mic: f ? f.mic || null : null };
  const converting = (v) => hasEntries && !wasUnits && v.type === 'units';
  const fm = formModal({
    title: isNew ? 'Nueva inversión' : 'Editar inversión',
    value: { currency: M.base(), horizon: 'short', type: 'fund', assetKind: 'etf', priceSource: 'twelve', ...(f || {}) },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'Ej: VOO en Zesty' },
      { key: 'type', label: 'Cómo la llevas', type: 'select', options: TYPES },
      { key: 'assetKind', label: 'Instrumento', type: 'select', options: ASSETS, show: (v) => v.type === 'units' },
      { key: 'priceSource', label: 'Precio', type: 'select', options: PX.SOURCES, show: (v) => v.type === 'units' },
      symbolField(state),
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.filter(c => c.convertible !== false).map(c => ({ v: c.code, l: c.code })) },
      { key: '_qty', label: 'Cantidad que tienes hoy', type: 'number', show: converting, hint: 'Lo anterior queda como estaba; desde hoy el valor es cantidad × precio.' },
      { key: '_price', label: 'Precio por unidad hoy (valor cuota)', type: 'number', show: (v) => converting(v) && v.priceSource === 'manual' },
      { key: 'horizon', label: 'Plazo', type: 'select', options: HORIZONS },
      { key: 'archived', label: 'Archivada (ocultar)', type: 'check' },
    ],
    onSave: async (v) => {
      const qty = v._qty, price = v._price;
      delete v._qty; delete v._price;
      if (v.type === 'units') {
        if (v.priceSource !== 'manual' && !v.symbol) { toast('Falta el símbolo (o elige precio manual)'); return false; }
        v.mic = v.priceSource === 'santiago' ? 'XSGO'
          : v.priceSource === 'twelve' ? ((state.mic !== 'XSGO' && state.mic) || (f && f.symbol === v.symbol && f.mic !== 'XSGO' ? f.mic : null) || undefined) : undefined;
        if (converting(v)) {
          if (!Number.isFinite(qty) || qty <= 0) { toast('Indica cuántas tienes hoy'); return false; }
          v.unitsFrom = M.todayStr(); v.unitsStart = qty;
        }
      } else { delete v.unitsFrom; delete v.unitsStart; }
      if (v.type !== 'units') { delete v.symbol; delete v.mic; delete v.assetKind; delete v.priceSource; }
      const saved = await db.put('investments', v);
      if (v.type === 'units' && converting(v) && price) await PX.setManualPrice(saved, M.todayStr(), Math.abs(price));
      if (v.type === 'units' && v.priceSource !== 'manual') {
        if (PX.sourceOf(v) === 'twelve' && !PX.getKey()) { askKey(); return; }
        PX.refreshPrices({ only: saved.id }).then(r => {
          if (!r.errors.length) return;
          const err = r.errors[0];
          toast(`${saved.name}: ${err.message}`, err.paid ? { ms: 15000, label: 'Usar precio manual', onAction: () => db.put('investments', { ...db.get('investments', saved.id), priceSource: 'manual' }) } : { ms: 8000 });
        });
      }
    },
    onDelete: !isNew ? async (v) => {
      await db.del('investments', v.id);
      await db.delMany('invEntries', db.all('invEntries').filter(x => x.invId === v.id).map(x => x.id));
    } : null,
    extra: !isNew ? h('div', { class: 'merge-box' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
      fm.close();
      await db.put('investments', { ...db.get('investments', f.id), type: 'points' });
      toast(`${f.name} pasó a Puntos y millas`, { label: 'Deshacer', onAction: () => db.put('investments', f) });
    } }, 'Es un programa de puntos o millas')) : null,
  });
  // los select se identifican para el buscador de símbolos
  const sels = fm.sheet.querySelectorAll('form select');
  const keys = ['type', 'assetKind', 'priceSource', 'currency', 'horizon'];
  sels.forEach((s, i) => { if (keys[i]) s.dataset.key = keys[i]; });
}

// ---- gráficos -----------------------------------------------------------------------------------

const SERIES = [{ name: 'Valor', color: '--viz-1', kind: 'line' }, { name: 'Aportado neto', color: '--viz-2', kind: 'line' }];
const pointOf = (ym) => ({ short: M.monthShort(ym).toLowerCase(), long: M.monthName(ym), ym });

// "Valor vs aportado neto": la distancia entre las dos líneas es la ganancia acumulada.
function valueChart({ months, hist, cur, title, subtitle, footnote }) {
  if (months.length < 2) return null;
  const value = hist.map(p => p.value), invested = hist.map(p => p.invested);
  return vizCard({
    title, subtitle,
    legendItems: SERIES,
    chart: lineChart({
      points: months.map(pointOf), cur,
      series: [{ name: 'Valor', values: value, color: '--viz-1', area: true }, { name: 'Aportado neto', values: invested, color: '--viz-2' }],
      extra: (i) => [{ value: M.fmt(value[i] - invested[i], cur, { sign: true }), label: 'Ganancia' }],
      ariaLabel: `${title}: valor ${M.fmt(value.at(-1), cur)}, aportado ${M.fmt(invested.at(-1), cur)}`,
    }),
    table: dataTable(['Mes', 'Valor', 'Aportado neto', 'Ganancia'],
      months.map((ym, i) => [M.monthName(ym), M.fmt(value[i], cur), M.fmt(invested[i], cur), M.fmt(value[i] - invested[i], cur, { sign: true })]).reverse()),
    footnote,
  });
}

const AFP_NOTE = 'Si dejaste de registrar aportes (por ejemplo, la cotización mensual), la ganancia se ve más alta de lo que es.';

// ---- detalle ------------------------------------------------------------------------------------

function openDetail(id) {
  const body = h('div');
  let m;
  const draw = () => {
    const inv = db.get('investments', id);
    if (!inv || M.isPoints(inv)) { if (m) m.close(); return; }
    const s = M.fundStats(inv);
    const cur = inv.currency;
    const units = M.isUnits(inv);
    const entries = db.all('invEntries').filter(e => e.invId === id).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 120);
    const first = M.firstInvestmentMonth(id);
    const months = first ? M.monthsBetween(first, M.curYm()) : [];
    const annual = M.annualReturn(inv);
    const kpi = (label, value, cls) => h('div', { class: cls || null }, h('span', null, label), value);
    const kpis = units ? [
      kpi('Valor actual', M.fmt(s.balance, cur)),
      kpi(`Cantidad`, `${fmtQty(s.qty)} ${unitWord(inv)}`),
      kpi('Precio', s.price ? `${fmtPrice(s.price.price, cur)} · ${dShort(s.price.date)}` : '—'),
      kpi(`Costo promedio por ${unitOne(inv)}`, s.qty ? fmtPrice(s.avgCost, cur) : '—'),
      kpi('Ganancia no realizada', `${M.fmt(s.unrealized, cur, { sign: true })} (${pct(s.cost ? s.unrealized / s.cost : null)})`),
      s.realized ? kpi('Ganancia realizada', M.fmt(s.realized, cur, { sign: true })) : null,
    ] : [
      kpi('Valor actual', M.fmt(s.balance, cur)),
      kpi('Aportado neto', M.fmt(s.invested, cur)),
    ];
    const divTotal = s.divPaid + s.divReinv;
    fill(body,
      h('div', { class: 'kpis' }, kpis,
        divTotal ? kpi('Dividendos (12 meses)', `${M.fmt(s.div12, cur)}${s.balance ? ` · ${pct(s.div12 / s.balance)}` : ''}`) : null,
        kpi('Rentabilidad total', `${M.fmt(s.totalGain, cur, { sign: true })} (${pct(s.contrib ? s.ret : null)})`),
        kpi('Rentabilidad anual', pct(annual))),
      units && inv.symbol ? h('p', { class: 'muted small' }, `${inv.symbol} · precio ${({ santiago: 'diario de la Bolsa de Santiago', twelve: 'automático (Twelve Data)', coingecko: 'automático (CoinGecko)', manual: 'manual' })[PX.sourceOf(inv)] || 'manual'}${s.price && s.price.trade ? ' (de la última compra/venta)' : ''}`) : null,
      h('div', { class: 'actions' }, units ? [
        h('button', { class: 'btn primary', onclick: () => tradeForm(inv, 'contrib') }, 'Compra'),
        h('button', { class: 'btn', onclick: () => tradeForm(inv, 'withdraw') }, 'Venta'),
        h('button', { class: 'btn', onclick: () => dividendForm(inv) }, 'Dividendo'),
        h('button', { class: 'btn', onclick: () => priceAction(inv) }, inv.priceSource === 'manual' ? 'Ingresar precio' : 'Actualizar precio'),
      ] : [
        h('button', { class: 'btn primary', onclick: () => updateValue(inv) }, 'Actualizar valor'),
        h('button', { class: 'btn', onclick: () => moneyForm(inv, 'contrib') }, 'Aporte'),
        h('button', { class: 'btn', onclick: () => moneyForm(inv, 'withdraw') }, 'Retiro'),
        h('button', { class: 'btn', onclick: () => dividendForm(inv) }, 'Dividendo'),
      ]),
      valueChart({ months, hist: M.fundHistory(id, months), cur, title: 'Evolución', subtitle: `En ${cur}, al cierre de cada mes`, footnote: units ? 'Valor = cantidad × precio al cierre de cada mes.' : AFP_NOTE }),
      h('h4', null, 'Historial'),
      entries.map(e => {
        const amt = e.kind === 'withdraw' ? -e.amount : e.amount;
        const what = e.units ? `${fmtQty(e.units)} × ${fmtPrice(e.price, cur)}${e.byTotal ? ' (promedio)' : ''}` : null;
        const extra = e.kind === 'dividend' ? (e.reinvested ? 'reinvertido' : e.txId && db.get('tx', e.txId) ? `a ${(M.account(db.get('tx', e.txId).accountId) || {}).name || 'cuenta'}` : 'pagado') : null;
        return h('button', { class: 'row', onclick: () => editEntry(inv, e) },
          h('div', { class: 'main' }, h('div', { class: 'title' }, kindLabel(inv, e)), h('div', { class: 'sub' }, [dShort(e.date), what, extra, e.note].filter(Boolean).join(' · '))),
          h('div', { class: 'amt ' + (amt < 0 ? 'neg' : '') }, M.fmt(amt, cur)));
      }),
      inv.unitsFrom ? h('p', { class: 'muted small' }, `Por cantidad desde el ${dShort(inv.unitsFrom)} (${fmtQty(inv.unitsStart)} ${unitWord(inv)} iniciales); antes, por valor.`) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => editFund(db.get('investments', id)) }, 'Editar inversión')));
  };
  const unsub = db.subscribe(draw);
  m = modal((db.get('investments', id) || {}).name || 'Inversión', body, { wide: true, onClose: unsub });
  draw();
}

// ---- lista --------------------------------------------------------------------------------------

const view = { span: 'all' };

export function renderInvest(root) {
  const funds = M.investmentSummaries();
  const base = M.base();
  const conv = (f) => (M.currencyInfo(f.currency).convertible === false ? null : f.balance * (M.rateFor(f.currency, M.todayStr()) ?? 1));
  const total = funds.reduce((a, f) => a + (conv(f) || 0), 0);
  const cur = M.curYm();
  const last24 = M.monthsBetween(M.addMonths(cur, -23), cur);
  const rowSub = (f) => M.isUnits(f)
    ? `${fmtQty(f.qty)} ${unitWord(f)}${f.symbol ? ' · ' + f.symbol : ''}${f.price ? ' · ' + fmtPrice(f.price.price, f.currency) : ''} · ${pct(f.contrib ? f.ret : null)}`
    : `${f.currency} · rentab. ${f.contrib ? pct(f.ret) : '—'}${f.last ? ' · act. ' + dShort(f.last) : ''}`;
  const group = (hz, title) => {
    const list = funds.filter(f => (f.horizon || 'short') === hz);
    if (!list.length) return null;
    return h('section', { class: 'card' }, h('h3', null, title), list.map(f => h('button', { class: 'row', onclick: () => openDetail(f.id) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, rowSub(f))),
      sparkline(M.fundHistory(f.id, last24).map(p => p.value)),     // tendencia de 24 meses (los valores están en la fila)
      h('div', { class: 'amt' }, h('div', null, M.fmt(f.balance, f.currency)),
        f.currency !== base && conv(f) != null ? h('div', { class: 'sub' }, `≈ ${M.fmt(conv(f), base)}`) : null))));
  };
  // evolución del total en moneda base
  const first = M.firstInvestmentMonth();
  let months = first ? M.monthsBetween(first, cur) : [];
  if (view.span !== 'all') months = months.slice(-Number(view.span));
  const spanSeg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'Período' }, [['12', '1 año'], ['36', '3 años'], ['all', 'Todo']].map(([v, l]) => h('button', {
    type: 'button', class: view.span === v ? 'on' : '', 'aria-pressed': String(view.span === v), onclick: () => { view.span = v; renderInvest(root); },
  }, l)));
  const archived = db.all('investments').filter(i => i.archived && !M.isPoints(i));
  // programas de puntos que quedaron como inversión (vienen del Excel)
  const pointsLike = db.all('investments').filter(M.looksLikePoints);
  const autos = PX.autoFunds();
  const pxAt = PX.lastRefreshAt();
  // precios automáticos: al abrir, si pasó más de una hora (los gráficos se redibujan solos)
  if (autos.length && !PX.needsKey()) PX.refreshPrices().catch(() => {});
  fill(root,
    pointsLike.length ? h('section', { class: 'card tidy' },
      h('div', { class: 'title' }, `Esto parece${pointsLike.length > 1 ? 'n programas' : ' un programa'} de puntos: ${pointsLike.map(i => i.name).join(', ')}`),
      h('p', { class: 'muted small' }, 'En Puntos y millas no se mezclan con los gráficos ni el total de inversiones, y no suman al patrimonio salvo que lo pidas.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: async () => {
        const prev = pointsLike.map(i => ({ ...i }));
        await db.putMany('investments', pointsLike.map(i => ({ ...i, type: 'points' })));
        toast(`${prev.length} movido${prev.length === 1 ? '' : 's'} a Puntos y millas`, { label: 'Deshacer', onAction: () => db.putMany('investments', prev), ms: 8000 });
      } }, 'Mover a Puntos y millas'), h('a', { class: 'btn small', href: '#/mas/puntos' }, 'Ver Puntos y millas'))) : null,
    h('section', { class: 'card hero' },
      h('div', { class: 'label' }, 'Total invertido (valor actual)'), h('div', { class: 'big' }, M.fmt(total, base)),
      autos.length ? h('div', { class: 'muted small' }, PX.needsKey() ? 'Precios automáticos sin activar.' : pxAt ? `Precios al ${new Date(pxAt).toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Precios aún sin consultar.') : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => editFund(null) }, '＋ Nueva inversión'),
        autos.length ? h('button', { class: 'btn', onclick: async () => {
          if (PX.needsKey()) { askKey(); return; }
          toast('Consultando precios…');
          const r = await PX.refreshPrices({ force: true });
          toast(r.errors.length ? r.errors.map(e => `${e.name ? e.name + ': ' : ''}${e.message}`).join(' · ') : `${r.updated} precio${r.updated === 1 ? '' : 's'} al día`, { ms: 6000 });
          renderInvest(root);
        } }, 'Actualizar precios') : null,
        h('button', { class: 'btn ghost', onclick: askKey }, PX.getKey() ? 'Clave de precios' : 'Activar precios automáticos'))),
    months.length > 1 ? h('div', { class: 'filters' }, spanSeg) : null,
    valueChart({
      months, hist: M.portfolioHistory(months), cur: base, title: 'Evolución del total',
      subtitle: `En ${base} al cierre de cada mes · incluye inversiones ya cerradas`,
      footnote: 'Las inversiones en otra moneda se convierten con el tipo de cambio de cada mes. ' + AFP_NOTE,
    }),
    group('short', 'Corto / mediano plazo'), group('long', 'Largo plazo'),
    archived.length ? h('section', { class: 'card' }, h('h3', null, 'Archivadas'), archived.map(f => h('button', { class: 'row', onclick: () => editFund(f) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, f.currency)), h('div', { class: 'amt muted' }, 'Editar')))) : null,
    !funds.length ? h('p', { class: 'empty' }, 'Sin inversiones aún.') : null);
}
