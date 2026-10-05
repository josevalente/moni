// "Más": configuración personalizable (categorías, cuentas, personas, monedas, reparto) y respaldo.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, toast, formModal, confirmDialog, promptDialog, parseNum, shareFile } from '../ui.js';
import { openSplitEditor } from './close.js';
import { renderInvest } from './invest.js';
import { renderDebts } from './debts.js';

const KINDS = [
  { v: 'expense', l: 'Gasto' }, { v: 'income', l: 'Ingreso' }, { v: 'loan', l: 'Préstamo (no es gasto)' },
  { v: 'invest', l: 'Inversión (no es gasto)' }, { v: 'adjust', l: 'Ajuste (no es gasto)' },
];
const KIND_L = Object.fromEntries(KINDS.map(k => [k.v, k.l.split(' (')[0]]));
const ACC_TYPES = [{ v: 'bank', l: 'Cuenta bancaria' }, { v: 'credit', l: 'Tarjeta / línea de crédito' }, { v: 'cash', l: 'Efectivo' }];
const MODES = [{ v: 'prop', l: 'Proporcional a los sueldos' }, { v: 'equal', l: 'Partes iguales' }, { v: 'fixed', l: 'Porcentaje fijo para esta categoría' }];

const back = (to = '#/mas') => h('a', { class: 'backlink', href: to }, '‹ Más');

// ---------------------------------------------------------------- categorías
function editCategory(c) {
  const isNew = !(c && c.id);
  const people = M.people();
  const groups = [...new Set(M.categories().map(x => x.group).filter(Boolean))];
  const val = { kind: 'expense', defaultAlloc: 'none', splitMode: 'prop', ...(c || {}) };
  formModal({
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
        build: (v) => {
          const ins = {};
          const el = h('div', { class: 'grid-people' }, people.map(p => {
            const inp = h('input', { type: 'text', inputmode: 'decimal', value: v && v[p.id] != null ? Math.round(v[p.id] * 1000) / 10 : '' });
            ins[p.id] = inp;
            return h('label', { class: 'field' }, h('span', null, `${p.name} (%)`), inp);
          }));
          return { el: h('div', null, h('small', null, 'Solo se usa si eliges "porcentaje fijo". Ej: 80 / 20.'), el), get: () => {
            const o = {}; let any = false;
            for (const p of people) { const n = parseNum(ins[p.id].value); if (Number.isFinite(n)) { o[p.id] = n / 100; any = true; } }
            return any ? o : undefined;
          } };
        },
      },
      { key: 'archived', label: 'Archivada (no aparece al registrar)', type: 'check' },
    ],
    onSave: async (v) => { if (v.splitMode !== 'fixed') delete v.fixedPct; await db.put('categories', v); toast('Categoría guardada'); },
    onDelete: !isNew ? async (v) => {
      const used = db.all('tx').some(t => t.categoryId === v.id);
      if (used) { toast('Tiene movimientos: archívala en vez de eliminarla'); return; }
      await db.del('categories', v.id);
    } : null,
    extra: h('datalist', { id: 'grouplist' }, groups.map(g => h('option', { value: g }))),
  });
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
    fill(list, ...[...groups.entries()].map(([g, cs]) => h('section', { class: 'card' }, h('h3', null, g), cs.map(c => h('button', { class: 'row' + (c.archived ? ' dim' : ''), onclick: () => editCategory(c) },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${c.icon || ''} ${c.name}`.trim()),
        h('div', { class: 'sub' }, [KIND_L[c.kind], c.defaultAlloc === 'shared' ? (c.splitMode === 'fixed' ? 'compartido (fijo)' : c.splitMode === 'equal' ? 'compartido (50/50)' : 'compartido') : c.defaultAlloc && c.defaultAlloc.startsWith('p:') ? `solo de ${M.personName(c.defaultAlloc.slice(2))}` : null, c.archived ? 'archivada' : null].filter(Boolean).join(' · '))),
      h('div', { class: 'amt muted' }, `${counts.get(c.id) || 0}`))))));
  };
  q.addEventListener('input', draw);
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Categorías'), h('button', { class: 'btn primary small', onclick: () => editCategory(null) }, '＋ Nueva')), q, list);
  draw();
  return draw;
}

// ---------------------------------------------------------------- cuentas
function editAccount(a) {
  const isNew = !(a && a.id);
  formModal({
    title: isNew ? 'Nueva cuenta' : 'Editar cuenta', value: a || { type: 'bank', currency: M.base() },
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true },
      { key: 'bank', label: 'Banco / institución', type: 'text' },
      { key: 'type', label: 'Tipo', type: 'select', options: ACC_TYPES },
      { key: 'currency', label: 'Moneda', type: 'select', options: M.settings().currencies.map(c => ({ v: c.code, l: c.code })) },
      ...(isNew ? [{ key: '_opening', label: 'Saldo inicial (negativo si es deuda)', type: 'number' }] : []),
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
        p.id !== M.ownerId() ? h('button', { class: 'btn small', onclick: async () => { await db.put('settings', { ...M.settings(), ownerId: p.id }); } }, 'Dueño cuentas') : null)))),
  h('section', { class: 'card' }, h('h3', null, '¿Cómo funciona con dos teléfonos?'),
    h('p', { class: 'muted' }, 'Cada persona puede instalar la app y registrar sus gastos eligiendo "Lo pagó". Para juntar los datos usen Respaldo › Combinar: el archivo de uno se mezcla con el del otro sin duplicar ni perder cambios. Si solo una persona lleva todo, basta con elegir quién pagó en cada movimiento.')));
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
  const latest = (cur) => {
    const rs = db.all('rates').filter(r => r.cur === cur).sort((a, b) => b.date.localeCompare(a.date));
    return rs[0];
  };
  fill(root, back(), h('div', { class: 'card-head' }, h('h2', null, 'Monedas y tipo de cambio'),
    h('button', { class: 'btn primary small', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Actualizando…';
      const r = await FX.refreshRates({ force: true });
      toast(r.ok ? `Tipos de cambio actualizados (${r.count})` : (r.reason === 'offline' ? 'Sin conexión: se usa el último valor guardado' : 'No se pudo actualizar'));
      renderCurrencies(root);
    } }, 'Actualizar ahora')),
  h('section', { class: 'card' },
    h('p', { class: 'muted' }, `Moneda base: ${st.baseCurrency}. Cada movimiento guarda el tipo de cambio del día en que se registró, así el pasado no se mueve cuando cambia el dólar. Fuente: mindicador.cl (con conexión); sin conexión se usa el último valor.`),
    st.currencies.map(c => { const r = latest(c.code); return h('div', { class: 'row static' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${c.code} · ${c.symbol}`), h('div', { class: 'sub' }, c.code === st.baseCurrency ? 'moneda base' : (c.convertible === false ? 'sin conversión (ej: millas)' : r ? `1 ${c.code} = ${M.fmt(r.rate, st.baseCurrency)} (${r.date})${r.manual ? ' · manual' : ''}` : 'sin tipo de cambio'))),
      c.code !== st.baseCurrency && c.convertible !== false ? h('button', { class: 'btn small', onclick: async () => {
        const v = await promptDialog(`Tipo de cambio ${c.code}`, { label: `1 ${c.code} en ${st.baseCurrency} (hoy)`, type: 'number', value: r ? String(r.rate).replace('.', ',') : '' });
        const n = parseNum(v); if (v != null && Number.isFinite(n) && n > 0) { await FX.setManualRate(c.code, M.todayStr(), n); renderCurrencies(root); }
      } }, 'Manual') : null); }),
    h('button', { class: 'btn', onclick: () => formModal({
      title: 'Nueva moneda', value: { decimals: 2, convertible: true },
      fields: [{ key: 'code', label: 'Código (ej: GBP)', type: 'text', required: true }, { key: 'symbol', label: 'Símbolo', type: 'text', required: true }, { key: 'decimals', label: 'Decimales', type: 'number' }, { key: 'convertible', label: 'Se convierte a la moneda base', type: 'check' }],
      onSave: async (v) => { v.code = v.code.toUpperCase(); if (st.currencies.some(c => c.code === v.code)) { toast('Ya existe'); return; } await db.put('settings', { ...st, currencies: [...st.currencies, { code: v.code, symbol: v.symbol, decimals: v.decimals ?? 2, convertible: !!v.convertible }] }); renderCurrencies(root); },
    }) }, '＋ Agregar moneda')));
}

// ---------------------------------------------------------------- respaldo
const fileInput = (accept, onFile) => {
  const i = h('input', { type: 'file', accept, style: { display: 'none' } });
  i.addEventListener('change', async () => { if (i.files[0]) await onFile(i.files[0]); i.value = ''; });
  document.body.append(i); i.click(); setTimeout(() => i.remove(), 60000);
};

export function exportCsv() {
  const q = (v) => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = [['fecha', 'tipo', 'monto', 'moneda', 'categoria', 'cuenta', 'cuenta_destino', 'pagado_por', 'reparto', 'descripcion', 'etiqueta']];
  for (const t of M.sortTx(db.all('tx'))) {
    rows.push([t.date, t.kind, t.amount, t.currency, (M.category(t.categoryId) || {}).name, (M.account(t.accountId) || {}).name, (M.account(t.toAccountId) || {}).name, M.personName(t.paidBy), t.alloc || '', t.desc, t.tag]);
  }
  return rows.map(r => r.map(q).join(',')).join('\n');
}

function renderBackup(root) {
  const last = (() => { try { return localStorage.getItem('moni.lastBackup'); } catch { return null; } })();
  const stamp = () => new Date().toISOString().slice(0, 10);
  const doExport = async () => {
    const json = JSON.stringify(db.exportAll());
    await shareFile(`moni-respaldo-${stamp()}.json`, json);
    try { localStorage.setItem('moni.lastBackup', new Date().toISOString()); } catch { /* ignore */ }
    renderBackup(root);
  };
  const doImport = (mode) => fileInput('.json,application/json', async (f) => {
    let payload;
    try { payload = JSON.parse(await f.text()); } catch { toast('El archivo no es un JSON válido'); return; }
    if (mode === 'replace' && !(await confirmDialog('Esto reemplaza TODOS los datos de este dispositivo por los del archivo. ¿Continuar?', { ok: 'Reemplazar' }))) return;
    try {
      const s = await db.importAll(payload, mode);
      toast(mode === 'replace' ? 'Datos cargados' : `Combinado: ${s.added} nuevos, ${s.updated} actualizados`);
      if (mode === 'replace') location.hash = '#/';
    } catch (e) { toast(e.message || 'No se pudo importar'); }
  });
  const counts = { 'Movimientos': db.count('tx'), 'Categorías': db.count('categories'), 'Cuentas': db.count('accounts'), 'Inversiones': db.count('investments') };
  fill(root, back(), h('h2', null, 'Respaldo y datos'),
    h('section', { class: 'card' },
      h('p', null, 'Tus datos viven solo en este dispositivo. ', h('strong', null, 'Haz un respaldo seguido'), ' y guárdalo en Archivos / iCloud Drive.'),
      h('p', { class: 'muted' }, last ? `Último respaldo: ${new Date(last).toLocaleString('es-CL')}` : 'Aún no has hecho un respaldo.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: doExport }, 'Exportar respaldo (JSON)'), h('button', { class: 'btn', onclick: () => shareFile(`moni-movimientos-${stamp()}.csv`, '﻿' + exportCsv(), 'text/csv') }, 'Exportar movimientos (CSV)'))),
    h('section', { class: 'card' }, h('h3', null, 'Importar'),
      h('p', { class: 'muted' }, 'Combinar mezcla un archivo con tus datos actuales: por cada registro gana el cambio más reciente. Sirve para juntar lo que registran dos personas en teléfonos distintos.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => doImport('merge') }, 'Combinar con archivo…'), h('button', { class: 'btn danger', onclick: () => doImport('replace') }, 'Reemplazar todo…'))),
    h('section', { class: 'card' }, h('h3', null, 'En este dispositivo'),
      Object.entries(counts).map(([k, v]) => h('div', { class: 'row static' }, h('div', { class: 'main' }, h('div', { class: 'title' }, k)), h('div', { class: 'amt' }, String(v)))),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger ghost', onclick: async () => {
        if (await confirmDialog('Se borrarán todos los datos de este dispositivo. Haz un respaldo antes. ¿Continuar?', { ok: 'Borrar todo' })) { await db.wipe(); await M.seedDefaults(); location.hash = '#/'; toast('Datos borrados'); }
      } }, 'Borrar todos los datos'))));
}

// ---------------------------------------------------------------- menú
export function renderMore(root, sub) {
  const subs = { categorias: renderCategories, cuentas: renderAccounts, personas: renderPeople, reparto: renderSplits, monedas: renderCurrencies, respaldo: renderBackup };
  if (sub === 'inversiones') { fill(root, ); const inner = h('div'); root.append(back(), h('h2', null, 'Inversiones'), inner); renderInvest(inner); return () => renderInvest(inner); }
  if (sub === 'deudas') { fill(root, ); const inner = h('div'); root.append(back(), h('h2', null, 'Deudas'), inner); renderDebts(inner); return () => renderDebts(inner); }
  if (subs[sub]) { const r = subs[sub](root); return typeof r === 'function' ? r : () => subs[sub](root); }
  const item = (to, icon, title, sub2) => h('a', { class: 'row link', href: '#/mas/' + to }, h('div', { class: 'icon' }, icon), h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub2)), h('div', { class: 'chev' }, '›'));
  fill(root, 
    h('section', { class: 'card' },
      item('inversiones', '📈', 'Inversiones', 'Fondos, AFP, APV: aportes y valor actual'),
      item('deudas', '🤝', 'Deudas', 'Lo que debes o te deben, en cualquier moneda')),
    h('section', { class: 'card' },
      item('categorias', '🏷️', 'Categorías', 'Tus ítems de gasto: nombre, grupo, reparto'),
      item('cuentas', '🏦', 'Cuentas', 'Bancos, tarjetas y efectivo'),
      item('reparto', '⚖️', 'Reparto mensual', 'Sueldos o % que definen el cobro'),
      item('personas', '👥', 'Personas', 'Quiénes participan y este dispositivo'),
      item('monedas', '💱', 'Monedas y tipo de cambio', 'CLP, USD, EUR, UF…')),
    h('section', { class: 'card' }, item('respaldo', '💾', 'Respaldo y datos', 'Exportar, importar y combinar')),
    h('p', { class: 'muted center small' }, 'Moni · tus datos se guardan solo en este dispositivo'));
}
