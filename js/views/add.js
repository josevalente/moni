// Formulario de movimiento: captura rápida (nuevo) y edición.
// Gastos e ingresos se capturan "descripción primero": al escribir aparecen movimientos anteriores
// parecidos y un toque completa categoría, cuenta, quién pagó y reparto. Fecha, quién pagó, reparto y
// etiqueta van en una línea resumida que se abre solo para cambiarlos.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, modal, toast, confirmDialog, numText, groupDigits } from '../ui.js';

const LAST_ACC = 'moni.lastAccount';
const KIND_CATS = { out: ['expense', 'loan', 'invest', 'adjust'], in: ['income', 'loan', 'invest', 'adjust', 'expense'] };
const KINDS = [['out', 'Gasto'], ['in', 'Ingreso'], ['transfer', 'Transferencia'], ['settle', 'Saldar']];

// categorías más usadas en los últimos 400 movimientos (se recalcula solo si cambian los movimientos)
let recentCache = null;
db.subscribe((changed) => { if (!changed || changed.has('tx') || changed.has('categories')) recentCache = null; });
function recentCategoryIds(kind) {
  if (!recentCache) recentCache = {};
  if (recentCache[kind]) return recentCache[kind];
  const counts = new Map();
  const all = db.all('tx').filter(t => t.kind === kind && t.categoryId);
  all.sort((a, b) => b.date.localeCompare(a.date));
  for (const t of all.slice(0, 400)) { const c = M.category(t.categoryId); if (c) counts.set(c.id, (counts.get(c.id) || 0) + 1); }
  return (recentCache[kind] = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]));
}

// Selector de categoría con búsqueda. `kinds` restringe la naturaleza; `exclude` oculta una categoría.
export function categoryPicker(kind, current, onPick, { kinds, exclude, title = 'Categoría' } = {}) {
  const allowed = kinds || KIND_CATS[kind] || KIND_CATS.out;
  const cats = M.categories().filter(c => !c.archived && allowed.includes(c.kind) && c.id !== exclude);
  const search = h('input', { type: 'search', placeholder: 'Buscar categoría…', autocomplete: 'off', 'aria-label': 'Buscar categoría' });
  const list = h('div', { class: 'cat-list' });
  let m;
  const draw = () => {
    const q = M.stripAccents(search.value.trim().toLowerCase());
    const groups = new Map();
    for (const c of cats) {
      if (q && !(M.stripAccents(c.name.toLowerCase()).includes(q) || M.stripAccents((c.group || '').toLowerCase()).includes(q))) continue;
      const g = c.group || 'Otras';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    fill(list, ...[...groups.entries()].map(([g, cs]) => h('div', { class: 'cat-group' },
      h('h4', null, g),
      h('div', { class: 'chips' }, cs.map(c => h('button', {
        type: 'button', class: 'chip' + (c.id === current ? ' on' : ''), 'aria-pressed': String(c.id === current), onclick: () => { m.close(); onPick(c.id); },
      }, (c.icon ? c.icon + ' ' : '') + c.name))))));
    if (!groups.size) fill(list, h('p', { class: 'muted' }, 'Sin resultados. Puedes crear categorías en Más › Categorías.'));
  };
  search.addEventListener('input', draw);
  m = modal(title, h('div', null, search, list));
  draw();
}

// Reparto en el formulario: 'shared' | 'payer' (de quien pagó, sigue al pagador) | id de persona (elegido a mano)
const allocToState = (alloc) => (alloc === 'shared' ? 'shared' : alloc && alloc.startsWith('p:') ? alloc.slice(2) : 'payer');

let formSeq = 0;

export function openTxForm(existing, defaults = {}) {
  const people = M.people();
  const me = M.meId();
  const owner = M.ownerId();
  const isEdit = !!(existing && existing.id);
  const base = M.base();
  const today = M.todayStr();
  const yesterday = new Date(Date.parse(today + 'T12:00:00') - 864e5).toISOString().slice(0, 10);
  // cuentas activas + las del movimiento que se edita aunque estén archivadas
  let accounts = M.accounts();
  for (const id of isEdit ? [existing.accountId, existing.toAccountId] : []) {
    const a = id && M.account(id);
    if (a && !accounts.includes(a)) accounts = [...accounts, a];
  }
  const lastAcc = (() => { try { return localStorage.getItem(LAST_ACC); } catch { return null; } })();
  const usable = (id) => { const a = id && M.account(id); return a && !a.archived ? id : null; };
  // las 2 cuentas más usadas en 6 meses van como botones (en tus datos cubren el 91% de los gastos)
  const topAccounts = (() => {
    const cut = M.addMonths(M.curYm(), -6) + '-01';
    const n = new Map();
    for (const t of db.all('tx')) if ((t.kind === 'out' || t.kind === 'in') && usable(t.accountId) && t.date >= cut) n.set(t.accountId, (n.get(t.accountId) || 0) + 1);
    const ids = [...n.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    for (const a of accounts) if (!a.archived && !ids.includes(a.id)) ids.push(a.id);
    return ids.slice(0, 2);
  })();

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

  const { focus: focusTarget, lastAmount: lastAmountDefault, lockAccount = false, ...rest } = defaults;
  const s = {
    kind: 'out', date: today, amount: '', currency: null, accountId: null, toAccountId: null,
    categoryId: null, desc: '', paidBy: me, alloc: null, allocTouched: false, fx: null, fxTouched: false,
    tag: '', to: null, settleMonth: null, toAmount: '', accTouched: false, open: null, lastAmount: lastAmountDefault || null,
    ...rest,
  };
  if (isEdit) {
    Object.assign(s, existing, {
      amount: numText(existing.amount), fx: existing.fx ?? null, fxTouched: existing.fx != null,
      desc: existing.desc || '', tag: existing.tag || '',
      toAmount: existing.toAmount != null ? numText(existing.toAmount) : '',
    });
    s.alloc = allocToState(existing.alloc);
    s.allocTouched = true;
    s.accTouched = true;
  } else if (rest.alloc !== undefined) {
    s.alloc = allocToState(rest.alloc);   // duplicar o pendiente: conserva el reparto
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
  function setAccount(id) {
    s.accountId = id || null;
    s.accTouched = true;
    if (acc()) { s.currency = acc().currency; s.fxTouched = false; }
  }

  // Monto que llega en una transferencia entre monedas, según el tipo de cambio del día.
  const convert = (amt, from, to) => {
    const rf = M.rateFor(from, s.date), rt = M.rateFor(to, s.date);
    return Number.isFinite(amt) && rf != null && rt ? amt * rf / rt : null;
  };
  let toAmtInput = null;
  const toAmtHint = () => {
    const to = M.account(s.toAccountId);
    const v = to ? convert(M.evalAmount(s.amount), s.currency, to.currency) : null;
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

  // ---- campos que se crean una sola vez (recrearlos cerraría el teclado o el selector de fecha en iOS)
  const kindSel = h('select', { class: 'kind-pill', 'aria-label': 'Tipo de movimiento' },
    KINDS.filter(([v]) => v !== 'settle' || people.length > 1).map(([v, l]) => h('option', { value: v, selected: v === s.kind }, l)));
  kindSel.addEventListener('change', () => setKind(kindSel.value));

  const listId = 'sug-' + (++formSeq);
  const descIn = h('input', {
    class: 'desc-input', type: 'text', value: s.desc, placeholder: '¿En qué? Ej: Jumbo', autocapitalize: 'sentences', autocomplete: 'off',
    enterkeyhint: 'next', 'aria-label': 'Descripción', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  const suggestBox = h('div', { class: 'suggest', role: 'listbox', id: listId, hidden: true });
  let suggestions = [], activeSug = -1;

  const amountIn = h('input', { class: 'amount', type: 'text', inputmode: 'decimal', placeholder: '0', value: groupDigits(s.amount), autocomplete: 'off', 'aria-label': 'Monto' });
  const evalHint = h('span', { class: 'amount-eval', 'aria-live': 'polite' });
  const lastAmtBox = h('span');
  const dateIn = h('input', { type: 'date', value: s.date, 'aria-label': 'Fecha' });
  const tagIn = h('input', { type: 'text', placeholder: 'Ej: Viaje sur', value: s.tag, list: 'taglist', 'aria-label': 'Etiqueta' });

  // ---- sugerencias por descripción
  const allocLabelOf = (alloc, paidBy) => (alloc === 'shared' ? 'compartido' : alloc && alloc.startsWith('p:') ? `solo de ${M.personName(alloc.slice(2))}` : 'personal');
  async function pastePurchase() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { toast('No se pudo leer el portapapeles'); return; }
    const p = M.parsePurchase(text);
    if (!p) { toast('El portapapeles no tiene una compra (monto y comercio)'); return; }
    s.desc = p.desc; descIn.value = p.desc;
    s.amount = numText(p.amount); amountIn.value = s.amount;
    updateEval(); updateFx();
    descIn.focus();
    updateSuggestions();          // con el comercio aparecen las sugerencias: un toque completa categoría y cuenta
  }

  function updateSuggestions() {
    const isFlow = s.kind === 'out' || s.kind === 'in';
    const q = descIn.value.trim();
    suggestions = [];
    if (isFlow && q.length >= 2) {
      suggestions = M.suggestDescriptions(q, s.kind, 4, me).map(sg => ({ type: 'desc', sg }));
      if (suggestions.length < 4) {
        const have = new Set(suggestions.map(x => x.sg.cat.id));
        for (const c of M.suggestCategories(q, KIND_CATS[s.kind], 4 - suggestions.length)) if (!have.has(c.id)) suggestions.push({ type: 'cat', cat: c });
      }
    }
    activeSug = -1;
    drawSuggestions();
  }
  function drawSuggestions() {
    suggestBox.hidden = !suggestions.length;
    descIn.setAttribute('aria-expanded', String(!!suggestions.length));
    fill(suggestBox, suggestions.map((x, i) => {
      const id = `${listId}-${i}`;
      const opt = x.type === 'desc'
        ? [h('span', { class: 's-icon', 'aria-hidden': 'true' }, x.sg.cat.icon || '•'),
          h('span', { class: 's-main' },
            h('span', { class: 's-title' }, x.sg.last.desc),
            h('span', { class: 's-sub' }, [x.sg.cat.name, allocLabelOf(x.sg.last.alloc), x.sg.last.paidBy !== owner ? `pagó ${M.personName(x.sg.last.paidBy)}` : (M.account(x.sg.last.accountId) || {}).name].filter(Boolean).join(' · '))),
          h('span', { class: 's-amt' }, M.fmt(x.sg.last.amount, x.sg.last.currency))]
        : [h('span', { class: 's-icon', 'aria-hidden': 'true' }, x.cat.icon || '🏷️'),
          h('span', { class: 's-main' }, h('span', { class: 's-title' }, x.cat.name), h('span', { class: 's-sub' }, 'Categoría'))];
      return h('button', {
        type: 'button', id, role: 'option', class: 'suggest-item' + (i === activeSug ? ' active' : ''), 'aria-selected': String(i === activeSug),
        // mousedown en vez de click: así no se pierde el foco del campo antes de elegir
        onmousedown: (e) => e.preventDefault(), onclick: () => applySuggestion(x),
      }, opt);
    }));
    if (activeSug >= 0) descIn.setAttribute('aria-activedescendant', `${listId}-${activeSug}`); else descIn.removeAttribute('aria-activedescendant');
  }
  function hideSuggestions() { suggestions = []; drawSuggestions(); }
  function applySuggestion(x) {
    if (x.type === 'desc') {
      const t = x.sg.last;
      s.desc = t.desc; descIn.value = t.desc;
      s.categoryId = x.sg.cat.id;
      if (t.paidBy && db.get('people', t.paidBy)) setPayer(t.paidBy);
      // desde la cartola de una cuenta, la cuenta ya está elegida
      if (s.paidBy === owner && usable(t.accountId) && !lockAccount) setAccount(t.accountId);
      s.alloc = allocToState(t.alloc); s.allocTouched = true;
      s.lastAmount = { amount: t.amount, currency: t.currency };
    } else {
      // categoría elegida por nombre: lo escrito era para buscarla, no una descripción
      if (M.stripAccents(x.cat.name.toLowerCase()).startsWith(M.stripAccents(descIn.value.trim().toLowerCase()))) { s.desc = ''; descIn.value = ''; }
      s.categoryId = x.cat.id;
      resolveAlloc();
    }
    hideSuggestions();
    render();
    amountIn.focus();
  }
  descIn.addEventListener('input', () => { s.desc = descIn.value; updateSuggestions(); });
  descIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && suggestions.length) { activeSug = (activeSug + 1) % suggestions.length; drawSuggestions(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && suggestions.length) { activeSug = (activeSug - 1 + suggestions.length) % suggestions.length; drawSuggestions(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeSug >= 0) applySuggestion(suggestions[activeSug]); else { hideSuggestions(); amountIn.focus(); } }
    else if (e.key === 'Escape' && suggestions.length) { hideSuggestions(); e.stopPropagation(); }
  });
  descIn.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

  // ---- monto: acepta operaciones ("7.000+6.900") y ofrece el último monto de la sugerencia
  function updateEval() {
    const expr = M.isAmountExpression(s.amount);
    const v = M.evalAmount(s.amount);
    evalHint.textContent = expr ? (Number.isFinite(v) ? `= ${M.fmt(v, s.currency)}` : 'Revisa la operación') : '';
    evalHint.classList.toggle('bad', expr && !Number.isFinite(v));
    fill(lastAmtBox, s.lastAmount && !s.amount ? h('button', {
      type: 'button', class: 'chip small last-amount',
      onclick: () => { s.amount = numText(s.lastAmount.amount); amountIn.value = s.amount; updateEval(); updateFx(); },
    }, `Usar el último: ${M.fmt(s.lastAmount.amount, s.lastAmount.currency)}`) : null);
  }
  amountIn.addEventListener('input', () => { s.amount = amountIn.value; updateEval(); updateFx(); if (toAmtInput) toAmtInput.placeholder = toAmtHint(); });

  let fxAsked = false;
  function updateFx() {
    const box = root.querySelector('.fxline');
    if (!box) return;
    if (s.currency === base || s.kind === 'transfer' && !s.toAccountId) { fill(box); return; }
    const auto = M.rateFor(s.currency, s.date);
    const rate = s.fxTouched && s.fx != null ? s.fx : auto;
    // sin consultar hoy: se consulta ahora y la línea se actualiza sola
    if (!FX.fetchedToday() && !fxAsked && navigator.onLine !== false) { fxAsked = true; FX.refreshRates().then(() => { if (!s.fxTouched) updateFx(); }).catch(() => {}); }
    const rec = M.seriesAt(s.currency, s.date);
    const a = M.evalAmount(s.amount);
    const fxIn = h('input', { type: 'text', inputmode: 'decimal', value: rate != null ? numText(rate) : '', placeholder: 'tipo de cambio', 'aria-label': 'Tipo de cambio' });
    fxIn.addEventListener('input', () => { s.fx = M.parseAmount(fxIn.value); s.fxTouched = true; eq.textContent = eqText(); });
    const eqText = () => {
      const r = s.fxTouched ? s.fx : auto;
      const when = !s.fxTouched && rec && rec.date !== s.date ? ` (valor del ${new Date(rec.date + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })})` : '';
      return Number.isFinite(a) && r ? `≈ ${M.fmt(a * r, base)}${when}` : (r == null ? 'Sin tipo de cambio guardado: ingrésalo' : '');
    };
    const eq = h('span', { class: 'muted' }, eqText());
    fill(box, h('label', { class: 'field inline' }, h('span', null, `1 ${s.currency} =`), fxIn, h('span', null, base)), eq);
  }

  // ---- línea resumida (fecha, quién pagó, reparto, etiqueta)
  const dateLabel = () => (s.date === today ? 'Hoy' : s.date === yesterday ? 'Ayer'
    : new Date(s.date + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' }));
  function splitLabel() {
    const cat = M.category(s.categoryId);
    let pct = M.splitFor(s.date.slice(0, 7)).pct;
    if (cat && cat.splitMode === 'equal') pct = Object.fromEntries(people.map(p => [p.id, 1 / people.length]));
    if (cat && cat.splitMode === 'fixed' && cat.fixedPct) pct = cat.fixedPct;
    return 'Compartido ' + people.map(p => Math.round((pct[p.id] || 0) * 100)).join('/');
  }
  const allocLabel = () => (s.alloc === 'shared' ? splitLabel() : `Solo de ${M.personName(s.alloc === 'payer' || !s.alloc ? s.paidBy : s.alloc)}`);
  const sumChips = {};
  function updateSummaryLabels() {
    if (sumChips.date) sumChips.date.lastChild.textContent = dateLabel();
    if (sumChips.alloc) sumChips.alloc.lastChild.textContent = allocLabel();
  }
  dateIn.addEventListener('change', () => {
    s.date = dateIn.value || today;
    s.fxTouched = false;
    updateFx(); updateSummaryLabels();
    if (toAmtInput) toAmtInput.placeholder = toAmtHint();
  });
  tagIn.addEventListener('input', () => { s.tag = tagIn.value; if (sumChips.tag) sumChips.tag.lastChild.textContent = s.tag ? '#' + s.tag : 'Etiqueta'; });

  function setKind(v) {
    const prevKind = s.kind;
    s.kind = v;
    kindSel.value = v;
    if (v === 'settle') {
      s.to = s.to || (people.find(p => p.id !== s.paidBy) || {}).id;
      if (!s.settleMonth) { const d = s.date; s.settleMonth = Number(d.slice(8)) <= 10 ? M.addMonths(d.slice(0, 7), -1) : d.slice(0, 7); }
    }
    // las transferencias son entre cuentas del dueño
    if (v === 'transfer') { s.categoryId = null; s.paidBy = owner; if (!s.accountId) s.accountId = defaultAccount('out'); }
    // la cuenta sugerida cambia con el tipo, salvo que la hayas elegido a mano
    if (!s.accTouched && (v === 'settle') !== (prevKind === 'settle')) s.accountId = ownerInvolved() ? defaultAccount(v) : null;
    if (acc()) { s.currency = acc().currency; s.fxTouched = false; }
    s.allocTouched = isEdit && s.allocTouched; resolveAlloc();
    hideSuggestions();
    render();
  }

  const accLabel = (a) => `${a.name} (${a.currency})${a.archived ? ' · archivada' : ''}`;
  // selector clásico (transferencias y pagos entre ustedes)
  const selAcc = (key, noneLabel) => {
    const opts = [...((noneLabel || !s[key]) ? [{ v: '', l: noneLabel || '— elige una cuenta —' }] : []), ...accounts.map(a => ({ v: a.id, l: accLabel(a) }))];
    const el = h('select', { 'aria-label': key === 'toAccountId' ? 'Cuenta de destino' : 'Cuenta' }, opts.map(o => h('option', { value: o.v, selected: o.v === (s[key] || '') }, o.l)));
    el.addEventListener('change', () => {
      if (key === 'accountId') setAccount(el.value); else { s[key] = el.value || null; s.accTouched = true; }
      render();
    });
    return el;
  };

  function render() {
    const cat = M.category(s.categoryId);
    const isFlow = s.kind === 'out' || s.kind === 'in';
    const parts = [];
    parts.push(h('div', { class: 'form-top' }, kindSel,
      // compra copiada por el atajo de Apple Pay (Más › Registrar desde Apple Pay)
      isFlow && !isEdit && navigator.clipboard && navigator.clipboard.readText ? h('button', { type: 'button', class: 'chip small paste-btn', onclick: pastePurchase }, '📋 Pegar compra') : null));
    if (isFlow) parts.push(h('div', { class: 'desc-wrap' }, descIn, suggestBox));
    parts.push(h('div', { class: 'amount-row' }, amountIn, h('select', {
      class: 'cur', disabled: !!s.accountId, 'aria-label': 'Moneda', title: s.accountId ? 'La moneda la define la cuenta' : '',
      onchange: (e) => { s.currency = e.target.value; s.fxTouched = false; updateFx(); updateEval(); },
    }, M.settings().currencies.map(c => h('option', { value: c.code, selected: c.code === s.currency }, c.code)))));
    parts.push(h('div', { class: 'amount-help' }, evalHint, lastAmtBox));
    parts.push(h('div', { class: 'fxline' }));

    if (isFlow) {
      // categorías: una sola fila con las más usadas, más "Todas…"
      const kindCats = KIND_CATS[s.kind] || [];
      const chipCats = recentCategoryIds(s.kind).map(id => M.category(id)).filter(c => c && !c.archived && kindCats.includes(c.kind)).slice(0, 10);
      // la elegida va primero para que se vea sin desplazar la fila
      if (cat) { const i = chipCats.findIndex(c => c.id === cat.id); if (i >= 0) chipCats.splice(i, 1); chipCats.unshift(cat); }
      parts.push(h('div', { class: 'field' }, h('span', null, 'Categoría'),
        h('div', { class: 'chips scroll cat-chips' },
          chipCats.map(c => h('button', { type: 'button', class: 'chip' + (c.id === s.categoryId ? ' on' : ''), 'aria-pressed': String(c.id === s.categoryId), onclick: () => { s.categoryId = c.id; resolveAlloc(); render(); } }, (c.icon ? c.icon + ' ' : '') + c.name)),
          h('button', { type: 'button', class: 'chip more', onclick: () => categoryPicker(s.kind, s.categoryId, (id) => { s.categoryId = id; resolveAlloc(); render(); }) }, 'Todas…'))));

      // cuenta: botones de las 2 más usadas, la actual, "sin cuenta" si pagó otra persona, y "Otra…"
      const accIds = [...topAccounts];
      if (s.accountId && !accIds.includes(s.accountId)) accIds.unshift(s.accountId);
      const other = h('select', { class: 'chip-select', 'aria-label': 'Otra cuenta', onchange: (e) => { if (e.target.value) { setAccount(e.target.value); render(); } } },
        h('option', { value: '' }, 'Otra…'), accounts.map(a => h('option', { value: a.id }, accLabel(a))));
      parts.push(h('div', { class: 'field acc-field', 'data-value': s.accountId || '' },
        h('span', null, s.kind === 'in' ? 'Cuenta de destino' : 'Cuenta'),
        h('div', { class: 'chips' },
          s.paidBy !== owner ? h('button', { type: 'button', class: 'chip' + (!s.accountId ? ' on' : ''), 'aria-pressed': String(!s.accountId), onclick: () => { setAccount(null); render(); } },
            `Sin cuenta (${s.kind === 'in' ? 'recibió' : 'pagó'} ${M.personName(s.paidBy)})`) : null,
          accIds.map(id => { const a = M.account(id); return a && h('button', { type: 'button', class: 'chip acc-chip' + (id === s.accountId ? ' on' : ''), 'aria-pressed': String(id === s.accountId), 'data-acc': id, onclick: () => { setAccount(id); render(); } }, a.name + (a.currency !== base ? ` (${a.currency})` : '') + (a.archived ? ' · archivada' : '')); }),
          other)));

      // línea resumida
      const sum = (k, icon, label) => (sumChips[k] = h('button', {
        type: 'button', class: 'sum-chip' + (s.open === k ? ' on' : ''), 'aria-expanded': String(s.open === k), 'data-k': k,
        onclick: () => { s.open = s.open === k ? null : k; render(); },
      }, h('span', { 'aria-hidden': 'true' }, icon), h('span', null, label)));
      const many = people.length > 1;
      parts.push(h('div', { class: 'summary' },
        sum('date', '📅', dateLabel()),
        many ? sum('payer', '👤', `${s.kind === 'in' ? 'Recibió' : 'Pagó'} ${M.personName(s.paidBy)}`) : null,
        many ? sum('alloc', '👥', allocLabel()) : null,
        sum('tag', '#', s.tag ? '#' + s.tag : 'Etiqueta')));
      if (s.open === 'date') {
        parts.push(h('div', { class: 'sum-editor' },
          h('div', { class: 'chips' },
            h('button', { type: 'button', class: 'chip' + (s.date === today ? ' on' : ''), onclick: () => { s.date = today; dateIn.value = today; s.fxTouched = false; render(); } }, 'Hoy'),
            h('button', { type: 'button', class: 'chip' + (s.date === yesterday ? ' on' : ''), onclick: () => { s.date = yesterday; dateIn.value = yesterday; s.fxTouched = false; render(); } }, 'Ayer'),
            dateIn)));
      } else if (s.open === 'payer' && many) {
        parts.push(h('div', { class: 'sum-editor' }, seg(people.map(p => ({ v: p.id, l: p.name })), s.paidBy, (v) => { setPayer(v); resolveAlloc(); render(); }, s.kind === 'in' ? 'Lo recibió' : 'Lo pagó')));
      } else if (s.open === 'alloc' && many) {
        const shown = s.alloc === 'payer' ? s.paidBy : s.alloc;
        const catMode = cat && cat.splitMode === 'fixed' ? 'regla fija de la categoría' : cat && cat.splitMode === 'equal' ? 'partes iguales' : 'según sueldos';
        parts.push(h('div', { class: 'sum-editor' },
          seg([{ v: 'shared', l: 'Compartido' }, ...people.map(p => ({ v: p.id, l: `Solo de ${p.name}` }))], shown, (v) => { s.alloc = v; s.allocTouched = true; render(); }, 'Reparto'),
          s.alloc === 'shared' ? h('small', { class: 'muted' }, `${splitLabel().replace('Compartido ', '')} (${catMode})`) : null));
      } else if (s.open === 'tag') {
        parts.push(h('div', { class: 'sum-editor' }, tagIn));
      }
    } else {
      // transferencias y pagos entre ustedes: formato clásico
      if (s.kind === 'transfer') {
        parts.push(h('label', { class: 'field' }, h('span', null, 'Desde'), selAcc('accountId')));
        parts.push(h('label', { class: 'field' }, h('span', null, 'Hacia'), selAcc('toAccountId')));
        const to = M.account(s.toAccountId);
        toAmtInput = null;
        if (to && to.currency !== s.currency) {
          const ta = h('input', { type: 'text', inputmode: 'decimal', value: groupDigits(s.toAmount), placeholder: toAmtHint() });
          ta.addEventListener('input', () => { s.toAmount = ta.value; });
          toAmtInput = ta;
          parts.push(h('label', { class: 'field' }, h('span', null, `Monto recibido (${to.currency})`), ta,
            h('small', null, 'Si lo dejas vacío se calcula con el tipo de cambio del día.')));
        }
      } else {
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
      parts.push(h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', null, 'Fecha'), dateIn), h('label', { class: 'field' }, h('span', null, 'Descripción'), descIn)));
    }
    parts.push(h('datalist', { id: 'taglist' }, [...new Set(db.all('tx').map(t => t.tag).filter(Boolean))].map(t => h('option', { value: t }))));
    fill(root, ...parts);
    updateFx();
    updateEval();
  }

  // evita guardar dos veces con un doble toque mientras se escribe en IndexedDB
  let saving = false;
  async function save(again) {
    if (saving) return;
    saving = true;
    try { await doSave(again); } finally { saving = false; }
  }

  async function doSave(again) {
    const amount = M.evalAmount(s.amount);
    if (!Number.isFinite(amount) || amount === 0) { toast(M.isAmountExpression(s.amount) ? 'Revisa la operación del monto' : 'Ingresa un monto'); amountIn.focus(); return; }
    const isFlow = s.kind === 'out' || s.kind === 'in';
    if (isFlow && !s.categoryId) { toast('Elige una categoría'); return; }
    if (s.kind === 'transfer' && (!s.accountId || !s.toAccountId || s.accountId === s.toAccountId)) { toast('Elige dos cuentas distintas'); return; }
    if (s.kind === 'settle' && (!s.to || s.to === s.paidBy)) { toast('Elige quién paga y quién recibe'); return; }
    if (s.accountId && acc() && acc().currency !== s.currency) s.currency = acc().currency;   // nunca un monto en otra moneda que su cuenta

    const tx = {
      ...(isEdit ? existing : {}),
      date: s.date, kind: s.kind, amount: Math.abs(amount), currency: s.currency,
      accountId: s.accountId || null, desc: (s.desc || '').trim(), tag: (s.tag || '').trim() || undefined, paidBy: s.paidBy,
    };
    if (!isEdit) tx.id = db.uid();
    delete tx.fx; delete tx.fxPending;
    if (s.currency !== M.base()) {
      if (s.fxTouched && s.fx) tx.fx = s.fx;
      else {
        // el tipo de cambio del día: si no se ha consultado hoy y hay conexión, se consulta antes de guardar
        await FX.ensureFresh(s.currency);
        Object.assign(tx, FX.fxFields(s.currency, s.date));
      }
    }
    if (isFlow) {
      tx.categoryId = s.categoryId;
      tx.alloc = s.alloc === 'shared' ? 'shared' : (s.alloc === 'payer' || !s.alloc || s.alloc === s.paidBy ? 'none' : 'p:' + s.alloc);
      if (s.accountId && s.paidBy === owner) { try { localStorage.setItem(LAST_ACC, s.accountId); } catch { /* ignore */ } }
      delete tx.to; delete tx.toAccountId; delete tx.toAmount; delete tx.settleMonth;
    } else if (s.kind === 'transfer') {
      tx.toAccountId = s.toAccountId; delete tx.categoryId; delete tx.alloc; delete tx.to; delete tx.settleMonth;
      const toCur = M.account(s.toAccountId).currency;
      let ta = M.parseAmount(s.toAmount);
      if (toCur !== s.currency && !Number.isFinite(ta)) {
        await FX.ensureFresh(toCur !== M.base() ? toCur : s.currency);
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
      // otro del mismo ticket: se conservan categoría, cuenta, fecha, pagador y reparto
      s.amount = ''; s.desc = ''; s.lastAmount = null; amountIn.value = ''; descIn.value = ''; s.fxTouched = false; s.open = null;
      render();
      ((s.kind === 'out' || s.kind === 'in') ? descIn : amountIn).focus();
    } else m.close();
  }

  const dup = isEdit ? h('button', { class: 'btn ghost', onclick: () => {
    m.close();
    const { id, createdAt, updatedAt, ref, ...rest2 } = existing;
    openTxForm(null, { ...rest2, date: M.todayStr(), amount: numText(rest2.amount), toAmount: rest2.toAmount != null ? numText(rest2.toAmount) : '', alloc: rest2.alloc ?? 'none' });
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
  // foco dentro del mismo toque que abrió el formulario: así iOS muestra el teclado.
  // Gastos e ingresos parten por la descripción (la llevan 8 de cada 10 movimientos).
  if (!isEdit) ((focusTarget === 'amount' || !(s.kind === 'out' || s.kind === 'in')) ? amountIn : descIn).focus();
  return m;
}
