// Formulario de movimiento: captura rápida (nuevo) y edición.
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, parseNum, confirmDialog } from '../ui.js';

const LAST_ACC = 'moni.lastAccount';
const KIND_CATS = { out: ['expense', 'loan', 'invest', 'adjust'], in: ['income', 'loan', 'invest', 'adjust', 'expense'] };

// categorías más usadas en los últimos 400 movimientos (se recalcula solo si cambian los movimientos)
let recentCache = null;
db.subscribe((changed) => { if (!changed || changed.has('tx') || changed.has('categories')) recentCache = null; });
function recentCategoryIds(kind) {
  if (!recentCache) recentCache = {};
  if (recentCache[kind]) return recentCache[kind];
  const counts = new Map();
  const all = db.all('tx').filter(t => t.kind === kind && t.categoryId);
  all.sort((a, b) => b.date.localeCompare(a.date));
  for (const t of all.slice(0, 400)) counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  return (recentCache[kind] = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]));
}

export function categoryPicker(kind, current, onPick) {
  const allowed = KIND_CATS[kind] || KIND_CATS.out;
  const cats = M.categories().filter(c => !c.archived && allowed.includes(c.kind));
  const search = h('input', { type: 'search', placeholder: 'Buscar categoría…', autocomplete: 'off', 'aria-label': 'Buscar categoría' });
  const list = h('div', { class: 'cat-list' });
  let m;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const c of cats) {
      if (q && !(c.name.toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q))) continue;
      const g = c.group || 'Otras';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    fill(list, ...[...groups.entries()].map(([g, cs]) => h('div', { class: 'cat-group' },
      h('h4', null, g),
      h('div', { class: 'chips' }, cs.map(c => h('button', {
        type: 'button', class: 'chip' + (c.id === current ? ' on' : ''), 'aria-pressed': String(c.id === current), onclick: () => { onPick(c.id); m.close(); },
      }, (c.icon ? c.icon + ' ' : '') + c.name))))));
    if (!groups.size) fill(list, h('p', { class: 'muted' }, 'Sin resultados. Puedes crear categorías en Más › Categorías.'));
  };
  search.addEventListener('input', draw);
  m = modal('Categoría', h('div', null, search, list));
  draw();
}

// Reparto en el formulario: 'shared' | 'payer' (de quien pagó, sigue al pagador) | id de persona (elegido a mano)
const allocToState = (alloc) => (alloc === 'shared' ? 'shared' : alloc && alloc.startsWith('p:') ? alloc.slice(2) : 'payer');

export function openTxForm(existing, defaults = {}) {
  const people = M.people();
  const me = M.meId();
  const owner = M.ownerId();
  const isEdit = !!(existing && existing.id);
  const base = M.base();
  // cuentas activas + las del movimiento que se edita aunque estén archivadas
  let accounts = M.accounts();
  for (const id of isEdit ? [existing.accountId, existing.toAccountId] : []) {
    const a = id && M.account(id);
    if (a && !accounts.includes(a)) accounts = [...accounts, a];
  }
  const lastAcc = (() => { try { return localStorage.getItem(LAST_ACC); } catch { return null; } })();
  const usable = (id) => { const a = id && M.account(id); return a && !a.archived ? id : null; };

  // cuenta por defecto: para pagos entre ustedes, la que usaron la última vez (o la primera cuenta
  // bancaria); para gastos e ingresos, la última usada
  function defaultAccount(kind) {
    if (kind === 'settle') {
      const prev = M.sortTx(db.all('tx').filter(t => t.kind === 'settle' && usable(t.accountId)))[0];
      if (prev) return prev.accountId;
      const bank = accounts.find(a => !a.archived && a.type === 'bank' && a.currency === base) || accounts.find(a => !a.archived && a.type === 'bank');
      return bank ? bank.id : null;
    }
    return usable(lastAcc) || ((accounts.find(a => !a.archived) || {}).id) || null;
  }

  const s = {
    kind: 'out', date: M.todayStr(), amount: '', currency: null, accountId: null, toAccountId: null,
    categoryId: null, desc: '', paidBy: me, alloc: null, allocTouched: false, fx: null, fxTouched: false,
    tag: '', to: null, settleMonth: null, toAmount: '', accTouched: false,
    ...defaults,
  };
  if (isEdit) {
    Object.assign(s, existing, {
      amount: String(existing.amount).replace('.', ','), fx: existing.fx ?? null, fxTouched: existing.fx != null,
      desc: existing.desc || '', tag: existing.tag || '',
      toAmount: existing.toAmount != null ? String(existing.toAmount).replace('.', ',') : '',
    });
    s.alloc = allocToState(existing.alloc);
    s.allocTouched = true;
    s.accTouched = true;
  } else if (defaults.alloc !== undefined) {
    s.alloc = allocToState(defaults.alloc);   // duplicar: conserva el reparto elegido
    s.allocTouched = true;
  }
  // lo que paga otra persona no sale de las cuentas del dueño
  const ownerInvolved = () => (s.kind === 'settle' ? (s.paidBy === owner || s.to === owner) : s.paidBy === owner);
  if (!isEdit && !ownerInvolved()) s.accountId = null;
  else if (!isEdit && !s.accountId) s.accountId = defaultAccount(s.kind);

  const acc = () => M.account(s.accountId);
  if (acc()) s.currency = acc().currency;               // la moneda la define la cuenta
  if (!s.currency) s.currency = base;

  let ownerAcc = s.paidBy === owner ? s.accountId : null;
  function setPayer(v) {
    if (v === s.paidBy) return;
    if (s.paidBy === owner) ownerAcc = s.accountId;
    s.paidBy = v;
    if (v !== owner) s.accountId = null;
    else if (!s.accountId) {
      s.accountId = ownerAcc || defaultAccount(s.kind);
      if (acc()) { s.currency = acc().currency; s.fxTouched = false; }
    }
  }

  // Monto que llega en una transferencia entre monedas, según el tipo de cambio del día.
  const convert = (amt, from, to) => {
    const rf = M.rateFor(from, s.date), rt = M.rateFor(to, s.date);
    return Number.isFinite(amt) && rf != null && rt ? amt * rf / rt : null;
  };
  let toAmtInput = null;
  const toAmtHint = () => {
    const to = M.account(s.toAccountId);
    const v = to ? convert(parseNum(s.amount), s.currency, to.currency) : null;
    return v != null ? `≈ ${M.fmt(v, to.currency)} según el tipo de cambio (puedes corregirlo)` : `Monto que llega en ${to ? to.currency : ''}`;
  };

  const root = h('div', { class: 'txform' });
  let m;

  const resolveAlloc = () => {
    if (s.allocTouched) return;
    const cat = M.category(s.categoryId);
    s.alloc = allocToState(cat && cat.defaultAlloc);
  };
  resolveAlloc();

  const seg = (opts, value, onPick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label || null }, opts.map(o => h('button', {
    type: 'button', class: o.v === value ? 'on' : '', 'aria-pressed': String(o.v === value), onclick: () => onPick(o.v),
  }, o.l)));

  const kinds = [{ v: 'out', l: 'Gasto' }, { v: 'in', l: 'Ingreso' }, { v: 'transfer', l: 'Transferencia' }];
  if (people.length > 1) kinds.push({ v: 'settle', l: 'Saldar' });

  // Estos campos se crean una sola vez: si se recrearan en cada render, iOS cerraría el teclado o el selector de fecha.
  const amountIn = h('input', { class: 'amount', type: 'text', inputmode: 'decimal', placeholder: '0', value: s.amount, autocomplete: 'off', 'aria-label': 'Monto' });
  amountIn.addEventListener('input', () => { s.amount = amountIn.value; updateFx(); if (toAmtInput) toAmtInput.placeholder = toAmtHint(); });
  const dateIn = h('input', { type: 'date', value: s.date, 'aria-label': 'Fecha' });
  dateIn.addEventListener('change', () => {
    s.date = dateIn.value || M.todayStr();
    s.fxTouched = false;
    updateFx(); updateShareHint();
    if (toAmtInput) toAmtInput.placeholder = toAmtHint();
  });
  const descIn = h('input', { type: 'text', placeholder: 'Descripción (opcional)', value: s.desc, autocapitalize: 'sentences', 'aria-label': 'Descripción' });
  descIn.addEventListener('input', () => { s.desc = descIn.value; });
  const tagIn = h('input', { type: 'text', placeholder: 'Etiqueta (ej: Viaje sur)', value: s.tag, list: 'taglist', 'aria-label': 'Etiqueta' });
  tagIn.addEventListener('input', () => { s.tag = tagIn.value; });

  function updateFx() {
    const box = root.querySelector('.fxline');
    if (!box) return;
    if (s.currency === base || s.kind === 'transfer' && !s.toAccountId) { fill(box); return; }
    const auto = M.rateFor(s.currency, s.date);
    const rate = s.fxTouched && s.fx != null ? s.fx : auto;
    const a = parseNum(s.amount);
    const fxIn = h('input', { type: 'text', inputmode: 'decimal', value: rate != null ? String(rate).replace('.', ',') : '', placeholder: 'tipo de cambio', 'aria-label': 'Tipo de cambio' });
    fxIn.addEventListener('input', () => { s.fx = parseNum(fxIn.value); s.fxTouched = true; eq.textContent = eqText(); });
    const eqText = () => {
      const r = s.fxTouched ? s.fx : auto;
      return Number.isFinite(a) && r ? `≈ ${M.fmt(a * r, base)}` : (r == null ? 'Sin tipo de cambio guardado: ingrésalo' : '');
    };
    const eq = h('span', { class: 'muted' }, eqText());
    fill(box, h('label', { class: 'field inline' }, h('span', null, `1 ${s.currency} =`), fxIn, h('span', null, base)), eq);
  }

  let shareHint = null;
  function shareHintText() {
    const cat = M.category(s.categoryId);
    const monthPct = M.splitFor(s.date.slice(0, 7)).pct;
    const shText = people.map(p => `${p.name} ${Math.round((monthPct[p.id] || 0) * 100)}%`).join(' · ');
    const catMode = cat && cat.splitMode === 'fixed' ? 'regla fija de la categoría' : cat && cat.splitMode === 'equal' ? 'partes iguales' : 'según sueldos';
    return `${shText} (${catMode})`;
  }
  function updateShareHint() { if (shareHint) shareHint.textContent = shareHintText(); }

  function render() {
    const cat = M.category(s.categoryId);
    const isFlow = s.kind === 'out' || s.kind === 'in';
    const kindCats = KIND_CATS[s.kind] || [];
    const recents = isFlow ? recentCategoryIds(s.kind).map(id => M.category(id)).filter(c => c && !c.archived && kindCats.includes(c.kind)).slice(0, 8) : [];
    const chipCats = [...recents];
    if (cat && !chipCats.find(c => c.id === cat.id)) chipCats.unshift(cat);

    const accLabel = (a) => `${a.name} (${a.currency})${a.archived ? ' · archivada' : ''}`;
    const selAcc = (key, noneLabel) => {
      const opts = [...((noneLabel || !s[key]) ? [{ v: '', l: noneLabel || '— elige una cuenta —' }] : []), ...accounts.map(a => ({ v: a.id, l: accLabel(a) }))];
      const el = h('select', { 'aria-label': key === 'toAccountId' ? 'Cuenta de destino' : 'Cuenta' }, opts.map(o => h('option', { value: o.v, selected: o.v === (s[key] || '') }, o.l)));
      el.addEventListener('change', () => {
        s[key] = el.value || null;
        s.accTouched = true;
        if (key === 'accountId' && s.accountId) { s.currency = acc().currency; s.fxTouched = false; }
        render();
      });
      return el;
    };

    // con una cuenta elegida la moneda es la de la cuenta (el saldo se lleva en esa moneda)
    const cur = h('select', { class: 'cur', disabled: !!s.accountId, 'aria-label': 'Moneda', title: s.accountId ? 'La moneda la define la cuenta' : '' },
      M.settings().currencies.map(c => h('option', { value: c.code, selected: c.code === s.currency }, c.code)));
    cur.addEventListener('change', () => { s.currency = cur.value; s.fxTouched = false; updateFx(); });

    const tags = [...new Set(db.all('tx').map(t => t.tag).filter(Boolean))];

    const parts = [];
    parts.push(seg(kinds, s.kind, (v) => {
      const prevKind = s.kind;
      s.kind = v;
      if (v === 'settle') {
        s.to = s.to || (people.find(p => p.id !== s.paidBy) || {}).id;
        if (!s.settleMonth) { const d = s.date; s.settleMonth = Number(d.slice(8)) <= 10 ? M.addMonths(d.slice(0, 7), -1) : d.slice(0, 7); }
      }
      // las transferencias son entre cuentas del dueño
      if (v === 'transfer') { s.categoryId = null; s.paidBy = owner; if (!s.accountId) s.accountId = defaultAccount('out'); }
      // la cuenta sugerida cambia con el tipo, salvo que la hayas elegido a mano
      if (!s.accTouched && (v === 'settle') !== (prevKind === 'settle')) {
        s.accountId = ownerInvolved() ? defaultAccount(v) : null;
      }
      if (acc()) { s.currency = acc().currency; s.fxTouched = false; }
      s.allocTouched = isEdit && s.allocTouched; resolveAlloc(); render();
    }, 'Tipo de movimiento'));
    parts.push(h('div', { class: 'amount-row' }, amountIn, cur));
    parts.push(h('div', { class: 'fxline' }));

    if (isFlow) {
      parts.push(h('div', { class: 'field' }, h('span', null, 'Categoría'),
        h('div', { class: 'chips' },
          chipCats.map(c => h('button', { type: 'button', class: 'chip' + (c.id === s.categoryId ? ' on' : ''), 'aria-pressed': String(c.id === s.categoryId), onclick: () => { s.categoryId = c.id; resolveAlloc(); render(); } }, (c.icon ? c.icon + ' ' : '') + c.name)),
          h('button', { type: 'button', class: 'chip more', onclick: () => categoryPicker(s.kind, s.categoryId, (id) => { s.categoryId = id; resolveAlloc(); render(); }) }, 'Todas…'))));
      parts.push(h('label', { class: 'field' }, h('span', null, s.kind === 'in' ? 'Cuenta de destino' : 'Cuenta'),
        selAcc('accountId', s.paidBy !== owner ? `— sin cuenta (lo ${s.kind === 'in' ? 'recibió' : 'pagó'} ${M.personName(s.paidBy)}) —` : null)));
    }
    if (s.kind === 'transfer') {
      parts.push(h('label', { class: 'field' }, h('span', null, 'Desde'), selAcc('accountId')));
      parts.push(h('label', { class: 'field' }, h('span', null, 'Hacia'), selAcc('toAccountId')));
      const to = M.account(s.toAccountId);
      toAmtInput = null;
      if (to && to.currency !== s.currency) {
        const ta = h('input', { type: 'text', inputmode: 'decimal', value: s.toAmount, placeholder: toAmtHint() });
        ta.addEventListener('input', () => { s.toAmount = ta.value; });
        toAmtInput = ta;
        parts.push(h('label', { class: 'field' }, h('span', null, `Monto recibido (${to.currency})`), ta,
          h('small', null, 'Si lo dejas vacío se calcula con el tipo de cambio del día.')));
      }
    }
    if (s.kind === 'settle') {
      parts.push(h('p', { class: 'muted small' }, 'Pago entre ustedes para saldar el cierre de un mes (no es un gasto).'));
      const pOpts = people.map(p => ({ v: p.id, l: p.name }));
      parts.push(h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('span', null, 'Paga'), seg(pOpts, s.paidBy, (v) => { s.paidBy = v; if (s.to === v) s.to = (people.find(p => p.id !== v) || {}).id; if (!ownerInvolved()) s.accountId = null; render(); }, 'Paga')),
        h('div', { class: 'field' }, h('span', null, 'Recibe'), seg(pOpts, s.to, (v) => { s.to = v; if (s.paidBy === v) s.paidBy = (people.find(p => p.id !== v) || {}).id; if (!ownerInvolved()) s.accountId = null; render(); }, 'Recibe'))));
      const mo = h('input', { type: 'month', value: s.settleMonth, 'aria-label': 'Mes del cierre' });
      mo.addEventListener('change', () => { s.settleMonth = mo.value; });
      parts.push(h('label', { class: 'field' }, h('span', null, 'Corresponde al cierre de'), mo));
      if (ownerInvolved()) parts.push(h('label', { class: 'field' }, h('span', null, 'Cuenta de ' + M.personName(owner)), selAcc('accountId', '— sin cuenta —')));
    }

    shareHint = null;
    if (isFlow && people.length > 1) {
      parts.push(h('div', { class: 'field' }, h('span', null, s.kind === 'in' ? 'Lo recibió' : 'Lo pagó'),
        seg(people.map(p => ({ v: p.id, l: p.name })), s.paidBy, (v) => { setPayer(v); resolveAlloc(); render(); }, s.kind === 'in' ? 'Lo recibió' : 'Lo pagó')));
      const shown = s.alloc === 'payer' ? s.paidBy : s.alloc;
      if (s.alloc === 'shared') shareHint = h('small', null, shareHintText());
      parts.push(h('div', { class: 'field' }, h('span', null, 'Reparto'),
        seg([{ v: 'shared', l: 'Compartido' }, ...people.map(p => ({ v: p.id, l: `Solo de ${p.name}` }))], shown, (v) => { s.alloc = v; s.allocTouched = true; render(); }, 'Reparto'),
        shareHint));
    }

    parts.push(h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', null, 'Fecha'), dateIn), h('label', { class: 'field' }, h('span', null, 'Etiqueta'), tagIn)));
    parts.push(descIn);
    parts.push(h('datalist', { id: 'taglist' }, tags.map(t => h('option', { value: t }))));
    fill(root, ...parts);
    updateFx();
  }

  // evita guardar dos veces con un doble toque mientras se escribe en IndexedDB
  let saving = false;
  async function save(again) {
    if (saving) return;
    saving = true;
    try { await doSave(again); } finally { saving = false; }
  }

  async function doSave(again) {
    const amount = parseNum(s.amount);
    if (!Number.isFinite(amount) || amount === 0) { toast('Ingresa un monto'); amountIn.focus(); return; }
    const isFlow = s.kind === 'out' || s.kind === 'in';
    if (isFlow && !s.categoryId) { toast('Elige una categoría'); return; }
    if (s.kind === 'transfer' && (!s.accountId || !s.toAccountId || s.accountId === s.toAccountId)) { toast('Elige dos cuentas distintas'); return; }
    if (s.kind === 'settle' && (!s.to || s.to === s.paidBy)) { toast('Elige quién paga y quién recibe'); return; }
    if (s.accountId && acc() && acc().currency !== s.currency) s.currency = acc().currency;   // nunca un monto en otra moneda que su cuenta

    const tx = {
      ...(isEdit ? existing : {}),
      date: s.date, kind: s.kind, amount: Math.abs(amount), currency: s.currency,
      accountId: s.accountId || null, desc: s.desc.trim(), tag: s.tag.trim() || undefined, paidBy: s.paidBy,
    };
    if (!isEdit) tx.id = db.uid();
    const fx = s.currency === M.base() ? null : (s.fxTouched && s.fx ? s.fx : M.rateFor(s.currency, s.date));
    if (fx != null && s.currency !== M.base()) tx.fx = fx; else delete tx.fx;
    if (isFlow) {
      tx.categoryId = s.categoryId;
      tx.alloc = s.alloc === 'shared' ? 'shared' : (s.alloc === 'payer' || !s.alloc || s.alloc === s.paidBy ? 'none' : 'p:' + s.alloc);
      if (s.accountId && s.paidBy === owner) { try { localStorage.setItem(LAST_ACC, s.accountId); } catch { /* ignore */ } }
      delete tx.to; delete tx.toAccountId; delete tx.toAmount; delete tx.settleMonth;
    } else if (s.kind === 'transfer') {
      tx.toAccountId = s.toAccountId; delete tx.categoryId; delete tx.alloc; delete tx.to; delete tx.settleMonth;
      const toCur = M.account(s.toAccountId).currency;
      let ta = parseNum(s.toAmount);
      if (toCur !== s.currency && !Number.isFinite(ta)) {
        ta = convert(Math.abs(amount), s.currency, toCur);
        if (ta == null) { toast(`Falta el tipo de cambio: escribe el monto recibido en ${toCur}`); return; }
        ta = Math.round(ta * 100) / 100;
      }
      if (toCur !== s.currency && Number.isFinite(ta)) tx.toAmount = Math.abs(ta); else delete tx.toAmount;
    } else {
      tx.to = s.to; tx.settleMonth = s.settleMonth; delete tx.categoryId; delete tx.alloc; delete tx.toAccountId; delete tx.toAmount;
      if (!ownerInvolved()) tx.accountId = null;
    }
    if (!tx.tag) delete tx.tag;
    const before = isEdit ? { ...existing } : null;
    await db.put('tx', tx);
    toast(isEdit ? 'Cambios guardados' : 'Movimiento guardado', {
      label: 'Deshacer', onAction: async () => { if (isEdit) await db.put('tx', before); else await db.del('tx', tx.id); },
    });
    if (again && !isEdit) {
      s.amount = ''; s.desc = ''; amountIn.value = ''; descIn.value = ''; s.fxTouched = false; render(); amountIn.focus();
    } else m.close();
  }

  const dup = isEdit ? h('button', { class: 'btn ghost', onclick: () => {
    m.close();
    const { id, createdAt, updatedAt, ref, ...rest } = existing;
    openTxForm(null, { ...rest, date: M.todayStr(), amount: String(rest.amount).replace('.', ','), toAmount: rest.toAmount != null ? String(rest.toAmount).replace('.', ',') : '', alloc: rest.alloc ?? 'none' });
  } }, 'Duplicar') : null;
  const delBtn = isEdit ? h('button', { class: 'btn danger ghost', onclick: async () => {
    if (await confirmDialog('¿Eliminar este movimiento?')) {
      const copy = { ...existing };
      await db.del('tx', existing.id); m.close();
      toast('Movimiento eliminado', { label: 'Deshacer', onAction: () => db.put('tx', copy) });
    }
  } }, 'Eliminar') : null;

  m = modal(isEdit ? 'Editar movimiento' : 'Nuevo movimiento', h('form', { onsubmit: (e) => { e.preventDefault(); save(false); } }, root), {
    actions: [delBtn, dup, h('span', { class: 'spacer' }),
      !isEdit ? h('button', { class: 'btn', onclick: () => save(true) }, 'Guardar y otro') : null,
      h('button', { class: 'btn primary', onclick: () => save(false) }, 'Guardar')],
    dismissable: false,
  });
  render();
  // foco dentro del mismo toque que abrió el formulario: así iOS muestra el teclado
  if (!isEdit) amountIn.focus();
  return m;
}
