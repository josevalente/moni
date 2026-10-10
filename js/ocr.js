// Texto de una imagen (foto o captura de un comprobante), leído en el propio teléfono: la imagen nunca sale
// del dispositivo. Usa Tesseract.js (código abierto) con el idioma español; se descarga la primera vez que se
// usa (~4 MB) y luego queda guardado en el teléfono (el idioma en IndexedDB y los scripts en la caché).
const LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
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

// onProgress(0..1) mientras lee
export async function imageText(blob, onProgress) {
  await loadLib();
  progress = onProgress || null;
  if (!worker) {
    worker = await window.Tesseract.createWorker('spa', 1, {
      logger: (m) => { if (progress && m.status === 'recognizing text') progress(m.progress); },
    });
  }
  const { data } = await worker.recognize(blob);
  return data.text || '';
}
