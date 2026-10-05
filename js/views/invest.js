// Inversiones: aportes, retiros y valorizaciones (el rendimiento = valorizaciones acumuladas).
import * as db from '../db.js';
import * as M from '../model.js';
import { fill, h, modal, toast, formModal, promptDialog, parseNum } from '../ui.js';

const HORIZONS = [{ v: 'short', l: 'Corto / mediano plazo' }, { v: 'long', l: 'Largo plazo (AFP, APV…)' }];
const KIND_LABEL = { contrib: 'Aporte', withdraw: 'Retiro', gain: 'Valorización' };

function investCategoryId() {
  const c = M.categories().find(x => x.kind === 'invest');
  return c ? c.id : null;
}

async function addEntry(inv, kind) {
  const accounts = M.accounts();
  const info = M.currencyInfo(inv.currency);
  if (kind === 'gain') {
    const s = M.investmentSummaries().find(x => x.id === inv.id);
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
    return;
  }
  formModal({
    title: `${KIND_LABEL[kind]} · ${inv.name}`, value: { date: M.todayStr(), accountId: '' },
    fields: [
      { key: 'amount', label: `Monto (${inv.currency})`, type: 'number', required: true },
      { key: 'date', label: 'Fecha', type: 'date', required: true },
      {
        key: 'accountId', label: kind === 'contrib' ? 'Descontar de la cuenta (opcional)' : 'Depositar en la cuenta (opcional)', type: 'select',
        options: [{ v: '', l: '— no registrar en cuentas —' }, ...accounts.filter(a => a.currency === inv.currency).map(a => ({ v: a.id, l: a.name }))],
      },
      { key: 'note', label: 'Nota', type: 'text' },
    ],
    onSave: async (v) => {
      await db.put('invEntries', { invId: inv.id, date: v.date, kind, amount: Math.abs(v.amount), note: v.note || '' });
      if (v.accountId) {
        const tx = {
          date: v.date, kind: kind === 'contrib' ? 'out' : 'in', amount: Math.abs(v.amount), currency: inv.currency,
          accountId: v.accountId, categoryId: investCategoryId(), alloc: 'none', paidBy: M.ownerId(), desc: `${KIND_LABEL[kind]} ${inv.name}`,
        };
        if (inv.currency !== M.base()) { const fx = M.rateFor(inv.currency, v.date); if (fx != null) tx.fx = fx; }
        await db.put('tx', tx);
      }
      toast(`${KIND_LABEL[kind]} registrado`);
    },
  });
}

function editFund(f) {
  formModal({
    title: f && f.id ? 'Editar fondo' : 'Nuevo fondo', value: f || { currency: M.base(), horizon: 'short' },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true },
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code })) },
      { key: 'horizon', label: 'Plazo', type: 'select', options: HORIZONS },
      { key: 'archived', label: 'Archivado (ocultar)', type: 'check' },
    ],
    onSave: (v) => db.put('investments', v),
    onDelete: f && f.id ? async (v) => {
      await db.del('investments', v.id);
      await db.delMany('invEntries', db.all('invEntries').filter(x => x.invId === v.id).map(x => x.id));
    } : null,
  });
}

function openDetail(id) {
  const body = h('div');
  let m;
  const draw = () => {
    const s = M.investmentSummaries().find(x => x.id === id);
    if (!s) { if (m) m.close(); return; }
    const entries = db.all('invEntries').filter(e => e.invId === id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);
    fill(body, 
      h('div', { class: 'kpis' },
        h('div', null, h('span', null, 'Valor actual'), M.fmt(s.balance, s.currency)),
        h('div', null, h('span', null, 'Aportado neto'), M.fmt(s.invested, s.currency)),
        h('div', null, h('span', null, 'Ganancia'), M.fmt(s.gain, s.currency, { sign: true }))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => addEntry(s, 'gain') }, 'Actualizar valor'),
        h('button', { class: 'btn', onclick: () => addEntry(s, 'contrib') }, 'Aporte'),
        h('button', { class: 'btn', onclick: () => addEntry(s, 'withdraw') }, 'Retiro')),
      h('h4', null, 'Historial'),
      entries.map(e => h('button', {
        class: 'row', onclick: () => formModal({
          title: 'Editar registro', value: e,
          fields: [
            { key: 'kind', label: 'Tipo', type: 'select', options: Object.entries(KIND_LABEL).map(([v, l]) => ({ v, l })) },
            { key: 'amount', label: 'Monto', type: 'number', required: true, signed: true },
            { key: 'date', label: 'Fecha', type: 'date', required: true },
            { key: 'note', label: 'Nota', type: 'text' },
          ],
          onSave: (v) => db.put('invEntries', v), onDelete: (v) => db.del('invEntries', v.id),
        }),
      },
      h('div', { class: 'main' }, h('div', { class: 'title' }, KIND_LABEL[e.kind]), h('div', { class: 'sub' }, `${e.date}${e.note ? ' · ' + e.note : ''}`)),
      h('div', { class: 'amt ' + (e.kind === 'withdraw' || e.amount < 0 ? 'neg' : '') }, M.fmt(e.kind === 'withdraw' ? -e.amount : e.amount, s.currency)))),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => editFund(db.get('investments', s.id)) }, 'Editar fondo')));
  };
  const unsub = db.subscribe(draw);
  m = modal('Inversión', body, { wide: true, onClose: unsub });
  draw();
}

export function renderInvest(root) {
  const funds = M.investmentSummaries();
  const base = M.base();
  const conv = (f) => (M.currencyInfo(f.currency).convertible === false ? null : f.balance * (M.rateFor(f.currency, M.todayStr()) ?? 1));
  const total = funds.reduce((a, f) => a + (conv(f) || 0), 0);
  const group = (hz, title) => {
    const list = funds.filter(f => (f.horizon || 'short') === hz);
    if (!list.length) return null;
    return h('section', { class: 'card' }, h('h3', null, title), list.map(f => h('button', { class: 'row', onclick: () => openDetail(f.id) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, f.name),
        h('div', { class: 'sub' }, `${f.currency} · rentab. ${f.contrib ? (f.ret * 100).toFixed(1) + '%' : '—'}${f.last ? ' · act. ' + f.last : ''}`)),
      h('div', { class: 'amt' }, h('div', null, M.fmt(f.balance, f.currency)),
        f.currency !== base && conv(f) != null ? h('div', { class: 'sub' }, `≈ ${M.fmt(conv(f), base)}`) : null))));
  };
  const archived = db.all('investments').filter(i => i.archived);
  fill(root, 
    h('section', { class: 'card hero' },
      h('div', { class: 'label' }, 'Total invertido (valor actual)'), h('div', { class: 'big' }, M.fmt(total, base)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => editFund(null) }, '＋ Nuevo fondo'))),
    group('short', 'Corto / mediano plazo'), group('long', 'Largo plazo'),
    archived.length ? h('section', { class: 'card' }, h('h3', null, 'Archivados'), archived.map(f => h('button', { class: 'row', onclick: () => editFund(f) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, f.currency)), h('div', { class: 'amt muted' }, 'Editar')))) : null,
    !funds.length ? h('p', { class: 'empty' }, 'Sin inversiones aún.') : null);
}
