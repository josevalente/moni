// Programados: movimientos que se repiten (o uno futuro). Se confirman desde Pendientes el día que
// corresponde; acá se ven todos, se editan o se dejan de repetir.
import * as db from '../db.js';
import * as M from '../model.js';
import * as FX from '../fx.js';
import { fill, h, modal, toast, formModal, numText, promptDialog } from '../ui.js';
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
      payroll: sc.payroll || '', calcType: (sc.calc || {}).type || '', calcPct: (sc.calc || {}).pct ?? null, calcPlanUF: (sc.calc || {}).planUF ?? null,
      mode: sc.nth ? 'week' : 'day', nthN: String((sc.nth || M.nthOfDate(M.scheduleDate(sc, sc.start))).n), nthWd: String((sc.nth || M.nthOfDate(M.scheduleDate(sc, sc.start))).wd) },
    fields: [
      { key: 'desc', label: 'Descripción', type: 'text' },
      { key: 'categoryId', label: 'Categoría', type: 'select', options: cats.map(c => ({ v: c.id, l: (c.icon ? c.icon + ' ' : '') + c.name })) },
      ...(sc.paidBy === owner || !sc.paidBy ? [{ key: 'accountId', label: 'Cuenta', type: 'select', options: [...accs.map(a => ({ v: a.id, l: `${a.name} (${a.currency})` })), { v: '', l: 'Sin cuenta' }] }] : []),
      { key: 'tag', label: 'Etiqueta (opcional)', type: 'text' },
      // del sueldo: un haber se marca imponible o no; un descuento legal se calcula sobre lo imponible del mes
      ...(sc.kind === 'in' ? [{ key: 'payroll', label: 'En la liquidación de sueldo', type: 'select', options: [{ v: '', l: 'No es parte del sueldo' }, { v: 'imp', l: 'Haber imponible (sueldo, gratificación, bonos)' }, { v: 'noimp', l: 'Haber no imponible (colación, movilización)' }] }]
        : [{ key: 'calcType', label: 'Monto', type: 'select', options: [{ v: '', l: 'Fijo (o en UF)' }, ...M.CALC.map(([v, l]) => ({ v, l: `Calculado · ${l}` }))], hint: 'Calculado: cada mes sobre los haberes imponibles programados del sueldo.' },
          { key: 'calcPct', label: 'Porcentaje', type: 'number', show: (v) => v.calcType === 'afp' || v.calcType === 'cesantia', hint: 'AFP: la tasa de la tuya, ej. 11,44. Seguro de cesantía: 0,6 con contrato indefinido.' },
          { key: 'calcPlanUF', label: 'Plan de la Isapre (UF al mes)', type: 'number', show: (v) => v.calcType === 'salud', hint: 'Se descuenta el mayor entre el 7% de lo imponible y el plan. En Fonasa, déjalo vacío.' }]),
      ...(ufOk ? [{ key: 'uf', label: 'Monto fijo en UF (opcional)', type: 'number', calc: true, show: (v) => !v.calcType, hint: 'Acepta operaciones, ej. 8,5 × 1,19. Cada vez se registra con la UF de ese día. Vacío: monto fijo en pesos.' }] : []),
      { key: 'amount', label: `Monto (${sc.currency})`, type: 'number', calc: true, required: true, show: (v) => !v.uf && !v.calcType },
      { key: 'mode', label: 'Qué día', type: 'select', options: [{ v: 'day', l: 'Un día del mes' }, { v: 'week', l: 'Un día de la semana o hábil (ej. primer lunes, último día hábil)' }] },
      { key: 'day', label: 'Día del mes', type: 'number', required: true, show: (v) => v.mode !== 'week', hint: 'Con 31, el último día de cada mes.' },
      { key: 'nthN', label: 'Cuál', type: 'select', options: M.NTHS.map(([v, l]) => ({ v: String(v), l })), show: (v) => v.mode === 'week' },
      { key: 'nthWd', label: 'Día de la semana', type: 'select', options: [...[1, 2, 3, 4, 5, 6, 0].map(v => ({ v: String(v), l: M.WEEKDAYS[v] })), { v: 'h', l: 'día hábil (lunes a viernes sin feriados)' }], show: (v) => v.mode === 'week' },
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
      if (week) out.nth = { n: Number(v.nthN), wd: v.nthWd === 'h' ? 'h' : Number(v.nthWd) }; else delete out.nth;
      if (v.tag) out.tag = v.tag.trim(); else delete out.tag;
      // la cuenta define la moneda del movimiento
      if ('accountId' in v) { out.accountId = v.accountId || null; const a = out.accountId && M.account(out.accountId); if (a) out.currency = a.currency; }
      // la categoría trae su reparto (un gasto compartido sigue compartido)
      const cat = M.category(out.categoryId);
      if (cat && cat.id !== sc.categoryId) out.alloc = cat.defaultAlloc === 'shared' ? 'shared' : (cat.defaultAlloc && cat.defaultAlloc.startsWith('p:') ? cat.defaultAlloc : 'none');
      if (v.payroll) out.payroll = v.payroll; else delete out.payroll;
      if (v.calcType) {
        if ((v.calcType === 'afp' || v.calcType === 'cesantia') && !(v.calcPct > 0)) { toast('Falta el porcentaje'); return false; }
        out.calc = { type: v.calcType, ...(v.calcPct > 0 ? { pct: v.calcPct } : {}), ...(v.calcType === 'salud' && v.calcPlanUF > 0 ? { planUF: v.calcPlanUF } : {}) };
        delete out.uf;
      } else {
        delete out.calc;
        if (v.uf) out.uf = v.uf; else { delete out.uf; out.amount = Math.abs(v.amount); }
      }
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

// Liquidación de un mes: los haberes programados (se ajustan o se agregan, ej. un aguinaldo) y los descuentos
// legales calculados al momento sobre lo imponible; se registra todo junto, con un solo "Deshacer".
export function openPayroll(ym) {
  const base = M.base();
  let p = M.payrollFor(ym);
  if (!p.haberes.length && !p.deds.length) { toast('No hay programados del sueldo este mes'); return; }
  const date = M.scheduleDate((p.haberes[0] || p.deds[0]).s, ym);
  // la UTM del mes (para el impuesto) y la UF del último día del mes (topes y plan de la Isapre): si no están
  // guardadas, se consultan
  // guardadas, se consultan sin esperar: la ventana se abre al tiro y se recalcula cuando llegan
  const ufEnd = () => { const r = M.seriesAt('UF', M.monthEnd(ym)); return r && r.date === M.monthEnd(ym); };
  const missing = () => !M.rateFor('UTM', date) || !ufEnd();
  let updating = missing() && navigator.onLine !== false;
  if (updating) {
    // la UF del último día del mes, puntual (liviana); la UTM viene con la consulta del día
    Promise.all([ufEnd() ? null : FX.fetchRateOn('UF', M.monthEnd(ym)), M.rateFor('UTM', date) ? null : FX.refreshRates({ force: true }).catch(() => {})]).catch(() => {}).finally(() => {
      updating = false;
      const fresh = M.payrollFor(ym);
      p.uf = fresh.uf; p.utm = fresh.utm;
      if (document.body.contains(box)) recalc();
    });
  }
  const done = new Map(db.all('tx').filter(t => t.scheduleId && t.scheduleMonth === ym).map(t => [t.scheduleId, t]));
  const first = (p.haberes[0] || p.deds[0]).s;
  const incomeCats = M.categories().filter(c => !c.archived && c.kind === 'income');
  const expCats = M.categories().filter(c => !c.archived && (c.kind === 'expense' || c.kind === 'invest'));
  const catOf = (imp) => ((p.haberes.find(x => x.imponible === imp) || p.haberes[0] || {}).s || {}).categoryId || (incomeCats[0] || {}).id;
  const otherDedCat = (expCats.find(c => /otros descuentos/i.test(c.name)) || expCats.find(c => M.isPayrollDeduction(c)) || expCats[0] || {}).id;
  // líneas: haberes (los ya registrados, con su monto) y descuentos extra
  const lines = p.haberes.map(x => ({ s: x.s, desc: x.s.desc, amount: done.has(x.s.id) ? done.get(x.s.id).amount : x.amount, imponible: x.imponible, categoryId: x.s.categoryId, done: done.has(x.s.id) }));
  const extraDeds = [];
  const box = h('div'), dedBox = h('div'), totals = h('div', { class: 'pay-total' });
  const amountInput = (obj, key = 'amount') => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: numText(obj[key]), 'aria-label': 'Monto', disabled: obj.done || null });
    inp.addEventListener('input', () => { const v = M.evalAmount(inp.value); obj[key] = Number.isFinite(v) ? Math.abs(v) : 0; recalc(); });
    return inp;
  };
  const calc = () => M.payrollCalc(lines, p.deds.map(d => d.s), { uf: p.uf, utm: p.utm });
  function recalc() {
    const r = calc();
    const dedAmt = (i) => (done.has(p.deds[i].s.id) ? done.get(p.deds[i].s.id).amount : r.amounts[i]);
    // salud como en la liquidación: el 7% legal y, si el plan cuesta más, el adicional
    const legal7 = (d) => Math.round(Math.min(r.imponible, M.PAYROLL_TOPES.afpUF * p.uf) * ((d.s.calc || {}).pct || 7) / 100);
    fill(dedBox, p.deds.map((d, i) => h('div', { class: 'pay-row' },
      h('span', null, d.s.desc || (M.category(d.s.categoryId) || {}).name,
        (d.s.calc || {}).type === 'salud' && dedAmt(i) > legal7(d) ? h('small', { class: 'muted' }, ` · 7% ${M.fmt(legal7(d), base)} + adicional ${M.fmt(dedAmt(i) - legal7(d), base)}`) : null,
        done.has(d.s.id) ? h('small', { class: 'muted' }, ' · ya registrado') : null),
      h('span', { class: 'r' }, M.fmt(-dedAmt(i), base)))));
    const hab = lines.reduce((a, x) => a + (x.amount || 0), 0);
    const ded = p.deds.reduce((a, d, i) => a + dedAmt(i), 0) + extraDeds.reduce((a, x) => a + (x.amount || 0), 0);
    const ufTxt = `UF $${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p.uf)}`;
    fill(totals, h('div', { class: 'pay-row muted small' }, h('span', null, `Imponible ${M.fmt(r.imponible, base)} · base tributable ${M.fmt(r.base, base)}`),
      h('span', null, `${ufTxt}${ufEnd() ? ` (${fmtDay(M.monthEnd(ym))})` : updating ? ' (actualizando…)' : ''} · UTM ${M.fmt(p.utm, base)}${M.rateFor('UTM', date) ? '' : ' (estimada)'}`)),
      // sin la UF del último día del mes: se puede escribir la de la liquidación (aparece en ella)
      !ufEnd() && !updating ? h('div', { class: 'alloc-note' }, h('span', null, `Falta la UF del ${fmtDay(M.monthEnd(ym))}: se está usando ${ufTxt}. Puedes escribir la que aparece en tu liquidación.`),
        h('button', { type: 'button', class: 'btn small', onclick: async () => {
          const v = await promptDialog(`UF del ${fmtDay(M.monthEnd(ym))}`, { label: 'Valor de la UF', type: 'number', hint: 'Ej. 41.247,63' });
          const n = v == null ? NaN : M.parseAmount(v);
          if (!(n > 1000)) return;
          await FX.setManualRate('UF', M.monthEnd(ym), n);
          const fresh = M.payrollFor(ym); p.uf = fresh.uf; recalc();
        } }, 'Escribir UF')) : null,
      h('div', { class: 'pay-row strong' }, h('span', null, 'Líquido'), h('span', { class: 'r' }, M.fmt(hab - ded, base))));
  }
  function draw() {
    fill(box,
      h('h4', null, 'Haberes'),
      lines.map(x => h('div', { class: 'pay-row' },
        h('span', null, x.desc || (M.category(x.categoryId) || {}).name, h('small', { class: 'muted' }, x.imponible ? ' · imponible' : ' · no imponible'), x.done ? h('small', { class: 'muted' }, ' · ya registrado') : null),
        amountInput(x))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => addLine(true) }, '＋ Haber imponible (bono, aguinaldo)'),
        h('button', { type: 'button', class: 'btn small', onclick: () => addLine(false) }, '＋ No imponible')),
      h('h4', null, 'Descuentos (calculados)'), dedBox,
      extraDeds.map(x => h('div', { class: 'pay-row' }, h('span', null, x.desc), amountInput(x))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', onclick: addDed }, '＋ Otro descuento (ej. anticipo)')),
      totals);
    recalc();
  }
  const ask = (title, placeholder) => new Promise((resolve) => {
    const d = h('input', { type: 'text', placeholder, autocapitalize: 'sentences' });
    const q = modal(title, h('label', { class: 'field' }, h('span', null, 'Descripción'), d), {
      // se responde antes de cerrar: al cerrar, onClose responde "cancelado" (y la primera respuesta es la que vale)
      actions: [h('button', { class: 'btn', onclick: () => { resolve(null); q.close(); } }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => { resolve(d.value.trim() || placeholder); q.close(); } }, 'Agregar')],
      onClose: () => resolve(null),
    });
    setTimeout(() => d.focus(), 50);
  });
  async function addLine(imp) {
    const desc = await ask(imp ? 'Haber imponible' : 'Haber no imponible', imp ? 'Aguinaldo' : 'Bono no imponible');
    if (!desc) return;
    lines.push({ s: null, desc, amount: 0, imponible: imp, categoryId: catOf(imp) });
    draw();
  }
  async function addDed() {
    const desc = await ask('Otro descuento', 'Anticipo');
    if (!desc) return;
    extraDeds.push({ desc, amount: 0, categoryId: otherDedCat });
    draw();
  }
  draw();
  const m = modal(`Liquidación de ${M.monthName(ym).toLowerCase()}`, h('div', null,
    h('p', { class: 'muted small' }, `Ajusta los haberes o agrega uno (ej. un aguinaldo): los descuentos legales se recalculan como en la liquidación. Se registra el ${fmtDay(date)} en ${(M.account(first.accountId) || { name: 'sin cuenta' }).name}.`),
    box), {
    wide: true,
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: async () => {
        const r = calc();
        const mk = (o, extra) => ({ id: db.uid(), date, currency: base, accountId: first.accountId || null, paidBy: first.paidBy || M.ownerId(), alloc: 'none', ...o, ...extra });
        const txs = [];
        for (const x of lines) {
          if (x.done || !(x.amount > 0)) continue;
          txs.push(x.s ? { ...M.scheduleTx(x.s, ym), amount: x.amount } : mk({ kind: 'in', amount: x.amount, categoryId: x.categoryId, desc: x.desc }));
        }
        p.deds.forEach((d, i) => { if (!done.has(d.s.id) && r.amounts[i] > 0) txs.push({ ...M.scheduleTx(d.s, ym), amount: r.amounts[i] }); });
        for (const x of extraDeds) if (x.amount > 0) txs.push(mk({ kind: 'out', amount: x.amount, categoryId: x.categoryId, desc: x.desc }));
        // los programados del sueldo de este mes que quedaron en cero: se omiten (no se vuelven a pedir)
        for (const x of lines) if (x.s && !x.done && !(x.amount > 0)) await M.skipOccurrence(x.s, ym);
        await db.putMany('tx', txs);
        m.close();
        toast(`Liquidación registrada: ${txs.length} movimientos`, { label: 'Deshacer', onAction: () => db.delMany('tx', txs.map(t => t.id)), ms: 8000 });
      } }, 'Registrar liquidación')],
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
