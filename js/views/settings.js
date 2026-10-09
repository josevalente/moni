// "Más": configuración personalizable (categorías, cuentas, personas, monedas, reparto) y respaldo.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, modal, toast, formModal, confirmDialog, promptDialog, parseNum, shareFile, numText } from '../ui.js';
import { openSplitEditor } from './close.js';
import { categoryPicker } from './add.js';
import { renderInvest } from './invest.js';
import { renderPoints } from './points.js';
import { renderProperties } from './properties.js';
import { renderDebts } from './debts.js';
import { openAccount } from './account.js';

const KINDS = [
  { v: 'expense', l: 'Gasto' }, { v: 'income', l: 'Ingreso' }, { v: 'loan', l: 'Préstamo (no es gasto)' },
  { v: 'invest', l: 'Inversión (no es gasto)' }, { v: 'adjust', l: 'Ajuste (no es gasto)' },
];
const KIND_L = Object.fromEntries(KINDS.map(k => [k.v, k.l.split(' (')[0]]));
const ACC_TYPES = [{ v: 'bank', l: 'Cuenta bancaria' }, { v: 'credit', l: 'Tarjeta / línea de crédito' }, { v: 'cash', l: 'Efectivo' }];
const MODES = [{ v: 'prop', l: 'Proporcional a los sueldos' }, { v: 'equal', l: 'Partes iguales' }, { v: 'fixed', l: 'Porcentaje fijo para esta categoría' }];

const back = (to = '#/mas') => h('a', { class: 'backlink', href: to }, '‹ Más');

// ---------------------------------------------------------------- categorías
// inversiones a las que se puede asociar una categoría (las por valor; puntos y millas no)
function invOptions(c) {
  return db.all('investments').filter(i => !M.isPoints(i) && (!i.archived || i.id === (c && c.invId)))
    .sort((a, b) => a.name.localeCompare(b.name)).map(i => ({ v: i.id, l: `${M.isProperty(i) ? '🏠 ' : ''}${i.name} (${i.currency})` }));
}

// Tras asociar una categoría a una inversión: evitar contar dos veces los aportes ya ingresados a mano y
// ofrecer que deje de contar como gasto.
async function afterLink(cat) {
  const inv = db.get('investments', cat.invId);
  const dLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
  const ov = cat.invFrom ? null : M.linkOverlap(cat.id, inv.id);
  if (ov) {
    const from = await new Promise((resolve) => {
      let done = false;
      const pick = (v) => { if (done) return; done = true; m.close(); resolve(v); };
      const m = modal('¿Desde cuándo?', h('div', null,
        h('p', null, `La inversión ${inv.name} ya tiene ${M.fmtInt(ov.manual)} aportes ingresados a mano, hasta el ${dLong(ov.last)}. En ese período la categoría ${cat.name} tiene ${M.fmtInt(ov.overlap)} movimientos: contarlos también duplicaría esos aportes.`),
        h('p', { class: 'muted small' }, `Recomendado: contar los movimientos de la categoría desde el ${dLong(ov.from)}.`)), {
        actions: [
          h('button', { class: 'btn', onclick: () => pick(null) }, 'Todo el historial'),
          h('button', { class: 'btn primary', onclick: () => pick(ov.from) }, `Desde el ${dLong(ov.from)}`),
        ],
        onClose: () => pick(ov.from),
      });
    });
    if (from) await db.put('categories', { ...db.get('categories', cat.id), invFrom: from });
  }
  const n = M.linkedEntries(inv.id).filter(e => e.fromCat === cat.id).length;
  toast(`${cat.name}: ${M.fmtInt(n)} movimientos cuentan como aporte a ${inv.name}`, { ms: 6000 });
  // un aporte a una inversión no es un gasto: se ofrece cambiar su naturaleza (sale de los reportes de gasto)
  if (cat.kind === 'expense' && await confirmDialog(`¿Dejar de contar ${cat.name} como gasto? Sus movimientos saldrán de los reportes de gastos y de "Gastado en el mes" (siguen en las cuentas y en el cierre igual que antes). Puedes volver a cambiarlo en Naturaleza.`, { ok: 'Sí, es inversión', cancel: 'Mantener como gasto', danger: false })) {
    await db.put('categories', { ...db.get('categories', cat.id), kind: 'invest' });
    toast(`${cat.name} ahora es de tipo Inversión`);
  }
}

// Lo que se repite en "Otros" pasa a su propia categoría (o a una que ya existe con ese nombre), con todo su
// historial y su mismo reparto; se puede deshacer.
export async function ownCategory(sg, onDone) {
  const from = M.category(sg.catId);
  const n = M.txsByDescription(sg.catId, sg.key).length;
  const done = async (r, name) => {
    toast(`${M.fmtInt(r.movedIds.length)} movimientos "${sg.label}" ahora en ${name}`, { label: 'Deshacer', onAction: () => M.undoMoveByDescription(r), ms: 8000 });
    if (onDone) onDone(r);
  };
  if (sg.existing) {
    if (!await confirmDialog(`¿Mover los ${M.fmtInt(n)} movimientos "${sg.label}" de ${from.name} a ${sg.existing.name}? Conservan su reparto y quién pagó.`, { ok: 'Mover', danger: false })) return;
    return done(await M.moveByDescription({ fromId: from.id, key: sg.key, toId: sg.existing.id }), sg.existing.name);
  }
  const groups = [...new Set(M.categories().map(x => x.group).filter(Boolean))];
  formModal({
    title: 'Categoría propia', value: { name: sg.label, icon: '', group: from.group || '' }, saveLabel: 'Crear y mover',
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true },
      { key: 'icon', label: 'Ícono (emoji, opcional)', type: 'text' },
      { key: 'group', label: 'Grupo', type: 'text', list: 'grouplist2' },
    ],
    extra: [
      h('p', { class: 'muted small' }, `Se moverán los ${M.fmtInt(n)} movimientos que empiezan con "${sg.label}" desde ${from.name} (todo el historial), con su mismo reparto. Al registrar uno nuevo con esa descripción se sugerirá esta categoría.`),
      h('datalist', { id: 'grouplist2' }, groups.map(g => h('option', { value: g }))),
    ],
    onSave: async (v) => {
      const dup = M.categories().find(c => !c.archived && M.descWords(c.name).join(' ') === M.descWords(v.name).join(' '));
      if (dup) { toast(`Ya existe "${dup.name}"`); return false; }
      await done(await M.moveByDescription({ fromId: from.id, key: sg.key, name: v.name, icon: v.icon, group: v.group }), v.name);
    },
  });
}

// Fila de una sugerencia (en la lista de Inicio y en el detalle de una categoría "Otros").
export function ownCategoryRow(sg, { showFrom = false } = {}) {
  return h('div', { class: 'row static sug-row' },
    h('div', { class: 'main' }, h('div', { class: 'title' }, sg.label),
      h('div', { class: 'sub' }, `${showFrom ? `en ${sg.cat.name} · ` : ''}${M.fmtInt(sg.count)} veces en ${M.fmtInt(sg.months)} meses · ${M.fmt(sg.total, M.base())}`)),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => ownCategory(sg) }, sg.existing ? `Mover a ${sg.existing.name}` : 'Crear categoría'),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `No sugerir más ${sg.label}`, onclick: () => dismissOwnCategory(sg) }, '✕')));
}

// Todas las sugerencias (desde Pendientes); se actualiza al mover o descartar y se cierra si no quedan.
export function reviewOwnCategories() {
  const body = h('div');
  let m = null;
  const draw = () => {
    const list = M.categorySuggestions();
    if (!list.length && m) { m.close(); return; }
    fill(body,
      h('p', { class: 'muted small' }, 'Se repiten en tus categorías "Otros" en el último año. Con su propia categoría los verás aparte en los reportes; se mueve todo su historial y se puede deshacer.'),
      list.map(sg => ownCategoryRow(sg, { showFrom: true })));
  };
  const unsub = db.subscribe(draw);
  draw();
  m = modal('Categorías propias', body, { onClose: unsub });
}

// "No sugerir más" (con deshacer)
export async function dismissOwnCategory(sg) {
  await M.ignoreCategorySuggestion(sg.catId, sg.key);
  toast(`No se volverá a sugerir "${sg.label}"`, { label: 'Deshacer', onAction: () => M.ignoreCategorySuggestion(sg.catId, sg.key, true) });
}

export function editCategory(c) {
  const isNew = !(c && c.id);
  const people = M.people();
  const groups = [...new Set(M.categories().map(x => x.group).filter(Boolean))];
  const val = { kind: 'expense', defaultAlloc: 'none', splitMode: 'prop', ...(c || {}) };
  const fm = formModal({
    title: isNew ? 'Nueva categoría' : 'Editar categoría', value: val,
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true },
      { key: 'icon', label: 'Ícono (emoji, opcional)', type: 'text' },
      { key: 'group', label: 'Grupo', type: 'text', list: 'grouplist', hint: 'Para ordenar la lista (ej: Hogar, Auto, Ocio).' },
      { key: 'kind', label: 'Naturaleza', type: 'select', options: KINDS },
      {
        key: 'defaultAlloc', label: 'Reparto por defecto', type: 'select',
        options: [{ v: 'none', l: 'Solo de quien paga' }, { v: 'shared', l: 'Compartido' }, ...people.map(p => ({ v: 'p:' + p.id, l: `Solo de ${p.name}` }))],
        hint: 'Se puede cambiar en cada movimiento.',
      },
      { key: 'splitMode', label: 'Cómo se reparte lo compartido', type: 'select', options: MODES, show: (v) => v.defaultAlloc === 'shared' || (v.splitMode && v.splitMode !== 'prop') },
      {
        key: 'fixedPct', label: 'Porcentajes fijos', type: 'custom',
        show: (v) => v.splitMode === 'fixed' && (v.defaultAlloc === 'shared' || v.splitMode !== 'prop'),
        build: (v) => {
          const ins = {};
          const el = h('div', { class: 'grid-people' }, people.map(p => {
            const inp = h('input', { type: 'text', inputmode: 'decimal', value: v && v[p.id] != null ? numText(Math.round(v[p.id] * 1000) / 10) : '' });
            ins[p.id] = inp;
            return h('label', { class: 'field' }, h('span', null, `${p.name} (%)`), inp);
          }));
          return { el: h('div', null, h('small', null, 'Ej: 80 / 20. Se normaliza si no suma 100.'), el), get: () => {
            const o = {}; let any = false;
            for (const p of people) { const n = parseNum(ins[p.id].value); if (Number.isFinite(n)) { o[p.id] = n / 100; any = true; } }
            return any ? o : undefined;
          } };
        },
      },
      { key: 'debtId', label: 'Es el dividendo del crédito', type: 'select', show: (v) => v.kind === 'expense', options: [{ v: '', l: '— no —' }, ...db.all('debts').filter(d => d.mortgage).map(d => ({ v: d.id, l: d.name }))],
        hint: 'Del dividendo, la amortización baja la deuda (es ahorro); solo el interés y los seguros cuentan como gasto.' },
      { key: 'extraordinary', label: 'Ingreso extraordinario (herencias, regalos, ventas puntuales)', type: 'check', show: (v) => v.kind === 'income', hint: 'Se muestra aparte de los ingresos recurrentes.' },
      { key: 'invId', label: 'Sumar como aporte a la inversión', type: 'select', options: [{ v: '', l: '— ninguna —' }, ...invOptions(c)],
        hint: 'Cada gasto de esta categoría (pasado y futuro) cuenta como aporte a esa inversión, y cada ingreso como retiro. Ej: la categoría AFP y tu inversión AFP.' },
      { key: 'invFrom', label: 'Contar desde (opcional)', type: 'date', show: (v) => !!v.invId, hint: 'Vacío: todo el historial de la categoría.' },
      { key: 'archived', label: 'Archivada (no aparece al registrar)', type: 'check' },
    ],
    onSave: async (v) => {
      if (v.splitMode !== 'fixed') delete v.fixedPct;
      else if (!v.fixedPct || !Object.values(v.fixedPct).some(x => x > 0)) { toast('Indica los porcentajes fijos'); return false; }
      if (!v.invId) { delete v.invId; delete v.invFrom; } else if (!v.invFrom) delete v.invFrom;
      if (!v.debtId || v.kind !== 'expense') delete v.debtId;
      if (!v.extraordinary || v.kind !== 'income') delete v.extraordinary;
      const saved = await db.put('categories', v);
      if (v.invId && (v.invId !== (c && c.invId) || v.invFrom !== (c && c.invFrom))) await afterLink(saved);
      else toast('Categoría guardada');
    },
    onDelete: !isNew ? async (v) => {
      const used = db.all('tx').some(t => t.categoryId === v.id);
      if (used) { toast('Tiene movimientos: archívala en vez de eliminarla'); return; }
      await db.del('categories', v.id);
    } : null,
    extra: [
      h('datalist', { id: 'grouplist' }, groups.map(g => h('option', { value: g }))),
      // combinar: mueve los movimientos a otra categoría (cada uno conserva su reparto y quién pagó)
      !isNew && !c.mergedInto ? h('div', { class: 'merge-box' },
        h('button', { type: 'button', class: 'btn small', onclick: () => {
          fm.close();
          categoryPicker(null, null, (toId) => confirmMerge(c.id, toId), { kinds: [c.kind], exclude: c.id, title: `Combinar "${c.name}" con…` });
        } }, 'Combinar con otra categoría…'),
        h('small', { class: 'muted' }, 'Útil para categorías repetidas, como "Comida" y "Comida (compartida)": el reparto ya se elige en cada movimiento.')) : null,
    ],
  });
}

// Combina con confirmación y permite deshacer.
export async function confirmMerge(fromId, toId, { rename } = {}) {
  const from = M.category(fromId) && db.get('categories', fromId), to = db.get('categories', toId);
  if (!from || !to) return;
  const n = db.all('tx').filter(t => t.categoryId === fromId).length;
  const ok = await confirmDialog(`Se moverán ${M.fmtInt(n)} movimientos de "${from.name}" a "${to.name}"${rename && rename !== to.name ? ` (que pasará a llamarse "${rename}")` : ''}. Cada movimiento conserva su reparto y quién pagó. "${from.name}" quedará archivada.`, { ok: 'Combinar', danger: false });
  if (!ok) return;
  const undo = await M.mergeCategory(fromId, toId, { rename });
  toast(`Combinadas: ${M.fmtInt(n)} movimientos ahora en "${rename || to.name}"`, { label: 'Deshacer', onAction: () => M.undoMerge(undo), ms: 8000 });
}

// Revisar categorías sin uso en 12 meses y archivar las elegidas (siguen en el historial y los reportes).
function reviewUnused(unused, uses) {
  const checks = new Map();
  const list = h('div', null, unused.map(c => {
    const box = h('input', { type: 'checkbox', checked: true });
    checks.set(c.id, box);
    return h('label', { class: 'field check' }, box, h('span', null, `${c.icon ? c.icon + ' ' : ''}${c.name}`), h('small', null, `${uses.get(c.id) || 0} movimientos en total`));
  }));
  const m = modal('Categorías sin uso en 12 meses', h('div', null,
    h('p', { class: 'muted' }, 'Archivadas dejan de aparecer al registrar, pero sus movimientos siguen en el historial y los reportes. Puedes restaurarlas cuando quieras.'),
    list), {
    actions: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => {
        const ids = unused.filter(c => checks.get(c.id).checked).map(c => c.id);
        if (!ids.length) { m.close(); return; }
        await db.putMany('categories', ids.map(id => ({ ...db.get('categories', id), archived: true })));
        m.close();
        toast(`${ids.length} categorías archivadas`, { label: 'Deshacer', onAction: () => db.putMany('categories', ids.map(id => ({ ...db.get('categories', id), archived: false }))), ms: 8000 });
      } }, 'Archivar seleccionadas'),
    ],
  });
}

function cleanupCard() {
  const { twins, unused, uses } = M.categoryCleanup();
  if (!twins.length && !unused.length) return null;
  return h('section', { class: 'card tidy' },
    h('h3', null, 'Sugerencias para ordenar'),
    twins.map(t => h('div', { class: 'row static' },
      h('div', { class: 'main' },
        h('div', { class: 'title' }, `${t.from.name} → ${t.finalName}`),
        h('div', { class: 'sub' }, `${M.fmtInt(t.count)} movimientos se suman a "${t.to.name}"${t.finalName !== t.to.name ? ', que pasa a llamarse ' + t.finalName : ''}`)),
      h('button', { class: 'btn small', onclick: () => confirmMerge(t.from.id, t.to.id, { rename: t.finalName !== t.to.name ? t.finalName : undefined }) }, 'Combinar'))),
    unused.length ? h('div', { class: 'row static' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${unused.length} categorías sin uso en 12 meses`), h('div', { class: 'sub' }, 'Archivarlas acorta la lista al registrar')),
      h('button', { class: 'btn small', onclick: () => reviewUnused(unused, uses) }, 'Revisar')) : null);
}

function renderCategories(root) {
  const q = h('input', { type: 'search', placeholder: 'Buscar…' });
  const list = h('div');
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const groups = new Map();
    const counts = new Map();
    for (const t of db.all('tx')) if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
    for (const c of M.categories()) {
      if (term && !(c.name.toLowerCase().includes(term) || (c.group || '').toLowerCase().includes(term))) continue;
      const g = c.group || 'Otras';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    fill(list, cleanupCard(), ...[...groups.entries()].map(([g, cs]) => h('section', { class: 'card' }, h('h3', null, g), cs.map(c => h('button', { class: 'row' + (c.archived ? ' dim' : ''), onclick: () => editCategory(c) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${c.icon || ''} ${c.name}`.trim()),
        h('div', { class: 'sub' }, [KIND_L[c.kind], c.defaultAlloc === 'shared' ? (c.splitMode === 'fixed' ? 'compartido (fijo)' : c.splitMode === 'equal' ? 'compartido (50/50)' : 'compartido') : c.defaultAlloc && c.defaultAlloc.startsWith('p:') ? `solo de ${M.personName(c.defaultAlloc.slice(2))}` : null, c.invId ? `aporte a ${(db.get('investments', c.invId) || {}).name || '?'}` : null, c.archived ? (c.mergedInto ? `combinada en ${(M.category(c.id) || {}).name || '?'}` : 'archivada') : null].filter(Boolean).join(' · '))),
      h('div', { class: 'amt muted' }, `${counts.get(c.id) || 0}`))))));
  };
  q.addEventListener('input', draw);
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Categorías'), h('button', { class: 'btn primary small', onclick: () => editCategory(null) }, '＋ Nueva')), q, list);
  draw();
  return draw;
}

// ---------------------------------------------------------------- cuentas
export function editAccount(a) {
  const isNew = !(a && a.id);
  const fm = formModal({
    title: isNew ? 'Nueva cuenta' : 'Editar cuenta', value: a || { type: 'bank', currency: M.base() },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true },
      { key: 'bank', label: 'Banco / institución', type: 'text' },
      { key: 'type', label: 'Tipo', type: 'select', options: ACC_TYPES },
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code })) },
      ...(isNew ? [{ key: '_opening', label: 'Saldo inicial', type: 'number', signed: true, hint: 'Usa ± para un saldo negativo (por ejemplo, la deuda de una tarjeta).' }] : []),
      { key: 'archived', label: 'Archivada (oculta, no suma al patrimonio)', type: 'check' },
    ],
    onSave: async (v) => {
      const opening = v._opening; delete v._opening;
      const saved = await db.put('accounts', v);
      if (isNew && Number.isFinite(opening) && opening) {
        const adj = M.categories().find(c => c.kind === 'adjust');
        await db.put('tx', { date: M.todayStr(), kind: opening > 0 ? 'in' : 'out', amount: Math.abs(opening), currency: v.currency, accountId: saved.id, categoryId: adj ? adj.id : null, alloc: 'none', paidBy: M.ownerId(), desc: 'Saldo inicial' });
      }
      toast('Cuenta guardada');
    },
    onDelete: !isNew ? async (v) => {
      if (db.all('tx').some(t => t.accountId === v.id || t.toAccountId === v.id)) { toast('Tiene movimientos: archívala en vez de eliminarla'); return; }
      await db.del('accounts', v.id);
    } : null,
    extra: !isNew && location.hash !== '#/movs/' + a.id ? h('div', { class: 'merge-box' },
      h('button', { type: 'button', class: 'btn', onclick: () => { fm.close(); openAccount(a.id); } }, 'Ver movimientos y cuadrar con el banco')) : null,
  });
}

function renderAccounts(root) {
  const bal = M.accountBalances();
  const all = db.all('accounts').sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Cuentas'), h('button', { class: 'btn primary small', onclick: () => editAccount(null) }, '＋ Nueva')),
    h('section', { class: 'card' }, all.map(a => h('button', { class: 'row' + (a.archived ? ' dim' : ''), onclick: () => editAccount(a) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, a.name), h('div', { class: 'sub' }, `${ACC_TYPES.find(t => t.v === a.type).l} · ${a.currency}${a.archived ? ' · archivada' : ''}`)),
      h('div', { class: 'amt' }, M.fmt(bal.get(a.id) || 0, a.currency))))));
}

// ---------------------------------------------------------------- personas
function renderPeople(root) {
  const ppl = M.people();
  const me = M.meId();
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Personas'),
    h('button', { class: 'btn primary small', onclick: async () => {
      const n = await promptDialog('Nueva persona', { label: 'Nombre' });
      if (n && n.trim()) await db.put('people', { name: n.trim(), order: ppl.length });
    } }, '＋ Nueva')),
  h('section', { class: 'card' },
    h('p', { class: 'muted' }, 'Las personas participan en el reparto de gastos compartidos. El dueño de las cuentas es quien lleva los saldos bancarios en esta app.'),
    ppl.map(p => h('div', { class: 'row static' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, [p.id === M.ownerId() ? 'dueño de las cuentas' : null, p.id === me ? 'este dispositivo' : null].filter(Boolean).join(' · ') || ' ')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', onclick: async () => { const n = await promptDialog('Renombrar', { label: 'Nombre', value: p.name }); if (n && n.trim()) await db.put('people', { ...p, name: n.trim() }); } }, 'Renombrar'),
        p.id !== me ? h('button', { class: 'btn small', onclick: () => { M.setMeId(p.id); toast(`Este dispositivo ahora registra como ${p.name}`); renderPeople(root); } }, 'Soy yo') : null,
        p.id !== M.ownerId() ? h('button', { class: 'btn small', onclick: async () => {
          // cambia el sentido de los pagos entre ustedes registrados en cuentas: se confirma
          if (await confirmDialog(`Las cuentas pasarán a ser de ${p.name}. Los pagos entre ustedes registrados en una cuenta cambiarán de sentido en los saldos. ¿Continuar?`, { ok: 'Cambiar dueño', danger: false })) {
            await db.put('settings', { ...M.settings(), ownerId: p.id });
          }
        } }, 'Dueño cuentas') : null)))),
  h('section', { class: 'card' }, h('h3', null, '¿Cómo funciona con dos teléfonos?'),
    h('p', { class: 'muted' }, 'Si solo una persona lleva todo, basta con elegir quién pagó en cada movimiento.'),
    h('p', { class: 'muted' }, 'Para que cada uno registre en su teléfono: ', h('strong', null, 'el segundo teléfono debe partir importando un respaldo del primero'),
      ' (no "Empezar desde cero"), así comparten personas, cuentas y categorías. Luego, en ese teléfono elige "Soy yo" en su nombre. Para juntar lo registrado usen Respaldo › Combinar: se mezcla sin duplicar ni perder cambios.')));
}

// ---------------------------------------------------------------- reparto
function renderSplits(root) {
  const ppl = M.people();
  const list = db.all('splits').sort((a, b) => b.ym.localeCompare(a.ym));
  const st = M.settings();
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Reparto mensual'), h('button', { class: 'btn primary small', onclick: () => openSplitEditor(M.curYm()) }, '＋ Cambio')),
    h('section', { class: 'card' },
      h('p', { class: 'muted' }, 'Define cómo se reparte lo compartido. Cada cambio rige desde el mes indicado hacia adelante (los meses cerrados no se alteran). Puede ser por sueldos (se calcula el %) o un porcentaje directo; y cada categoría puede tener su propia regla.'),
      list.length ? list.map(s => {
        const { pct } = (() => { const tmp = M.splitFor(s.ym); return tmp; })();
        return h('button', { class: 'row', onclick: () => openSplitEditor(s.ym) },
          h('div', { class: 'main' }, h('div', { class: 'title' }, `Desde ${M.monthName(s.ym)}`), h('div', { class: 'sub' }, s.mode === 'income' ? 'Según sueldos: ' + ppl.map(p => M.fmt((s.incomes || {})[p.id] || 0, M.base())).join(' / ') : 'Porcentaje directo')),
          h('div', { class: 'amt' }, ppl.map(p => `${Math.round((pct[p.id] || 0) * 100)}%`).join(' / ')));
      }) : h('p', { class: 'empty' }, 'Sin reparto definido: se usa partes iguales.')),
    h('section', { class: 'card' }, h('h3', null, 'Inicio del cuadre'),
      h('p', { class: 'muted' }, 'El saldo entre ustedes se acumula desde este mes. Antes de esa fecha se asume que todo quedó saldado.'),
      h('div', { class: 'row static' }, h('div', { class: 'main' }, h('div', { class: 'title' }, st.settleStart ? M.monthName(st.settleStart) : 'Sin definir')),
        h('button', { class: 'btn small', onclick: async () => {
          const v = await promptDialog('Inicio del cuadre', { label: 'Mes (AAAA-MM)', value: st.settleStart || M.curYm(), hint: 'Ej: 2026-08' });
          if (v && /^\d{4}-\d{2}$/.test(v.trim())) await db.put('settings', { ...M.settings(), settleStart: v.trim() });
        } }, 'Cambiar'))));
}

// ---------------------------------------------------------------- monedas
function renderCurrencies(root) {
  const st = M.settings();
  const latest = (cur) => M.seriesAt(cur, M.todayStr());   // el de hoy (la UF se publica por adelantado)
  const at = FX.lastFetchAt();
  const pending = db.all('tx').filter(t => t.fxPending).length;
  const dShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Monedas y tipo de cambio'),
    h('button', { class: 'btn primary small', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Actualizando…';
      const r = await FX.refreshRates({ force: true });
      const usd = M.seriesAt('USD', M.todayStr());
      toast(r.ok ? `Tipos de cambio al día${usd ? `: dólar ${M.fmt(usd.rate, st.baseCurrency)} (${dShort(usd.date)})` : ''}${r.failed ? '. Algunas monedas no respondieron.' : ''}`
        : (r.reason === 'offline' ? 'Sin conexión: se usa el último valor guardado' : 'mindicador.cl no respondió. Se usa el último valor guardado; inténtalo más tarde.'), { ms: 6000 });
      renderCurrencies(root);
    } }, 'Actualizar ahora')),
  h('section', { class: 'card' },
    h('p', { class: 'muted' }, `Moneda base: ${st.baseCurrency}. Cada movimiento guarda el tipo de cambio del día en que se registró, así el pasado no se mueve cuando cambia el dólar. Fuente: mindicador.cl, se consulta al abrir la app y antes de guardar algo en otra moneda.`),
    h('p', { class: 'small' }, at ? `Última consulta: ${new Date(at).toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Aún no se consulta desde este teléfono.',
      pending ? ` · ${pending} movimiento${pending === 1 ? '' : 's'} esperando el tipo de cambio de su fecha (se completan solos al consultar).` : ''),
    st.currencies.map(c => { const r = latest(c.code); return h('div', { class: 'row static' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${c.code} · ${c.symbol}`), h('div', { class: 'sub' }, c.code === st.baseCurrency ? 'moneda base' : (c.convertible === false ? 'sin conversión (ej: millas)' : r ? `1 ${c.code} = ${M.fmt(r.rate, st.baseCurrency)} · valor del ${dShort(r.date)}${r.manual ? ' · manual' : ''}` : 'sin tipo de cambio'))),
      c.code !== st.baseCurrency && c.convertible !== false ? h('button', { class: 'btn small', onclick: async () => {
        const v = await promptDialog(`Tipo de cambio ${c.code}`, { label: `1 ${c.code} en ${st.baseCurrency} (hoy)`, type: 'number', value: r ? numText(r.rate) : '' });
        const n = parseNum(v); if (v != null && Number.isFinite(n) && n > 0) { await FX.setManualRate(c.code, M.todayStr(), n); renderCurrencies(root); }
      } }, 'Manual') : null); }),
    h('button', { class: 'btn', onclick: () => formModal({
      title: 'Nueva moneda', value: { decimals: 2, convertible: true },
      fields: [{ key: 'code', label: 'Código (ej: GBP)', type: 'text', required: true }, { key: 'symbol', label: 'Símbolo', type: 'text', required: true }, { key: 'decimals', label: 'Decimales', type: 'number' }, { key: 'convertible', label: 'Se convierte a la moneda base', type: 'check' }],
      onSave: async (v) => { v.code = v.code.toUpperCase(); if (st.currencies.some(c => c.code === v.code)) { toast('Ya existe'); return false; } await db.put('settings', { ...st, currencies: [...st.currencies, { code: v.code, symbol: v.symbol, decimals: v.decimals ?? 2, convertible: !!v.convertible }] }); renderCurrencies(root); },
    }) }, '＋ Agregar moneda')));
}

// ---------------------------------------------------------------- respaldo
const fileInput = (accept, onFile) => {
  const i = h('input', { type: 'file', accept, style: { display: 'none' } });
  i.addEventListener('change', async () => { if (i.files[0]) await onFile(i.files[0]); i.value = ''; });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
};

// CSV con ";" y coma decimal: así Excel en español lo abre separado en columnas.
export function exportCsv() {
  const q = (v) => {
    v = v == null ? '' : (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6).replace('.', ',') : String(v));
    return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const KIND = { out: 'gasto', in: 'ingreso', transfer: 'transferencia', settle: 'pago entre ustedes' };
  const alloc = (t) => (t.alloc === 'shared' ? 'compartido' : t.alloc && t.alloc.startsWith('p:') ? `solo de ${M.personName(t.alloc.slice(2))}` : t.kind === 'out' || t.kind === 'in' ? 'de quien pagó' : '');
  const rows = [['fecha', 'tipo', 'monto', 'moneda', `monto_${M.base().toLowerCase()}`, 'categoria', 'cuenta', 'cuenta_destino', 'monto_destino', 'pagado_por', 'recibe', 'reparto', 'cierre', 'descripcion', 'etiqueta']];
  for (const t of M.sortTx(db.all('tx'))) {
    rows.push([t.date, KIND[t.kind] || t.kind, t.amount, t.currency, M.txBase(t), (M.category(t.categoryId) || {}).name, (M.account(t.accountId) || {}).name,
      (M.account(t.toAccountId) || {}).name, t.toAmount, M.personName(t.paidBy), t.to ? M.personName(t.to) : '', alloc(t), t.kind === 'settle' ? M.settleMonthOf(t) : '', t.desc, t.tag]);
  }
  return rows.map(r => r.map(q).join(';')).join('\n');
}

// Exporta el respaldo (hoja de compartir en el iPhone). Solo cuenta como respaldo si no se canceló.
export async function exportBackup() {
  const json = JSON.stringify(db.exportAll());
  if (await shareFile(`moni-respaldo-${new Date().toISOString().slice(0, 10)}.json`, json)) {
    try { localStorage.setItem('moni.lastBackup', new Date().toISOString()); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function renderBackup(root) {
  const last = (() => { try { return localStorage.getItem('moni.lastBackup'); } catch { return null; } })();
  const stamp = () => new Date().toISOString().slice(0, 10);
  const doExport = async () => { await exportBackup(); renderBackup(root); };
  // iOS puede borrar datos de sitios web si falta espacio, salvo que el almacenamiento sea persistente
  const storageLine = h('p', { class: 'muted small' }, 'Revisando almacenamiento…');
  const persistBtn = h('button', { class: 'btn small', hidden: true, onclick: async () => {
    const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
    toast(ok ? 'Almacenamiento persistente activado' : 'El sistema no lo permitió; mantén tus respaldos al día');
    renderBackup(root);
  } }, 'Pedir almacenamiento persistente');
  (async () => {
    try {
      const st = navigator.storage;
      const p = st && st.persisted ? await st.persisted() : null;
      const e = st && st.estimate ? await st.estimate() : null;
      storageLine.textContent = (p === true ? 'Almacenamiento persistente: sí ✓' : p === false ? 'Almacenamiento persistente: no — el sistema podría borrar los datos si falta espacio' : 'Almacenamiento persistente: no se puede saber en este navegador')
        + (e && e.usage ? ` · en uso ${(e.usage / 1048576).toFixed(1)} MB` : '');
      persistBtn.hidden = p !== false;
    } catch { storageLine.textContent = ''; }
  })();
  const doImport = (mode) => fileInput('.json,application/json', async (f) => {
    let payload;
    try { payload = JSON.parse(await f.text()); } catch { toast('El archivo no es un JSON válido'); return; }
    if (mode === 'replace' && !(await confirmDialog('Esto reemplaza TODOS los datos de este dispositivo por los del archivo. ¿Continuar?', { ok: 'Reemplazar' }))) return;
    try {
      const s = await db.importAll(payload, mode);
      toast(mode === 'replace' ? 'Datos cargados' : `Combinado: ${s.added} nuevos, ${s.updated} actualizados`);
      if (mode === 'replace') location.hash = '#/';
    } catch (e) {
      // el mensaje es largo y la decisión importa: se muestra en una ventana, no en un aviso fugaz
      const m = modal('No se importó nada', h('p', null, e.message || 'No se pudo importar el archivo.'), {
        actions: [
          h('button', { class: 'btn', onclick: () => m.close() }, 'Entendido'),
          e.code === 'FOREIGN' ? h('button', { class: 'btn danger', onclick: async () => {
            m.close();
            if (await confirmDialog('Se reemplazarán TODOS los datos de este teléfono por los del archivo. ¿Continuar?', { ok: 'Reemplazar' })) {
              await db.importAll(payload, 'replace'); toast('Datos cargados'); location.hash = '#/';
            }
          } }, 'Reemplazar todo con este archivo') : null,
        ],
      });
    }
  });
  const counts = { 'Movimientos': db.count('tx'), 'Categorías': db.count('categories'), 'Cuentas': db.count('accounts'), 'Inversiones': db.count('investments') };
  fill(root, back(), h('h2', null, 'Respaldo y datos'),
    h('section', { class: 'card' },
      h('p', null, 'Tus datos viven solo en este dispositivo. ', h('strong', null, 'Haz un respaldo seguido'), ' y guárdalo en Archivos / iCloud Drive.'),
      h('p', { class: 'muted' }, last ? `Último respaldo: ${new Date(last).toLocaleString('es-CL')}` : 'Aún no has hecho un respaldo.'),
      storageLine, persistBtn,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: doExport }, 'Exportar respaldo (JSON)'), h('button', { class: 'btn', onclick: () => shareFile(`moni-movimientos-${stamp()}.csv`, '﻿' + exportCsv(), 'text/csv') }, 'Exportar movimientos (CSV)'))),
    h('section', { class: 'card' }, h('h3', null, 'Importar'),
      h('p', { class: 'muted' }, 'Combinar mezcla un archivo con tus datos actuales: por cada registro gana el cambio más reciente. Sirve para juntar lo que registran dos personas en teléfonos distintos.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => doImport('merge') }, 'Combinar con archivo…'), h('button', { class: 'btn danger', onclick: () => doImport('replace') }, 'Reemplazar todo…'))),
    h('section', { class: 'card' }, h('h3', null, 'En este dispositivo'),
      Object.entries(counts).map(([k, v]) => h('div', { class: 'row static' }, h('div', { class: 'main' }, h('div', { class: 'title' }, k)), h('div', { class: 'amt' }, M.fmtInt(v)))),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger ghost', onclick: async () => {
        if (await confirmDialog('Se borrarán todos los datos de este dispositivo. Haz un respaldo antes. ¿Continuar?', { ok: 'Borrar todo' })) {
          await db.wipe();
          // también las preferencias de este teléfono. Se vuelve a la bienvenida (importar un respaldo o empezar
          // de cero) en vez de crear personas nuevas que después se duplicarían al combinar
          for (const k of ['moni.fxLast', 'moni.lastBackup', 'moni.lastAccount', 'moni.me', 'moni.recon', 'moni.tdKey', 'moni.pxLastAt', 'moni.fxLastAt', 'moni.fcAlertHidden']) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
          location.hash = '#/'; toast('Datos borrados');
        }
      } }, 'Borrar todos los datos'))));
}

// ---------------------------------------------------------------- Apple Pay
// Una app web no recibe datos de los atajos del iPhone directamente: el atajo copia la compra al
// portapapeles y en Moni se pega con "📋 Pegar compra" (una sola vez por compra).
function applePayHelp() {
  modal('Registrar desde Apple Pay', h('div', null,
    h('p', null, 'Con un atajo del iPhone, cada vez que pagas con Apple Pay la compra (monto y comercio) queda copiada. Luego, en Moni tocas ＋ y "📋 Pegar compra": se completa el monto y el comercio, y las sugerencias ponen la categoría y la cuenta.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Abre la app Atajos › Automatización › Nueva automatización › Transacción.'),
      h('li', null, 'Elige tus tarjetas (Banco de Chile, Santander y otras de la lista de Apple Pay) y "Ejecutar inmediatamente".'),
      h('li', null, 'Agrega la acción "Texto" y escribe: MONI|', h('i', null, 'Monto'), '|', h('i', null, 'Comercio'), ' (toca para insertar las variables "Monto" y "Comercio" de la entrada del atajo).'),
      h('li', null, 'Agrega "Copiar al portapapeles". Opcional: "Mostrar notificación" con "Compra copiada para Moni".'),
      h('li', null, 'Al pagar, abre Moni › ＋ › 📋 Pegar compra.')),
    h('p', { class: 'muted small' }, 'Solo funciona con tarjetas en Apple Pay (Mercado Pago y BancoEstado no están). Si el monto llega en 0, revisa que la automatización tenga datos móviles y que el atajo use la variable "Monto". El portapapeles nunca sale de tu teléfono.')));
}

// ---------------------------------------------------------------- menú
export function renderMore(root, sub) {
  const subs = { categorias: renderCategories, cuentas: renderAccounts, personas: renderPeople, reparto: renderSplits, monedas: renderCurrencies, respaldo: renderBackup };
  if (sub === 'inversiones') { fill(root); const inner = h('div'); root.append(back(), h('h2', null, 'Inversiones'), inner); renderInvest(inner); return () => renderInvest(inner); }
  if (sub === 'propiedades') { fill(root); const inner = h('div'); root.append(back(), h('h2', null, 'Propiedades'), inner); renderProperties(inner); return () => renderProperties(inner); }
  if (sub === 'puntos') { fill(root); const inner = h('div'); root.append(back(), h('h2', null, 'Puntos y millas'), inner); renderPoints(inner); return () => renderPoints(inner); }
  if (sub === 'deudas') { fill(root); const inner = h('div'); root.append(back(), h('h2', null, 'Deudas'), inner); renderDebts(inner); return () => renderDebts(inner); }
  if (subs[sub]) { const r = subs[sub](root); return typeof r === 'function' ? r : () => subs[sub](root); }
  const item = (to, icon, title, sub2) => h('a', { class: 'row link', href: '#/mas/' + to }, h('div', { class: 'icon' }, icon), h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub2)), h('div', { class: 'chev' }, '›'));
  fill(root, 
    h('section', { class: 'card' },
      item('inversiones', '📈', 'Inversiones', 'Fondos, acciones, ETF, AFP, APV: valor, precios y dividendos'),
      item('propiedades', '🏠', 'Propiedades', 'Valor, crédito hipotecario, plusvalía y arriendo'),
      item('puntos', '🎁', 'Puntos y millas', 'Dólares-Premio, LATAM Pass y otros programas'),
      item('deudas', '🤝', 'Deudas', 'Lo que debes o te deben, en cualquier moneda')),
    h('section', { class: 'card' },
      item('categorias', '🏷️', 'Categorías', 'Tus ítems de gasto: nombre, grupo, reparto'),
      item('cuentas', '🏦', 'Cuentas', 'Bancos, tarjetas y efectivo'),
      item('reparto', '⚖️', 'Reparto mensual', 'Sueldos o % que definen el cobro'),
      item('personas', '👥', 'Personas', 'Quiénes participan y este dispositivo'),
      item('monedas', '💱', 'Monedas y tipo de cambio', 'CLP, USD, EUR, UF…')),
    h('section', { class: 'card' }, item('respaldo', '💾', 'Respaldo y datos', 'Exportar, importar y combinar'),
      h('button', { class: 'row link', onclick: applePayHelp }, h('div', { class: 'icon' }, '⚡'),
        h('div', { class: 'main' }, h('div', { class: 'title' }, 'Registrar desde Apple Pay'), h('div', { class: 'sub' }, 'Un atajo del iPhone copia cada compra; en Moni la pegas')),
        h('div', { class: 'chev' }, '›'))),
    h('p', { class: 'muted center small' }, 'Moni · tus datos se guardan solo en este dispositivo'));
}
