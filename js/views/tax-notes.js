// Puntos a revisar con el contador y documentos habituales para la declaración de renta de una persona natural
// en Chile (Formulario 22). Reglas generales verificadas para la Operación Renta 2026 (año comercial 2025) con
// fuentes del SII; los límites y las leyes cambian: revisar cada año. Sin datos de nadie: los montos vienen del
// resumen de cada persona.
import * as M from '../model.js';

const clp = (v) => M.fmt(v, 'CLP');
const nf1 = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 });

// `uta`: valor de la UTA de diciembre del año comercial (o null si no se pudo obtener)
export function taxNotes(t, uta) {
  const T = t.totals;
  const out = [];
  const inUTA = (v) => (uta ? `${nf1.format(v / uta)} UTA` : null);
  // intereses hipotecarios (Art. 55 bis)
  if (T.mortgageInterest > 0) {
    const cap = uta ? 8 * uta : null;
    const gross = T.salary;            // solo remuneraciones: "otros ingresos" puede traer traspasos o regalos que no son renta
    const tier = uta ? (gross / uta < 90 ? 'por tus remuneraciones registradas (bajo 90 UTA) correspondería completa' : gross / uta <= 150 ? 'por tus remuneraciones registradas (entre 90 y 150 UTA) correspondería en forma parcial' : 'por tus remuneraciones registradas (sobre 150 UTA) no correspondería') : null;
    out.push(`Rebaja por intereses de créditos hipotecarios (Art. 55 bis): pagaste ${clp(T.mortgageInterest)} en intereses${cap ? `; se rebaja el menor entre eso y 8 UTA (${clp(cap)})` : '; se rebaja hasta 8 UTA al año'}. Completa con renta bajo 90 UTA, parcial entre 90 y 150 UTA y nada sobre 150 UTA${tier ? `: ${tier}${inUTA(gross) ? ` (${inUTA(gross)})` : ''}` : ''}. El tope es por persona, no por propiedad. El banco lo informa con el certificado de intereses.`);
  }
  if (T.salary > 0) out.push(`Remuneraciones: el empleador emite el certificado (DJ 1887) con el total y el impuesto único retenido (${clp(T.taxWithheld)} según lo registrado). Si fue el único ingreso y no hubo otras rebajas, la declaración suele quedar en la propuesta del SII.`);
  const dap = t.investments.filter(x => /dep[oó]sito|\bdap\b/i.test(x.inv.name) && x.gainYear > 0);
  if (T.interest > 0 || dap.length) out.push(`Intereses de depósitos (Art. 41 bis): solo tributa el interés real (sobre la inflación), en el Global Complementario; el banco lo informa (DJ 1890). Si además de sueldo solo tuviste intereses y dividendos, están exentos hasta 20 UTM en total (Art. 57).`);
  if (T.dividend > 0) out.push('Dividendos de acciones chilenas: van al Global Complementario con su crédito por impuesto de primera categoría (certificado de la empresa o corredora). Dividendos de acciones de EE.UU.: son renta extranjera; con el formulario W-8BEN la retención en EE.UU. es 15% y se usa como crédito.');
  if (t.investments.some(x => Math.abs(x.realized) > 0.5)) out.push('Ventas de acciones o fondos: la ganancia de acciones con presencia bursátil paga un impuesto único de 10% que retiene la corredora (Art. 107, año comercial 2025); los rescates de fondos mutuos y las ventas de acciones extranjeras van al Global Complementario. Confirmar con el contador los cambios de la Ley 21.850 desde 2027.');
  if (T.rent > 0 || t.properties.some(x => x.rentIn)) out.push('Arriendos: se declaran en el Global Complementario (código 1849), por el monto del contrato y sin rebajar gastos. Las viviendas DFL-2 de hasta 140 m² están exentas solo para las 2 más antiguas.');
  if (t.properties.length) out.push('Bienes raíces: el contador puede pedir las escrituras (si son DFL-2), el avalúo fiscal y los recibos de contribuciones; las contribuciones no se rebajan de la renta de una persona.');
  if (t.accounts.some(x => x.foreign)) out.push('Cuentas en moneda extranjera: si alguna está en el extranjero, sus intereses se declaran (en pesos) y existe la declaración jurada DJ 1929 de inversiones y cuentas en el exterior (vence cerca del 30 de junio, con multa si se omite), aunque no hayan generado renta.');
  if (T.apv > 0) out.push('APV: en régimen A el Estado bonifica 15% (hasta 6 UTM al año); en régimen B se rebaja de la base, por planilla hasta 50 UF al mes o, si fue directo, hasta 600 UF al año (código 765, con el certificado N°24).');
  if (T.donation > 0) out.push('Donaciones: solo dan beneficio si la institución está acogida a una ley de donaciones y entrega su certificado.');
  out.push('Crédito por gastos en educación: 4,4 UF por cada hijo en educación preescolar, básica, especial o media reconocida, si la renta de ambos padres no supera 792 UF en el año.');
  if (t.income.some(r => r.group === 'extra')) out.push('Ingresos no recurrentes: una devolución de impuestos no es renta; herencias y donaciones recibidas tienen su propio impuesto y no van en la declaración de renta.');
  return out;
}

export const TAX_DOCS = [
  'Certificado de remuneraciones del empleador.',
  'Certificados de bancos: intereses de depósitos a plazo e intereses pagados de créditos hipotecarios.',
  'Certificados de la AFP o institución de APV (N°24) y de fondos mutuos.',
  'Corredoras: dividendos y ventas de acciones; para acciones de EE.UU., el resumen anual con la retención y el W-8BEN.',
  'Bancos en el extranjero: certificado anual de intereses y retenciones.',
  'Propiedades: escrituras, contratos de arriendo y lo recibido, avalúo fiscal y contribuciones.',
  'La declaración del año anterior.',
];

// Valor de la UTA de diciembre de un año (12 × UTM de diciembre), desde mindicador.cl; se guarda en el teléfono.
export async function utaOf(year) {
  const key = `moni.uta.${year}`;
  try { const v = Number(localStorage.getItem(key)); if (v) return v; } catch { /* ignore */ }
  try {
    const r = await fetch(`https://mindicador.cl/api/utm/${year}`, { signal: M.timeoutSignal(10000) });
    const j = await r.json();
    const dec = (j.serie || []).find(p => p.fecha.slice(5, 7) === '12') || null;
    if (!dec) return null;
    const uta = dec.valor * 12;
    try { localStorage.setItem(key, String(uta)); } catch { /* ignore */ }
    return uta;
  } catch { return null; }
}
