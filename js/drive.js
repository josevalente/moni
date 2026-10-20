// Copia diaria del respaldo en Google Drive, en la carpeta "Moni respaldos" de tu cuenta. Usa el permiso más
// acotado de Google (drive.file): Moni solo ve y toca los archivos que ella misma creó, nada más de tu Drive.
// Necesita un "ID de cliente" de Google (gratis, una vez; se guarda solo en este teléfono). El iPhone no deja que
// una app web suba archivos sola en segundo plano: al abrir Moni, si hoy no hay copia, se hace con un toque.
const GIS = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const KEY = 'moni.gdrive';
const FOLDER = 'Moni respaldos';
const KEEP = 30;                         // copias que se conservan; las más antiguas van a la papelera de Drive

export const config = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
export const setConfig = (patch) => { const c = { ...config(), ...patch }; try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ } return c; };
export const clearConfig = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } token = null; };
export const enabled = () => !!config().clientId;
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const dueToday = () => enabled() && (!config().lastAt || day(config().lastAt) !== day(Date.now()));

let token = null, tokenExp = 0;
const tokenOk = () => token && Date.now() < tokenExp;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS; s.async = true;
    s.onload = () => resolve(); s.onerror = () => { s.remove(); reject(new Error('offline')); };
    document.head.append(s);
  });
}

// Pide (o reutiliza) el permiso. La primera vez abre la ventana de Google; debe llamarse desde un toque.
export async function connect() {
  if (tokenOk()) return token;
  const { clientId, granted } = config();
  if (!clientId) throw new Error('Falta el ID de cliente');
  await loadGis();
  return new Promise((resolve, reject) => {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || 'sin permiso'));
        token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
        setConfig({ granted: true });
        resolve(token);
      },
      error_callback: (e) => reject(new Error((e && e.message) || (e && e.type) || 'ventana cerrada')),
    });
    tc.requestAccessToken({ prompt: granted ? '' : 'consent' });
  });
}
export function disconnect() {
  const t = token;
  clearConfig();
  try { if (t && window.google) window.google.accounts.oauth2.revoke(t, () => {}); } catch { /* ignore */ }
}

async function api(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const r = await fetch(`https://www.googleapis.com/${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined });
  if (r.status === 401) { token = null; throw new Error('El permiso de Google venció: vuelve a intentarlo'); }
  if (!r.ok) throw new Error(`Google Drive respondió ${r.status}`);
  return raw ? r : r.json();
}

async function folderId() {
  const c = config();
  if (c.folderId) return c.folderId;
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api(`drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  const id = (found.files && found.files[0] && found.files[0].id)
    || (await api('drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).id;
  setConfig({ folderId: id });
  return id;
}

// Sube el respaldo (texto JSON) como moni-respaldo-AAAA-MM-DD.json y deja solo las últimas KEEP copias.
export async function upload(json) {
  await connect();
  const parent = await folderId();
  const name = `moni-respaldo-${day(Date.now())}.json`;
  const boundary = 'moni' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: 'application/json' })}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  const f = await api('upload/drive/v3/files?uploadType=multipart&fields=id,name', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  setConfig({ lastAt: Date.now(), lastName: f.name });
  try { await prune(parent); } catch { /* la limpieza puede esperar */ }
  return f;
}

async function prune(parent) {
  const list = await backups(parent);
  for (const f of list.slice(KEEP)) await api(`drive/v3/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}

// Copias en la carpeta, de la más nueva a la más antigua
export async function backups(parent) {
  await connect();
  const p = parent || await folderId();
  const q = encodeURIComponent(`'${p}' in parents and trashed=false`);
  const r = await api(`drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=100`);
  return r.files || [];
}
export async function download(id) {
  await connect();
  const r = await api(`drive/v3/files/${id}?alt=media`, { raw: true });
  return r.text();
}
