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
  const hipo = (v) => v._kind === 'mortgage';
  formModal({
    title: isNew ? 'Nueva deuda' : 'Editar deuda', value: d || { direction: 'owe', currency: M.base(), _kind: 'simple', _first: M.todayStr(), _from: M.todayStr() },
    fields: [
      { key: 'name', label: 'Nombre / con quién', type: 'text', required: true },
      ...(isNew ? [{ key: '_kind', label: 'Clase', type: 'select', options: [{ v: 'simple', l: 'Deuda o préstamo' }, { v: 'mortgage', l: 'Crédito hipotecario (tasa fija, con dividendo)' }] }] : []),
      { key: 'direction', label: 'Tipo', type: 'select', options: DIR, show: (v) => !hipo(v) },
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code })) },
      ...(isNew ? [
        { key: '_initial', label: 'Monto inicial', type: 'number', show: (v) => !hipo(v) },
        { key: '_principal', label: 'Monto del crédito', type: 'number', show: hipo },
        { key: '_rate', label: 'Tasa de interés anual (%)', type: 'number', show: hipo, hint: 'La de la tabla de desarrollo (ej: 4,33).' },
        { key: '_months', label: 'Plazo (cuotas)', type: 'number', show: hipo },
        { key: '_insurance', label: 'Seguros por cuota (opcional)', type: 'number', show: hipo, hint: 'Incendio + desgravamen, en la moneda del crédito.' },
        { key: '_from', label: 'Fecha del desembolso', type: 'date', show: hipo },
        { key: '_first', label: 'Vencimiento de la primera cuota', type: 'date', show: hipo },
      ] : []),
      { key: 'note', label: 'Nota', type: 'textarea' },
      { key: 'excludeNW', label: 'No incluir en el patrimonio neto', type: 'check', hint: 'Útil si la deuda financia un activo (ej: un depto) que no registras.' },
      { key: 'archived', label: 'Archivada (ya pagada)', type: 'check' },
    ],
    onSave: async (v) => {
      const initial = v._initial; delete v._initial;
      if (v._kind === 'mortgage') {
        if (!v._principal || !v._rate || !v._months) { toast('Faltan monto, tasa o plazo'); return false; }
        // misma tabla que el banco: sistema francés con tasa mensual equivalente
        v.direction = 'owe';
        v.mortgage = { principal: Math.abs(v._principal), from: v._from, first: v._first, rows: M.mortgageSchedule({ principal: Math.abs(v._principal), annualRate: v._rate / 100, months: Math.round(v._months), insurance: Math.abs(v._insurance || 0) }) };
      }
      for (const k of ['_kind', '_principal', '_rate', '_months', '_insurance', '_from', '_first']) delete v[k];
      const saved = await db.put('debts', v);
      if (isNew && Number.isFinite(initial) && initial) {
        await db.put('debtEntries', { debtId: saved.id, date: M.todayStr(), amount: initial, note: 'Monto inicial' });
      }
    },
    onDelete: !isNew ? async (v) => {
      await db.del('debts', v.id);
      await db.delMany('debtEntries', db.all('debtEntries').filter(x => x.debtId === v.id).map(x => x.id));
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
      d.mortgage ? h('p', { class: 'small' }, d.cuota < d.cuotas
        ? `Cuota ${d.cuota + 1} de ${d.cuotas}: dividendo ${M.fmt(d.mortgage.rows[d.cuota][6], d.currency)} (amortización ${M.fmt(d.mortgage.rows[d.cuota][1], d.currency)}). El saldo baja solo con cada cuota según la tabla de desarrollo.`
        : 'Crédito pagado.') : null,
      h('div', { class: 'actions' },
        d.mortgage ? null : h('button', { class: 'btn primary', onclick: () => addEntry(d, -1) }, 'Registrar pago'),
        d.mortgage ? null : h('button', { class: 'btn', onclick: () => addEntry(d, 1) }, 'Aumentar'),
        h('button', { class: 'btn ghost', onclick: () => editDebt(db.get('debts', d.id)) }, 'Editar')),
      h('h4', null, 'Historial'),
      entries.map(e => h('button', {
        class: 'row', onclick: () => formModal({
          title: 'Editar registro', value: e,
          fields: [
            { key: 'amount', label: 'Monto (negativo = pago; usa ±)', type: 'number', required: true, signed: true },
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
      h('div', { class: 'main' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, d.mortgage ? `Crédito hipotecario · cuota ${Math.min(d.cuota + 1, d.cuotas)} de ${d.cuotas}` : `${d.direction === 'owe' ? 'Yo debo' : 'Me deben'}${d.last ? ' · mov. ' + d.last : ''}`)),
      h('div', { class: 'amt' }, h('div', null, M.fmt(d.balance, d.currency)), d.currency !== base ? h('div', { class: 'sub' }, `≈ ${M.fmt(eq(d), base)}`) : null))))
      : h('p', { class: 'empty' }, 'Sin deudas registradas.'));
}
