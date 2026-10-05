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

// Reemplaza los hijos de un nodo aceptando listas anidadas y descartando null/false
// (replaceChildren nativo dibuja "null" y "[object HTMLElement]" como texto).
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
}

// ---- Aviso breve ---------------------------------------------------------
let toastTimer;
export function toast(msg, { label, onAction, ms = 4000 } = {}) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  fill(t, h('span', null, msg), label ? h('button', { class: 'link', onclick: () => { onAction && onAction(); t.classList.remove('show'); } }, label) : null);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- Modales ---------------------------------------------------------------
// dismissable: tocar fuera (o Escape) cierra. Los formularios lo desactivan para no perder lo escrito
// (en iPhone es común tocar fuera para bajar el teclado).
let openModals = 0;
let modalSeq = 0;
export function modal(title, body, { actions, wide, onClose, dismissable = true } = {}) {
  const back = h('div', { class: 'backdrop' });
  const prevFocus = document.activeElement;
  const titleId = 'modal-title-' + (++modalSeq);
  const vv = window.visualViewport;
  // con el teclado abierto iOS no achica la pantalla: se ajusta al área visible para que el pie
  // (Guardar) quede sobre el teclado
  const fit = () => { if (vv) { back.style.height = vv.height + 'px'; back.style.top = vv.offsetTop + 'px'; } };
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && dismissable && [...document.querySelectorAll('.backdrop')].at(-1) === back) close(); };
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
    document.removeEventListener('keydown', onKey);
    openModals = Math.max(0, openModals - 1);
    if (!openModals) document.body.classList.remove('noscroll');
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose();
  };
  const sheet = h('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', null,
      h('h2', { id: titleId }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, body),
    actions ? h('footer', null, actions) : null);
  if (dismissable) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  back.append(sheet);
  document.body.append(back);
  openModals++;
  document.body.classList.add('noscroll');
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
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
    // Los montos van en un input de texto: el input numérico nativo rechaza la coma decimal.
    const input = h('input', { type: type === 'number' ? 'text' : type, value, inputmode: type === 'number' ? 'decimal' : null, autocomplete: 'off' });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(title, h('form', { onsubmit: (e) => { e.preventDefault(); finish(input.value); } },
      h('label', { class: 'field' }, h('span', null, label || ''), input, hint ? h('small', null, hint) : null)), {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => finish(input.value) }, 'Aceptar'),
      ],
      onClose: () => finish(null),
      dismissable: false,
    });
    input.focus();   // dentro del mismo toque: así iOS abre el teclado
  });
}

// ---- Formularios declarativos -----------------------------------------------
// fields: [{key,label,type:'text|number|date|month|select|check|textarea|custom',options,hint,placeholder,build}]
// Los campos con `show(valores)` aparecen o se ocultan según lo que se va eligiendo en el formulario.
export function formModal({ title, fields, value = {}, onSave, onDelete, saveLabel = 'Guardar', extra }) {
  const getters = {};
  const rowOf = {};
  const rows = fields.map((f) => {
    let input, get, row;
    const v = value[f.key];
    if (f.type === 'select') {
      input = h('select', null, (typeof f.options === 'function' ? f.options(value) : f.options).map(o =>
        h('option', { value: o.v, selected: String(o.v) === String(v ?? '') }, o.l)));
      get = () => input.value;
    } else if (f.type === 'check') {
      input = h('input', { type: 'checkbox', checked: !!v });
      get = () => input.checked;
      row = h('label', { class: 'field check' }, input, h('span', null, f.label), f.hint ? h('small', null, f.hint) : null);
    } else if (f.type === 'textarea') {
      input = h('textarea', { rows: 3, placeholder: f.placeholder || '' }, v ?? '');
      get = () => input.value;
    } else if (f.type === 'custom') {
      const c = f.build(v, value);
      input = c.el; get = c.get;
    } else {
      // número precargado con coma decimal: "0.125" se leería como miles
      const shown = f.type === 'number' && typeof v === 'number' ? String(v).replace('.', ',') : (v ?? '');
      const inp = h('input', {
        type: f.type === 'number' ? 'text' : (f.type || 'text'), value: shown, placeholder: f.placeholder || '',
        inputmode: f.type === 'number' ? 'decimal' : null, list: f.list || null, autocapitalize: f.type === 'text' ? 'sentences' : null,
        autocomplete: 'off',
      });
      get = () => (f.type === 'number' ? (inp.value.trim() === '' ? null : parseNum(inp.value)) : inp.value.trim());
      input = inp;
      if (f.signed) {
        // el teclado decimal del iPhone no tiene signo menos: botón ± para cambiarlo
        const flip = h('button', { type: 'button', class: 'btn sign', 'aria-label': 'Cambiar signo', onclick: () => {
          const t = inp.value.trim();
          inp.value = t.startsWith('-') ? t.slice(1) : '-' + t;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } }, '±');
        input = h('div', { class: 'signed' }, inp, flip);
      }
    }
    getters[f.key] = get;
    row = row || h('label', { class: 'field' }, h('span', null, f.label), input, f.hint ? h('small', null, f.hint) : null);
    rowOf[f.key] = row;
    return row;
  });
  const current = () => {
    const out = { ...value };
    for (const f of fields) if (getters[f.key]) out[f.key] = getters[f.key]();
    return out;
  };
  const refreshShow = () => {
    const cur = current();
    for (const f of fields) if (f.show) rowOf[f.key].hidden = !f.show(cur);
  };
  let saving = false;
  const save = async () => {
    if (saving) return;
    const out = current();
    for (const f of fields) {
      if (f.show && !f.show(out)) continue;
      const val = out[f.key];
      if (f.required && (val == null || val === '' || Number.isNaN(val))) { toast(`Falta: ${f.label}`); return; }
      if (f.type === 'number' && Number.isNaN(val)) { toast(`Número no válido: ${f.label}`); return; }
    }
    saving = true;
    try { if ((await onSave(out)) !== false) m.close(); } finally { saving = false; }
  };
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); save(); } }, rows, extra);
  form.addEventListener('input', refreshShow);
  form.addEventListener('change', refreshShow);
  refreshShow();
  const m = modal(title, form, {
    actions: [
      onDelete ? h('button', { class: 'btn danger ghost', onclick: async () => { if (await confirmDialog('¿Eliminar este registro?')) { await onDelete(value); m.close(); } } }, 'Eliminar') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: save }, saveLabel),
    ],
    dismissable: false,
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
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  download(filename, text, type);
  return true;   // true = compartido o descargado; false = la persona canceló
}

// ---- Gráfico de barras simple (CSS) ---------------------------------------------
export function bars(rows, { fmt, max } = {}) {
  const mx = max ?? Math.max(1, ...rows.map(r => Math.abs(r.v)));
  return h('div', { class: 'bars' }, rows.map(r => h('div', { class: 'bar-row', onclick: r.onclick },
    h('div', { class: 'bar-label' }, r.label),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: Math.max(2, Math.abs(r.v) / mx * 100) + '%' } })),
    h('div', { class: 'bar-val' }, fmt ? fmt(r.v) : r.v))));
}
