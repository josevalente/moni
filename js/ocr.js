// Texto de una imagen (foto o captura de un comprobante), leído en el propio teléfono: la imagen nunca sale
// del dispositivo. Usa Tesseract.js (código abierto) con el idioma español; se descarga la primera vez que se
// usa (~4 MB) y luego queda guardado en el teléfono (el idioma en IndexedDB y los scripts en la caché).
const LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_SIDE = 2000;          // más grande no mejora la lectura y la hace lenta
let worker = null;
let progress = null;

function loadLib() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('offline')); };
    document.head.append(s);
  });
}

// Cualquier imagen que entregue el teléfono (PNG, JPEG, HEIC de Fotos…) a PNG de tamaño razonable: el navegador
// la decodifica y se redibuja en un canvas.
async function toPng(blob) {
  let img, w, h;
  try { img = await createImageBitmap(blob); w = img.width; h = img.height; } catch {
    const url = URL.createObjectURL(blob);
    try {
      img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      w = img.naturalWidth; h = img.naturalHeight;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);      // capturas con transparencia: fondo blanco
  g.drawImage(img, 0, 0, cv.width, cv.height);
  return new Promise((resolve) => cv.toBlob((b) => resolve(b || blob), 'image/png'));
}

// onProgress(0..1) mientras lee
export async function imageText(blob, onProgress) {
  const png = await toPng(blob).catch(() => blob);
  await loadLib();
  progress = onProgress || null;
  if (!worker) {
    worker = await window.Tesseract.createWorker('spa', 1, {
      logger: (m) => { if (progress && m.status === 'recognizing text') progress(m.progress); },
    });
  }
  const { data } = await worker.recognize(png);
  return data.text || '';
}
