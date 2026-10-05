// Formulario de movimiento: captura rápida (nuevo) y edición.
import * as db from '../db.js';
import * as M from '../model.js';
import { h, modal, toast, parseNum, confirmDialog } from '../ui.js';

const LAST_ACC = 'moni.lastAccount';
const KIND_CATS = { out: ['expense', 'loan', 'invest', 'adjust'], in: ['income', 'loan', 'invest', 'adjust', 'expense'] };

function recentCategoryIds(kind) {
  const counts = new Map();
  const all = db.all('tx').filter(t => t.kind === kind && t.categoryId);
  all.sort((a, b) => b.date.localeCompare(a.date));
  for (const t of all.slice(0, 400)) counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

export function categoryPicker(kind, current, onPick) {
  const allowed = KIND_CATS[kind] || KIND_CATS.out;
  const cats = M.categories().filter(c => !c.archived && allowed.includes(c.kind));
  const search = h('input', { type: 'search', placeholder: 'Buscar categoría…', autocomplete: 'off' });
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
    list.replaceChildren(...[...groups.entries()].map(([g, cs]) => h('div', { class: 'cat-group' },
      h('h4', null, g),
      h('div', { class: 'chips' }, cs.map(c => h('button', {
        type: 'button', class: 'chip' + (c.id === current ? ' on' : ''), onclick: () => { onPick(c.id); m.close(); },
      }, (c.icon ? c.icon + ' ' : '') + c.name))))));
    if (!groups.size) list.replaceChildren(h('p', { class: 'muted' }, 'Sin resultados. Puedes crear categorías en Más › Categorías.'));
  };
  search.addEventListener('input', draw);
  m = modal('Categoría', h('div', null, search, list));
  draw();
  setTimeout(() => search.focus(), 80);
}

export function openTxForm(existing, defaults = {}) {
  const people = M.people();
  const me = M.meId();
  const isEdit = !!(existing && existing.id);
  const base = M.base();
  const accounts = M.accounts();
  const lastAcc = (() => { try { return localStorage.getItem(LAST_ACC); } catch { return null; } })();

  const s = {
    kind: 'out', date: M.todayStr(), amount: '', currency: null, accountId: null, toAccountId: null,
    categoryId: null, desc: '', paidBy: me, alloc: null, allocTouched: false, fx: null, fxTouched: false,
    tag: '', to: null, settleMonth: null, toAmount: '',
    ...defaults,
  };
  if (isEdit) {
    Object.assign(s, existing, { amount: String(existing.amount).replace('.', ','), fx: existing.fx ?? null, fxTouched: existing.fx != null, desc: existing.desc || '', tag: existing.tag || '', toAmount: existing.toAmount != null ? String(existing.toAmount).replace('.', ',') : '' });
    s.alloc = existing.alloc === 'shared' ? 'shared' : existing.alloc && existing.alloc.startsWith('p:') ? existing.alloc.slice(2) : existing.paidBy;
    s.allocTouched = true;
  } else if (!s.accountId) {
    s.accountId = (lastAcc && M.account(lastAcc)) ? lastAcc : (accounts[0] || {}).id;
  }
  const acc = () => M.account(s.accountId);
  if (!s.currency) s.currency = (acc() || {}).currency || base;

  const root = h('div', { class: 'txform' });
  let m;

  const resolveAlloc = () => {
    if (s.allocTouched) return;
    const cat = M.category(s.categoryId);
    const d = cat && cat.defaultAlloc;
    s.alloc = d === 'shared' ? 'shared' : (d && d.startsWith('p:') ? d.slice(2) : s.paidBy);
  };
  resolveAlloc();

  const seg = (opts, value, onPick) => h('div', { class: 'seg' }, opts.map(o => h('button', {
    type: 'button', class: o.v === value ? 'on' : '', onclick: () => onPick(o.v),
  }, o.l)));

  const kinds = [{ v: 'out', l: 'Gasto' }, { v: 'in', l: 'Ingreso' }, { v: 'transfer', l: 'Transferencia' }];
  if (people.length > 1) kinds.push({ v: 'settle', l: 'Saldar' });

  const amountIn = h('input', { class: 'amount', type: 'text', inputmode: 'decimal', placeholder: '0', value: s.amount, autocomplete: 'off' });
  amountIn.addEventListener('input', () => { s.amount = amountIn.value; updateFx(); });

  function updateFx() {
    const box = root.querySelector('.fxline');
    if (!box) return;
    if (s.currency === base || s.kind === 'transfer' && !s.toAccountId) { box.replaceChildren(); return; }
    const auto = M.rateFor(s.currency, s.date);
    const rate = s.fxTouched && s.fx != null ? s.fx : auto;
    const a = parseNum(s.amount);
    const fxIn = h('input', { type: 'text', inputmode: 'decimal', value: rate != null ? String(rate).replace('.', ',') : '', placeholder: 'tipo de cambio' });
    fxIn.addEventListener('input', () => { s.fx = parseNum(fxIn.value); s.fxTouched = true; eq.textContent = eqText(); });
    const eqText = () => {
      const r = s.fxTouched ? s.fx : auto;
      return Number.isFinite(a) && r ? `≈ ${M.fmt(a * r, base)}` : (r == null ? 'Sin tipo de cambio guardado: ingrésalo' : '');
    };
    const eq = h('span', { class: 'muted' }, eqText());
    box.replaceChildren(h('label', { class: 'field inline' }, h('span', null, `1 ${s.currency} =`), fxIn, h('span', null, base)), eq);
  }

  function render() {
    const cat = M.category(s.categoryId);
    const monthPct = M.splitFor(s.date.slice(0, 7)).pct;
    const isFlow = s.kind === 'out' || s.kind === 'in';
    const kindCats = KIND_CATS[s.kind] || [];
    const recents = isFlow ? recentCategoryIds(s.kind).map(id => M.category(id)).filter(c => c && !c.archived && kindCats.includes(c.kind)).slice(0, 8) : [];
    const chipCats = [...recents];
    if (cat && !chipCats.find(c => c.id === cat.id)) chipCats.unshift(cat);

    const accOpts = (withNone) => [...(withNone ? [{ v: '', l: '— sin cuenta —' }] : []), ...accounts.map(a => ({ v: a.id, l: `${a.name} (${a.currency})` }))];
    const selAcc = (key, withNone) => {
      const el = h('select', null, accOpts(withNone).map(o => h('option', { value: o.v, selected: o.v === (s[key] || '') }, o.l)));
      el.addEventListener('change', () => {
        s[key] = el.value || null;
        if (key === 'accountId' && s.accountId) { s.currency = acc().currency; s.fxTouched = false; render(); }
        else if (key === 'toAccountId') render();
      });
      return el;
    };

    const cur = h('select', { class: 'cur' }, M.settings().currencies.map(c => h('option', { value: c.code, selected: c.code === s.currency }, c.code)));
    cur.addEventListener('change', () => { s.currency = cur.value; s.fxTouched = false; updateFx(); });

    const dateIn = h('input', { type: 'date', value: s.date });
    dateIn.addEventListener('change', () => { s.date = dateIn.value || M.todayStr(); s.fxTouched = false; render(); });

    const descIn = h('input', { type: 'text', placeholder: 'Descripción (opcional)', value: s.desc, autocapitalize: 'sentences' });
    descIn.addEventListener('input', () => { s.desc = descIn.value; });

    const tags = [...new Set(db.all('tx').map(t => t.tag).filter(Boolean))];
    const tagIn = h('input', { type: 'text', placeholder: 'Etiqueta (ej: Viaje sur)', value: s.tag, list: 'taglist' });
    tagIn.addEventListener('input', () => { s.tag = tagIn.value; });

    const parts = [];
    parts.push(seg(kinds, s.kind, (v) => {
      s.kind = v;
      if (v === 'settle') {
        s.to = s.to || (people.find(p => p.id !== s.paidBy) || {}).id;
        if (!s.settleMonth) { const d = s.date; s.settleMonth = Number(d.slice(8)) <= 10 ? M.addMonths(d.slice(0, 7), -1) : d.slice(0, 7); }
      }
      if (v === 'transfer') s.categoryId = null;
      s.allocTouched = false; resolveAlloc(); render();
    }));
    parts.push(h('div', { class: 'amount-row' }, amountIn, cur));
    parts.push(h('div', { class: 'fxline' }));

    if (isFlow) {
      parts.push(h('div', { class: 'field' }, h('span', null, 'Categoría'),
        h('div', { class: 'chips' },
          chipCats.map(c => h('button', { type: 'button', class: 'chip' + (c.id === s.categoryId ? ' on' : ''), onclick: () => { s.categoryId = c.id; resolveAlloc(); render(); } }, (c.icon ? c.icon + ' ' : '') + c.name)),
          h('button', { type: 'button', class: 'chip more', onclick: () => categoryPicker(s.kind, s.categoryId, (id) => { s.categoryId = id; resolveAlloc(); render(); }) }, 'Todas…'))));
      parts.push(h('label', { class: 'field' }, h('span', null, s.kind === 'in' ? 'Cuenta de destino' : 'Cuenta'), selAcc('accountId', s.paidBy !== M.ownerId() || !s.accountId)));
    }
    if (s.kind === 'transfer') {
      parts.push(h('label', { class: 'field' }, h('span', null, 'Desde'), selAcc('accountId', false)));
      parts.push(h('label', { class: 'field' }, h('span', null, 'Hacia'), selAcc('toAccountId', false)));
      const to = M.account(s.toAccountId);
      if (to && to.currency !== s.currency) {
        const ta = h('input', { type: 'text', inputmode: 'decimal', value: s.toAmount, placeholder: `Monto que llega en ${to.currency}` });
        ta.addEventListener('input', () => { s.toAmount = ta.value; });
        parts.push(h('label', { class: 'field' }, h('span', null, `Monto recibido (${to.currency})`), ta));
      }
    }
    if (s.kind === 'settle') {
      parts.push(h('p', { class: 'muted small' }, 'Pago entre ustedes para saldar el cierre de un mes (no es un gasto).'));
      const pOpts = people.map(p => ({ v: p.id, l: p.name }));
      parts.push(h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('span', null, 'Paga'), seg(pOpts, s.paidBy, (v) => { s.paidBy = v; if (s.to === v) s.to = (people.find(p => p.id !== v) || {}).id; render(); })),
        h('div', { class: 'field' }, h('span', null, 'Recibe'), seg(pOpts, s.to, (v) => { s.to = v; if (s.paidBy === v) s.paidBy = (people.find(p => p.id !== v) || {}).id; render(); }))));
      const mo = h('input', { type: 'month', value: s.settleMonth });
      mo.addEventListener('change', () => { s.settleMonth = mo.value; });
      parts.push(h('label', { class: 'field' }, h('span', null, 'Corresponde al cierre de'), mo));
      parts.push(h('label', { class: 'field' }, h('span', null, 'Cuenta (opcional)'), selAcc('accountId', true)));
    }

    if (isFlow && people.length > 1) {
      parts.push(h('div', { class: 'field' }, h('span', null, s.kind === 'in' ? 'Lo recibió' : 'Lo pagó'),
        seg(people.map(p => ({ v: p.id, l: p.name })), s.paidBy, (v) => { s.paidBy = v; if (v !== M.ownerId() && !s.accountId) { /* sin cuenta */ } resolveAlloc(); render(); })));
      const shText = people.map(p => `${p.name} ${Math.round((monthPct[p.id] || 0) * 100)}%`).join(' · ');
      const catMode = cat && cat.splitMode === 'fixed' ? 'regla fija de la categoría' : cat && cat.splitMode === 'equal' ? 'partes iguales' : 'según sueldos';
      parts.push(h('div', { class: 'field' }, h('span', null, 'Reparto'),
        seg([{ v: 'shared', l: 'Compartido' }, ...people.map(p => ({ v: p.id, l: `Solo de ${p.name}` }))], s.alloc, (v) => { s.alloc = v; s.allocTouched = true; render(); }),
        s.alloc === 'shared' ? h('small', null, `${shText} (${catMode})`) : null));
    }

    parts.push(h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', null, 'Fecha'), dateIn), h('label', { class: 'field' }, h('span', null, 'Etiqueta'), tagIn)));
    parts.push(descIn);
    parts.push(h('datalist', { id: 'taglist' }, tags.map(t => h('option', { value: t }))));
    root.replaceChildren(...parts);
    updateFx();
  }

  async function save(again) {
    const amount = parseNum(s.amount);
    if (!Number.isFinite(amount) || amount === 0) { toast('Ingresa un monto'); amountIn.focus(); return; }
    const isFlow = s.kind === 'out' || s.kind === 'in';
    if (isFlow && !s.categoryId) { toast('Elige una categoría'); return; }
    if (s.kind === 'transfer' && (!s.accountId || !s.toAccountId || s.accountId === s.toAccountId)) { toast('Elige dos cuentas distintas'); return; }
    if (s.kind === 'settle' && (!s.to || s.to === s.paidBy)) { toast('Elige quién paga y quién recibe'); return; }

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
      tx.alloc = s.alloc === 'shared' ? 'shared' : (s.alloc === s.paidBy || !s.alloc ? 'none' : 'p:' + s.alloc);
      if (s.accountId && s.paidBy === M.ownerId()) { try { localStorage.setItem(LAST_ACC, s.accountId); } catch { /* ignore */ } }
      delete tx.to; delete tx.toAccountId; delete tx.toAmount; delete tx.settleMonth;
    } else if (s.kind === 'transfer') {
      tx.toAccountId = s.toAccountId; delete tx.categoryId; delete tx.alloc; delete tx.to; delete tx.settleMonth;
      const ta = parseNum(s.toAmount);
      if (Number.isFinite(ta)) tx.toAmount = ta; else delete tx.toAmount;
    } else {
      tx.to = s.to; tx.settleMonth = s.settleMonth; delete tx.categoryId; delete tx.alloc; delete tx.toAccountId; delete tx.toAmount;
    }
    if (!tx.tag) delete tx.tag;
    const before = isEdit ? { ...existing } : null;
    await db.put('tx', tx);
    toast(isEdit ? 'Cambios guardados' : 'Movimiento guardado', {
      label: 'Deshacer', onAction: async () => { if (isEdit) await db.put('tx', before); else await db.del('tx', tx.id); },
    });
    if (again && !isEdit) {
      s.amount = ''; s.desc = ''; amountIn.value = ''; s.fxTouched = false; render(); amountIn.focus();
    } else m.close();
  }

  const dup = isEdit ? h('button', { class: 'btn ghost', onclick: () => { m.close(); const { id, createdAt, updatedAt, ref, ...rest } = existing; openTxForm(null, { ...rest, date: M.todayStr(), amount: String(rest.amount) }); } }, 'Duplicar') : null;
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
  });
  render();
  if (!isEdit) setTimeout(() => amountIn.focus(), 120);
  return m;
}
