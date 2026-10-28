// Programados: movimientos que se repiten (o uno futuro). Se confirman desde Pendientes el día que
// corresponde; acá se ven todos, se editan o se dejan de repetir.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, modal, toast, formModal, numText } from '../ui.js';
import { openTxForm } from './add.js';

const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
export const occurrenceTitle = (o) => o.s.desc || (M.category(o.s.categoryId) || {}).name || 'Programado';

// el movimiento listo para guardar: con el monto de siempre (o el de la UF de ese día) y su tipo de cambio
function occurrenceTx(o) {
  const tx = M.scheduleTx(o.s, o.ym);
  if (tx.currency !== M.base()) Object.assign(tx, FX.fxFields(tx.currency, tx.date));
  return tx;
}

// Confirmar en un toque (o varios a la vez, con un solo "Deshacer")
export async function registerOccurrences(list) {
  const txs = list.map(occurrenceTx);
  await db.putMany('tx', txs);
  toast(txs.length === 1 ? `${occurrenceTitle(list[0])} registrado: ${M.fmt(txs[0].amount, txs[0].currency)}` : `${txs.length} programados registrados`,
    { label: 'Deshacer', onAction: () => db.delMany('tx', txs.map(t => t.id)), ms: 8000 });
}

// Confirmar ajustando (monto, fecha, cuenta…): el formulario queda listo
export function openOccurrence(o) {
  const t = occurrenceTx(o);
  openTxForm(null, {
    kind: t.kind, date: t.date, amount: numText(o.s.uf || t.amount), entryUF: !!o.s.uf, currency: t.currency, accountId: t.accountId, categoryId: t.categoryId,
    desc: t.desc, tag: t.tag || '', paidBy: t.paidBy, alloc: t.alloc, scheduleId: o.s.id, scheduleMonth: o.ym, focus: 'amount',
  });
}

export function skipOccurrenceDialog(o) {
  const m = modal(occurrenceTitle(o), h('p', null, `¿Qué hacemos con "${occurrenceTitle(o)}" del ${fmtDay(o.date)}?`), {
    actions: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn', onclick: () => { m.close(); editSchedule(o.s); } }, 'Editar programado'),
      h('button', { class: 'btn primary', onclick: async () => {
        m.close();
        await M.skipOccurrence(o.s, o.ym);
        toast('Omitido esta vez', { label: 'Deshacer', onAction: () => M.skipOccurrence(o.s, o.ym, true) });
      } }, 'Omitir esta vez'),
    ],
  });
}

export function editSchedule(sc) {
  const ufOk = sc.currency !== 'UF' && M.settings().currencies.some(c => c.code === 'UF');
  const kinds = sc.kind === 'in' ? ['income', 'loan', 'invest', 'adjust', 'expense'] : ['expense', 'loan', 'invest', 'adjust'];
  const cats = M.categories().filter(c => (!c.archived || c.id === sc.categoryId) && kinds.includes(c.kind));
  const accs = M.accounts().filter(a => !a.archived || a.id === sc.accountId);
  const owner = M.ownerId();
  // lo que ya se registró desde este programado
  const done = M.sortTx(db.all('tx').filter(t => t.scheduleId === sc.id)).slice(0, 6);
  formModal({
    title: sc.kind === 'in' ? 'Ingreso programado' : 'Gasto programado',
    value: { ...sc, end: sc.end || '', every: String(sc.every), accountId: sc.accountId || '', tag: sc.tag || '',
      mode: sc.nth ? 'week' : 'day', nthN: String((sc.nth || M.nthOfDate(M.scheduleDate(sc, sc.start))).n), nthWd: String((sc.nth || M.nthOfDate(M.scheduleDate(sc, sc.start))).wd) },
    fields: [
      { key: 'desc', label: 'Descripción', type: 'text' },
      { key: 'categoryId', label: 'Categoría', type: 'select', options: cats.map(c => ({ v: c.id, l: (c.icon ? c.icon + ' ' : '') + c.name })) },
      ...(sc.paidBy === owner || !sc.paidBy ? [{ key: 'accountId', label: 'Cuenta', type: 'select', options: [...accs.map(a => ({ v: a.id, l: `${a.name} (${a.currency})` })), { v: '', l: 'Sin cuenta' }] }] : []),
      { key: 'tag', label: 'Etiqueta (opcional)', type: 'text' },
      ...(ufOk ? [{ key: 'uf', label: 'Monto fijo en UF (opcional)', type: 'number', calc: true, hint: 'Acepta operaciones, ej. 8,5 × 1,19. Cada vez se registra con la UF de ese día. Vacío: monto fijo en pesos.' }] : []),
      { key: 'amount', label: `Monto (${sc.currency})`, type: 'number', calc: true, required: true, show: (v) => !v.uf },
      { key: 'mode', label: 'Qué día', type: 'select', options: [{ v: 'day', l: 'Un día del mes' }, { v: 'week', l: 'Un día de la semana (ej. primer lunes)' }] },
      { key: 'day', label: 'Día del mes', type: 'number', required: true, show: (v) => v.mode !== 'week', hint: 'Con 31, el último día de cada mes.' },
      { key: 'nthN', label: 'Cuál', type: 'select', options: M.NTHS.map(([v, l]) => ({ v: String(v), l })), show: (v) => v.mode === 'week' },
      { key: 'nthWd', label: 'Día de la semana', type: 'select', options: [1, 2, 3, 4, 5, 6, 0].map(v => ({ v: String(v), l: M.WEEKDAYS[v] })), show: (v) => v.mode === 'week' },
      { key: 'every', label: 'Se repite', type: 'select', options: M.EVERY.map(([v, l]) => ({ v: String(v), l })) },
      { key: 'end', label: 'Hasta (AAAA-MM, opcional)', type: 'month' },
    ],
    extra: h('div', null,
      h('p', { class: 'muted small' }, 'Los cambios valen para los próximos; lo ya registrado no cambia.'),
      done.length ? h('div', { class: 'field' }, h('span', null, 'Últimos registrados'),
        done.map(t => h('div', { class: 'sched-done' }, h('span', null, new Date(t.date + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' })), h('span', null, M.fmt(t.amount, t.currency))))) : null),
    onSave: async (v) => {
      const week = v.mode === 'week';
      const day = week ? (sc.day || 1) : Math.round(v.day);
      if (!(day >= 1 && day <= 31)) { toast('El día va de 1 a 31'); return false; }
      if (v.end && !/^\d{4}-\d{2}$/.test(v.end)) { toast('Hasta: usa AAAA-MM'); return false; }
      const out = { ...db.get('schedules', sc.id), desc: v.desc, day, every: Number(v.every), end: v.end || null, categoryId: v.categoryId };
      if (week) out.nth = { n: Number(v.nthN), wd: Number(v.nthWd) }; else delete out.nth;
      if (v.tag) out.tag = v.tag.trim(); else delete out.tag;
      // la cuenta define la moneda del movimiento
      if ('accountId' in v) { out.accountId = v.accountId || null; const a = out.accountId && M.account(out.accountId); if (a) out.currency = a.currency; }
      // la categoría trae su reparto (un gasto compartido sigue compartido)
      const cat = M.category(out.categoryId);
      if (cat && cat.id !== sc.categoryId) out.alloc = cat.defaultAlloc === 'shared' ? 'shared' : (cat.defaultAlloc && cat.defaultAlloc.startsWith('p:') ? cat.defaultAlloc : 'none');
      if (v.uf) out.uf = v.uf; else { delete out.uf; out.amount = Math.abs(v.amount); }
      await db.put('schedules', out);
      toast('Programado guardado');
    },
    onDelete: async () => {
      const copy = { ...db.get('schedules', sc.id) };
      await db.del('schedules', sc.id);
      toast('Programado eliminado (lo ya registrado se mantiene)', { label: 'Deshacer', onAction: () => db.put('schedules', copy) });
    },
  });
}

export function renderSchedules(root, back) {
  const list = M.schedules().map(s => ({ s, next: M.nextOccurrence(s) }))
    .sort((a, b) => (a.next ? a.next.date : '9999').localeCompare(b.next ? b.next.date : '9999'));
  const today = M.todayStr();
  // desde aquí la idea es programar: la casilla "registrar también este movimiento" parte desmarcada
  const newOne = () => openTxForm(null, { repeat: { every: 1, day: Number(today.slice(8)), end: '', alsoTx: false }, open: 'repeat' });
  fill(root, back, h('h2', null, 'Programados'),
    h('p', { class: 'muted small' }, 'Lo que se repite (el arriendo que te depositan, su comisión, un seguro) o un movimiento futuro. No se registra solo: el día que corresponde aparece en Pendientes de Inicio para confirmarlo con un toque, o ajustarlo. La proyección de caja ya lo cuenta.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: newOne }, '＋ Nuevo programado')),
    list.length ? h('section', { class: 'card sched-list' }, list.map(({ s, next }) => {
      const cat = M.category(s.categoryId);
      const ended = !next;
      return h('button', { class: 'row link', onclick: () => editSchedule(s) },
        h('div', { class: 'icon', 'aria-hidden': 'true' }, (cat && cat.icon) || (s.kind === 'in' ? '💰' : '🔁')),
        h('div', { class: 'main' },
          h('div', { class: 'title' }, s.desc || (cat && cat.name) || 'Programado'),
          h('div', { class: 'sub' }, [
            s.every ? `${M.everyLabel(s.every)}, ${M.scheduleWhen(s)}` : `Una vez, ${fmtDay(M.scheduleDate(s, s.start))}`,
            cat ? cat.name : null, s.tag ? '#' + s.tag : null,
            ended ? 'terminado' : `próximo: ${fmtDay(next.date)}${next.date < today ? ' (sin confirmar)' : ''}`,
            s.end ? `hasta ${M.monthName(s.end).toLowerCase()}` : null,
          ].filter(Boolean).join(' · '))),
        h('div', { class: 'amt' }, h('div', null, `${s.kind === 'in' ? '+' : '-'}${M.fmt(M.scheduleAmount(s, (next && next.date) || today), s.currency)}`),
          s.uf ? h('div', { class: 'sub' }, `${numText(s.uf)} UF`) : null));
    })) : h('p', { class: 'empty' }, 'Aún no hay programados. Al registrar un movimiento, toca 🔁 Repetir; o elige una fecha futura.'));
}
