// Helpers de interfaz: creación de nodos, modales, formularios, avisos.
import { parseAmount } from './model.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---- Aviso breve ---------------------------------------------------------
let toastTimer;
export function toast(msg, { label, onAction, ms = 4000 } = {}) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.replaceChildren(h('span', null, msg), label ? h('button', { class: 'link', onclick: () => { onAction && onAction(); t.classList.remove('show'); } }, label) : null);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- Modales ---------------------------------------------------------------
export function modal(title, body, { actions, wide, onClose } = {}) {
  const back = h('div', { class: 'backdrop' });
  const close = () => { back.remove(); document.body.classList.remove('noscroll'); onClose && onClose(); };
  const sheet = h('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('header', null,
      h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, body),
    actions ? h('footer', null, actions) : null);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.append(sheet);
  document.body.append(back);
  document.body.classList.add('noscroll');
  return { close, sheet, back };
}

export function confirmDialog(message, { ok = 'Eliminar', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal('Confirmar', h('p', null, message), {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancelar'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, ok),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog(title, { label, value = '', type = 'text', hint } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type, value, inputmode: type === 'number' ? 'decimal' : null });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(title, h('label', { class: 'field' }, h('span', null, label || ''), input, hint ? h('small', null, hint) : null), {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => finish(input.value) }, 'Aceptar'),
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => input.focus(), 50);
  });
}

// ---- Formularios declarativos -----------------------------------------------
// fields: [{key,label,type:'text|number|date|month|select|check|textarea|custom',options,hint,placeholder,build}]
export function formModal({ title, fields, value = {}, onSave, onDelete, saveLabel = 'Guardar', extra }) {
  const getters = {};
  const rows = fields.map((f) => {
    if (f.show && !f.show(value)) return null;
    let input, get;
    const v = value[f.key];
    if (f.type === 'select') {
      input = h('select', null, (typeof f.options === 'function' ? f.options(value) : f.options).map(o =>
        h('option', { value: o.v, selected: String(o.v) === String(v ?? '') }, o.l)));
      get = () => input.value;
    } else if (f.type === 'check') {
      input = h('input', { type: 'checkbox', checked: !!v });
      get = () => input.checked;
      return h('label', { class: 'field check' }, input, h('span', null, f.label), f.hint ? h('small', null, f.hint) : null);
    } else if (f.type === 'textarea') {
      input = h('textarea', { rows: 3, placeholder: f.placeholder || '' }, v ?? '');
      get = () => input.value;
    } else if (f.type === 'custom') {
      const c = f.build(v, value);
      input = c.el; get = c.get;
    } else {
      input = h('input', {
        type: f.type === 'number' ? 'text' : (f.type || 'text'), value: v ?? '', placeholder: f.placeholder || '',
        inputmode: f.type === 'number' ? 'decimal' : null, list: f.list || null, autocapitalize: f.type === 'text' ? 'sentences' : null,
      });
      get = () => (f.type === 'number' ? (input.value.trim() === '' ? null : parseNum(input.value)) : input.value.trim());
    }
    getters[f.key] = get;
    return h('label', { class: 'field' }, h('span', null, f.label), input, f.hint ? h('small', null, f.hint) : null);
  });
  const save = async () => {
    const out = { ...value };
    for (const f of fields) if (getters[f.key]) out[f.key] = getters[f.key]();
    for (const f of fields) {
      if (f.required && (out[f.key] == null || out[f.key] === '' || Number.isNaN(out[f.key]))) { toast(`Falta: ${f.label}`); return; }
    }
    await onSave(out);
    m.close();
  };
  const m = modal(title, h('form', { onsubmit: (e) => { e.preventDefault(); save(); } }, rows, extra), {
    actions: [
      onDelete ? h('button', { class: 'btn danger ghost', onclick: async () => { if (await confirmDialog('¿Eliminar este registro?')) { await onDelete(value); m.close(); } } }, 'Eliminar') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: save }, saveLabel),
    ],
  });
  return m;
}

export const parseNum = parseAmount;

// ---- Descarga de archivos -----------------------------------------------------
export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const file = typeof File !== 'undefined' ? new File([blob], filename, { type }) : null;
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return file;
}

export async function shareFile(filename, text, type = 'application/json') {
  const file = new File([text], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
  }
  download(filename, text, type);
  return false;
}

// ---- Gráfico de barras simple (CSS) ---------------------------------------------
export function bars(rows, { fmt, max } = {}) {
  const mx = max ?? Math.max(1, ...rows.map(r => Math.abs(r.v)));
  return h('div', { class: 'bars' }, rows.map(r => h('div', { class: 'bar-row', onclick: r.onclick },
    h('div', { class: 'bar-label' }, r.label),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: Math.max(2, Math.abs(r.v) / mx * 100) + '%' } })),
    h('div', { class: 'bar-val' }, fmt ? fmt(r.v) : r.v))));
}
