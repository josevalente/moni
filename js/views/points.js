// Puntos y millas (Dólares-Premio, LATAM Pass…): saldo en su unidad, lo acumulado y lo canjeado.
// No son inversión: no entran a los gráficos ni al total invertido, y suman al patrimonio solo si se pide.
// Se guardan como inversiones de tipo 'points' (mismos registros: acumulé = aporte, canjeé = retiro,
// "actualizar saldo" = ajuste por la diferencia).
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, formModal, promptDialog, parseNum } from '../ui.js';
import { fmtQty } from './invest.js';

const dShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', ...(d.slice(0, 4) !== M.todayStr().slice(0, 4) ? { year: 'numeric' } : {}) });
const LABEL = { contrib: 'Acumulé', withdraw: 'Canjeé', gain: 'Ajuste de saldo', dividend: 'Acumulé' };
const amountOf = (p, v) => (M.currencyInfo(p.currency).convertible === false ? `${fmtQty(v)} ${p.currency.toLowerCase()}` : M.fmt(v, p.currency));

async function updateBalance(p) {
  const v = await promptDialog('Saldo actual', { label: `¿Cuánto tienes hoy en ${p.name}?`, type: 'number', hint: `Registrado: ${amountOf(p, p.balance)}.` });
  if (v == null) return;
  const n = parseNum(v);
  if (!Number.isFinite(n)) { toast('Valor no válido'); return; }
  const diff = n - p.balance;
  if (Math.abs(diff) < 0.005) { toast('Sin cambios'); return; }
  await db.put('invEntries', { invId: p.id, date: M.todayStr(), kind: 'gain', amount: diff, value: n, note: 'Saldo actualizado' });
  toast(`Saldo actualizado (${diff > 0 ? '+' : ''}${amountOf(p, diff)})`);
}

function entryForm(p, kind, e = null) {
  formModal({
    title: `${LABEL[kind]} · ${p.name}`, value: e || { date: M.todayStr() },
    fields: [
      { key: 'amount', label: `Cantidad (${p.currency})`, type: 'number', required: true },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'note', label: kind === 'withdraw' ? '¿En qué lo canjeaste?' : 'Nota', type: 'text' },
    ],
    onSave: (v) => db.put('invEntries', { ...(e || {}), ...v, invId: p.id, kind: e ? e.kind : kind, amount: e && e.kind === 'gain' ? v.amount : Math.abs(v.amount) }),
    onDelete: e ? () => db.del('invEntries', e.id) : null,
  });
}

export function editProgram(p) {
  const isNew = !(p && p.id);
  formModal({
    title: isNew ? 'Nuevo programa' : 'Editar programa', value: p || { currency: 'Millas', type: 'points' },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'Ej: LATAM Pass' },
      { key: 'currency', label: 'Unidad', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code + (c.convertible === false ? ' (puntos, sin tipo de cambio)' : '') })),
        hint: 'Para millas o puntos usa una unidad sin conversión (Más › Monedas). Dólares-Premio puede ir en USD.' },
      { key: 'pointValue', label: `Valor de 1 unidad en ${M.base()} (opcional)`, type: 'number', hint: 'Para estimar cuánto valen. Si la unidad es una moneda (USD), se usa su tipo de cambio.' },
      { key: 'inNetWorth', label: 'Sumar a mi patrimonio', type: 'check' },
      { key: 'expires', label: 'Vencen el (opcional)', type: 'date' },
      { key: 'archived', label: 'Archivado (ocultar)', type: 'check' },
    ],
    onSave: (v) => { if (!v.pointValue) delete v.pointValue; if (!v.expires) delete v.expires; return db.put('investments', { ...v, type: 'points' }); },
    onDelete: !isNew ? async (v) => {
      await db.del('investments', v.id);
      await db.delMany('invEntries', db.all('invEntries').filter(x => x.invId === v.id).map(x => x.id));
    } : null,
    extra: !isNew ? h('div', { class: 'merge-box' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
      await db.put('investments', { ...db.get('investments', p.id), type: 'fund' });
      document.querySelectorAll('.sheet header .icon-btn').forEach(b => b.click());
      toast(`${p.name} volvió a Inversiones`);
    } }, 'No es un programa de puntos: devolver a Inversiones')) : null,
  });
}

function openProgram(id) {
  const body = h('div');
  let m;
  const draw = () => {
    const p = M.pointsSummaries().find(x => x.id === id) || (() => { const r = db.get('investments', id); return r && M.isPoints(r) ? { ...r, ...M.fundStats(r) } : null; })();
    if (!p) { if (m) m.close(); return; }
    const entries = db.all('invEntries').filter(e => e.invId === id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
    fill(body,
      h('div', { class: 'kpis' },
        h('div', null, h('span', null, 'Saldo'), amountOf(p, p.balance)),
        p.valueBase != null ? h('div', null, h('span', null, 'Equivale a'), M.fmt(p.valueBase, M.base())) : null,
        h('div', null, h('span', null, 'Patrimonio'), p.inNetWorth ? 'Suma' : 'No suma'),
        p.expires ? h('div', null, h('span', null, 'Vencen'), dShort(p.expires)) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => updateBalance(p) }, 'Actualizar saldo'),
        h('button', { class: 'btn', onclick: () => entryForm(p, 'contrib') }, 'Acumulé'),
        h('button', { class: 'btn', onclick: () => entryForm(p, 'withdraw') }, 'Canjeé')),
      h('h4', null, 'Historial'),
      entries.length ? entries.map(e => {
        const v = e.kind === 'withdraw' ? -e.amount : e.amount;
        return h('button', { class: 'row', onclick: () => entryForm(p, e.kind === 'dividend' ? 'contrib' : e.kind, e) },
          h('div', { class: 'main' }, h('div', { class: 'title' }, LABEL[e.kind] || e.kind), h('div', { class: 'sub' }, [dShort(e.date), e.note].filter(Boolean).join(' · '))),
          h('div', { class: 'amt ' + (v < 0 ? 'neg' : '') }, (v > 0 ? '+' : '') + amountOf(p, v)));
      }) : h('p', { class: 'empty' }, 'Sin registros.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => editProgram(db.get('investments', id)) }, 'Editar programa')));
  };
  const unsub = db.subscribe(draw);
  m = modal((db.get('investments', id) || {}).name || 'Programa', body, { wide: true, onClose: unsub });
  draw();
}

export function renderPoints(root) {
  const list = M.pointsSummaries();
  const archived = db.all('investments').filter(i => M.isPoints(i) && i.archived);
  const inNW = list.filter(p => p.inNetWorth && p.valueBase != null).reduce((a, p) => a + p.valueBase, 0);
  const soon = M.addDays(M.todayStr(), 60);
  fill(root,
    h('p', { class: 'muted' }, 'Dólares-Premio, millas y puntos: no son inversión, así que no entran a los gráficos ni al total invertido. Suman a tu patrimonio solo si lo marcas en cada programa.'),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Programas'), h('button', { class: 'btn primary small', onclick: () => editProgram(null) }, '＋ Nuevo')),
      list.length ? list.map(p => h('button', { class: 'row', onclick: () => openProgram(p.id) },
        h('div', { class: 'main' },
          h('div', { class: 'title' }, p.name),
          h('div', { class: 'sub' }, [p.last ? `act. ${dShort(p.last)}` : null, p.inNetWorth ? 'suma al patrimonio' : null,
            p.expires ? (p.expires <= soon ? `⚠️ vencen ${dShort(p.expires)}` : `vencen ${dShort(p.expires)}`) : null].filter(Boolean).join(' · ') || ' ')),
        h('div', { class: 'amt' }, h('div', null, amountOf(p, p.balance)),
          p.valueBase != null && M.currencyInfo(p.currency).code !== M.base() ? h('div', { class: 'sub' }, `≈ ${M.fmt(p.valueBase, M.base())}`) : null)))
        : h('p', { class: 'empty' }, 'Sin programas. Si los tenías en Inversiones, ahí aparece la opción de moverlos.'),
      inNW ? h('div', { class: 'card-foot' }, h('span', { class: 'muted small' }, `Suman al patrimonio: ${M.fmt(inNW, M.base())}`)) : null),
    archived.length ? h('section', { class: 'card' }, h('h3', null, 'Archivados'), archived.map(p => h('button', { class: 'row', onclick: () => editProgram(p) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, p.currency)), h('div', { class: 'amt muted' }, 'Editar')))) : null);
}
