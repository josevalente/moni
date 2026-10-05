// Deudas y préstamos con saldo en cualquier moneda (incluida UF).
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, formModal } from '../ui.js';

const DIR = [{ v: 'owe', l: 'Yo debo' }, { v: 'owed', l: 'Me deben' }];

function addEntry(d, sign) {
  formModal({
    title: sign > 0 ? `Aumentar deuda · ${d.name}` : `Registrar pago · ${d.name}`, value: { date: M.todayStr() },
    fields: [
      { key: 'amount', label: `Monto (${d.currency})`, type: 'number', required: true },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    onSave: async (v) => {
      await db.put('debtEntries', { debtId: d.id, date: v.date, amount: sign * Math.abs(v.amount), note: v.note || '' });
      toast('Registrado');
    },
  });
}

function editDebt(d) {
  const isNew = !(d && d.id);
  formModal({
    title: isNew ? 'Nueva deuda' : 'Editar deuda', value: d || { direction: 'owe', currency: M.base() },
    fields: [
      { key: 'name', label: 'Nombre / con quién', type: 'text', required: true },
      { key: 'direction', label: 'Tipo', type: 'select', options: DIR },
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code })) },
      ...(isNew ? [{ key: '_initial', label: 'Monto inicial', type: 'number' }] : []),
      { key: 'note', label: 'Nota', type: 'textarea' },
      { key: 'excludeNW', label: 'No incluir en el patrimonio neto', type: 'check', hint: 'Útil si la deuda financia un activo (ej: un depto) que no registras.' },
      { key: 'archived', label: 'Archivada (ya pagada)', type: 'check' },
    ],
    onSave: async (v) => {
      const initial = v._initial; delete v._initial;
      const saved = await db.put('debts', v);
      if (isNew && Number.isFinite(initial) && initial) {
        await db.put('debtEntries', { debtId: saved.id, date: M.todayStr(), amount: initial, note: 'Monto inicial' });
      }
    },
    onDelete: !isNew ? async (v) => {
      await db.del('debts', v.id);
      for (const e of db.all('debtEntries').filter(x => x.debtId === v.id)) await db.del('debtEntries', e.id);
    } : null,
  });
}

function openDetail(id) {
  const body = h('div');
  let m;
  const draw = () => {
    const d = M.debtSummaries().find(x => x.id === id);
    if (!d) { if (m) m.close(); return; }
    const entries = db.all('debtEntries').filter(e => e.debtId === id).sort((a, b) => b.date.localeCompare(a.date));
    const r = M.rateFor(d.currency, M.todayStr());
    fill(body, 
      h('div', { class: 'kpis' },
        h('div', null, h('span', null, 'Saldo pendiente'), M.fmt(d.balance, d.currency)),
        r && d.currency !== M.base() ? h('div', null, h('span', null, `En ${M.base()} (hoy)`), M.fmt(d.balance * r, M.base())) : null),
      d.note ? h('p', { class: 'muted' }, d.note) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => addEntry(d, -1) }, 'Registrar pago'),
        h('button', { class: 'btn', onclick: () => addEntry(d, 1) }, 'Aumentar'),
        h('button', { class: 'btn ghost', onclick: () => editDebt(d) }, 'Editar')),
      h('h4', null, 'Historial'),
      entries.map(e => h('button', {
        class: 'row', onclick: () => formModal({
          title: 'Editar registro', value: e,
          fields: [
            { key: 'amount', label: 'Monto (negativo = pago)', type: 'number', required: true },
            { key: 'date', label: 'Fecha', type: 'date' },
            { key: 'note', label: 'Nota', type: 'text' },
          ],
          onSave: (v) => db.put('debtEntries', v), onDelete: (v) => db.del('debtEntries', v.id),
        }),
      },
      h('div', { class: 'main' }, h('div', { class: 'title' }, e.amount < 0 ? 'Pago' : 'Aumento'), h('div', { class: 'sub' }, `${e.date}${e.note ? ' · ' + e.note : ''}`)),
      h('div', { class: 'amt' }, M.fmt(e.amount, d.currency)))));
  };
  const unsub = db.subscribe(draw);
  m = modal('Deuda', body, { wide: true, onClose: unsub });
  draw();
}

export function renderDebts(root) {
  const debts = M.debtSummaries();
  const base = M.base();
  const eq = (d) => d.balance * (M.rateFor(d.currency, M.todayStr()) ?? 1);
  const owe = debts.filter(d => d.direction === 'owe').reduce((a, d) => a + eq(d), 0);
  const owed = debts.filter(d => d.direction === 'owed').reduce((a, d) => a + eq(d), 0);
  fill(root, 
    h('section', { class: 'card hero' },
      h('div', { class: 'kpis' }, h('div', null, h('span', null, 'Debo'), M.fmt(owe, base)), h('div', null, h('span', null, 'Me deben'), M.fmt(owed, base))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => editDebt(null) }, '＋ Nueva deuda'))),
    debts.length ? h('section', { class: 'card' }, debts.map(d => h('button', { class: 'row', onclick: () => openDetail(d.id) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, `${d.direction === 'owe' ? 'Yo debo' : 'Me deben'}${d.last ? ' · mov. ' + d.last : ''}`)),
      h('div', { class: 'amt' }, h('div', null, M.fmt(d.balance, d.currency)), d.currency !== base ? h('div', { class: 'sub' }, `≈ ${M.fmt(eq(d), base)}`) : null))))
      : h('p', { class: 'empty' }, 'Sin deudas registradas.'));
}
