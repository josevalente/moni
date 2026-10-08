// Precios de la Bolsa de Santiago para Moni: lo corre GitHub Actions (ver ../workflows/precios.yml) y
// publica santiago.json en la rama "precios". La app lo lee desde raw.githubusercontent.com, que sí permite
// consultarlo desde el teléfono (Yahoo Finance no). La lista es de acciones del mercado, no de una cartera.
//   node santiago.mjs <anterior.json> <salida.json>
import fs from 'node:fs';

const SYMBOLS = `AGUAS-A ANDINA-A ANDINA-B BCI BESALCO BLUMAR BSANTANDER CAMANCHACA CAP CCU CENCOMALLS CENCOSUD
CFIETFIPSA CFMITNIPSA CHILE CMPC COLBUN CONCHATORO COPEC CRISTALES CUPRUM ECL EMBONOR-B ENELAM ENELCHILE ENTEL
FALABELLA FORUS HABITAT HITES IAM ILC INGEVEC ITAUCL LTM MALLPLAZA MASISA MOLYMET PARAUCO PAZ PLANVITAL PROVIDA
QUINENCO RIPLEY SALFACORP SMSAAM SMU SOCOVESA SONDA SQM-A SQM-B TRICOT VAPORES VSPT WATTS ZOFRI`.split(/\s+/);

const [prevPath, outPath] = process.argv.slice(2);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')).prices || {}; } catch { /* primera vez */ }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dayIn = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(ts * 1000));

async function get(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.SN?range=10y&interval=1mo`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Moni precios)' } });
      if (r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = (await r.json()).chart.result[0];
      const m = res.meta;
      if (!Number.isFinite(m.regularMarketPrice)) throw new Error('sin precio');
      const date = dayIn(m.regularMarketTime);
      const months = {};
      (res.timestamp || []).forEach((t, i) => {
        const c = res.indicators.quote[0].close[i];
        const ym = dayIn(t).slice(0, 7);
        if (Number.isFinite(c) && ym < date.slice(0, 7)) months[ym] = Math.round(c * 1e4) / 1e4;   // meses cerrados
      });
      return { name: m.longName || m.shortName || symbol, currency: m.currency || 'CLP', price: m.regularMarketPrice, date, months };
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500);
    }
  }
  throw new Error('límite de consultas');
}

const prices = {};
let ok = 0;
for (const s of SYMBOLS) {
  try { prices[s] = await get(s); ok++; } catch (e) {
    console.log(`${s}: ${e.message}${prev[s] ? ' (se mantiene el anterior)' : ''}`);
    if (prev[s]) prices[s] = prev[s];
  }
  await sleep(250);
}
if (!ok) { console.error('Yahoo no respondió: no se publica nada'); process.exit(1); }
fs.writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString(), source: 'Yahoo Finance', prices }));
console.log(`${ok} de ${SYMBOLS.length} precios actualizados`);
