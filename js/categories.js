// Categorías de gasto y reglas para clasificar los movimientos del banco.
// Aquí solo hay reglas genéricas (comercios conocidos); las personales llegan con el análisis importado
// y se guardan en el móvil (state.rules).

export const CATEGORIES = {
  'Deudas': '💳',
  'Vivienda': '🏠',
  'Suscripciones': '📺',
  'Seguros': '🛡️',
  'Gimnasio': '🏋️',
  'Salud y cuidado': '🩺',
  'Cuotas': '🧾',
  'Telefonía': '📱',
  'Supermercado': '🛒',
  'Restaurantes y bares': '🍽️',
  'Comida a domicilio': '🛵',
  'Fiesta y conciertos': '🎉',
  'Compras': '🛍️',
  'Transporte': '🚕',
  'Viajes': '✈️',
  'Familia': '👪',
  'Lotería': '🎟️',
  'Efectivo': '💶',
  'Bizum': '📲',
  'Impuestos': '🏛️',
  'Nómina': '💼',
  'Ahorro': '🐷',
  'Otros': '📦',
};
export const CATEGORY_NAMES = Object.keys(CATEGORIES);
export const icon = cat => CATEGORIES[cat] || '📦';

// Categorías que ya están en los gastos fijos o no son gasto: no cuentan para el presupuesto del día a día
export const FIXED_CATEGORIES = ['Deudas', 'Vivienda', 'Suscripciones', 'Seguros', 'Gimnasio', 'Cuotas', 'Telefonía', 'Nómina', 'Ahorro', 'Impuestos'];
// Categorías del día a día a las que se les puede poner un tope
export const BUDGET_CATEGORIES = ['Supermercado', 'Restaurantes y bares', 'Fiesta y conciertos', 'Transporte', 'Compras',
  'Bizum', 'Comida a domicilio', 'Lotería', 'Viajes', 'Salud y cuidado', 'Familia', 'Otros'];

// [categoría, expresión] — la primera que coincide gana
const DEFAULT_RULES = [
  ['Nómina', /N[OÓ]MINA/],
  ['Bizum', /BIZUM/],
  ['Efectivo', /REINT|CAJERO|RETIRADA EFECTIVO/],
  ['Deudas', /PR[EÉ]STAMO|\bPRS\d|CR[EÉ]DITO|FINANCIACI|COFIDIS|CETELEM|KLARNA|APLAZAME|ONEY/],
  ['Suscripciones', /NETFLIX|SPOTIFY|APPLE\.COM|YOUTUBE|DISNEY|MICROSOFT|MOVISTAR PLUS|GOOGLE ONE|\bHBO|\bMAX\b|PRIME VIDEO|AD FREE FOR PRIME|DAZN|ANTHROPIC|OPENAI/],
  ['Seguros', /MAPFRE|MYBOX|SEGURO|MUTUA|AXA|ALLIANZ|SANITAS|ADESLAS/],
  ['Gimnasio', /BASIC.?FIT|GYM|FITNESS/],
  ['Telefonía', /SIMYO|MOVISTAR|VODAFONE|ORANGE|DIGI|LOWI|O2 /],
  ['Cuotas', /COMISSIO OBRER|CCOO|\bUGT\b|CUOTA SOCIO/],
  ['Supermercado', /MERCADONA|LIDL|ALCAMPO|CARREF|CRF EXPRESS|CONDIS|\bDIA\b(?! ?\d{1,2}\b)|CONSUM|BON PREU|ESCLAT|COVIRAN|SUPERMERCA|SUPERMARKET|ALDI|CAPRABO|EROSKI|AHORRAMAS|ALIMENTACI/],
  ['Comida a domicilio', /GLOVO|JUST ?EAT|UBER ?EATS|DELIVEROO/],
  ['Fiesta y conciertos', /FESTIVAL|FESTVAL|TOMORROWLAND|MEDUSA|TICKET|DICE\.FM|PAYLOGIC|RESIDENT ADVISOR|SALA |DISCOTECA|CASHLESS|CINES?\b|MULTICINES|OKTOBERFEST|SUTTON|SHOKO|APOLO|LUZ DE GAS/],
  ['Viajes', /HOTEL|BOOKING|AIRBNB|VUELING|RYANAIR|IBERIA|RENFE|TRAINLINE|PETIT PALACE|AEROPUER/],
  ['Transporte', /CABIFY|UBER|\bUBR\*|TAXI|METRO|TMB|MOBILITAT|BICING|MOTOSHAR|REPSOL|WAYLET|BENZINERA|ESCLATOIL|GASOLIN|CEPSA|GALP|SHELL|ESTACIONAMENT|PARKING|\bSABA\b|APPLUS|\bITV\b/],
  ['Compras', /AMAZON|ZARA|ZALANDO|ZALA NDO|DECATHLON|\bH&M|HM ES|LEFTIES|PRIMARK|PULL|BERSHKA|CORTE INGLES|DRUNI|SEPHORA|JACK AND JONES|TJX|SIVASDESCALZO|IKEA|MEDIA ?MARKT/],
  ['Salud y cuidado', /FARMACIA|PSICOLOG|CLINICA|DENTAL|OPTICA|PELUQUER/],
  ['Lotería', /LOTERO|LOTER[IÍ]A|ADMINISTRACION GI|APUESTA|BET365|CODERE/],
  ['Impuestos', /IMPUESTO|AJUNT|AYUNTAMIENTO|AGENCIA TRIBUTARIA|HACIENDA|DGT/],
  ['Restaurantes y bares', /\bREST|BAR\b|BARS?\s|CAFE|CAFETER|TAPAS|BURGER|MC.?DONALD|\bBK\d|TACOS|PIZZ|SUSHI|CERVECER|VERMUT|GASTRO|CHIRINGUITO|BODEGA|TABERNA|EUREST|CHURRER|HELADER/],
];

// Clasifica un movimiento {description, counterparty, amount}. Devuelve { category, label, fixed }.
// fixed = ya está contado en los gastos fijos (p. ej. un pago en efectivo ya previsto), así no se cuenta dos veces.
// Nombre de empresa (no de persona): S.L., S.A., banco, etc.
const COMPANY = /\b(S\.?\s?L\.?U?|S\.?\s?A\.?U?|S\.?\s?COOP|SPAIN|ESPA[ÑN]A|BANCO|BANK|LTD|GMBH|INC|SAS|SRL|SOCIEDAD|AYUNTAMIENTO|AJUNTAMENT|TESORERIA|AGENCIA)\b/;

// Un Bizum por la conexión del banco trae como descripción el concepto que escribe la otra persona.
// Se reconoce por: la palabra BIZUM en cualquier campo; el nombre de la persona enmascarado ("Nombre ***");
// la referencia de Bizum (un número de 30 cifras o más); o una transferencia de/hacia una persona sin comercio de tarjeta.
// Señales seguras: la palabra BIZUM, el nombre enmascarado o la referencia larga
export function surelyBizum(tx) {
  const all = `${tx.description || ''} ${tx.counterparty || ''} ${tx.code || ''} ${tx.note || ''} ${tx.reference || ''}`.toUpperCase();
  return /BIZUM/.test(all) || /\*{3}/.test(tx.counterparty || '')
    || [tx.reference, tx.id].some(r => /^\d{30,}$/.test(String(r || '').replace(/\s/g, '')));
}

export function looksLikeBizum(tx) {
  if (surelyBizum(tx)) return true;
  const name = (tx.counterparty || '').replace(/;/g, ' ').toUpperCase();
  const card = /TARJ|CARD|POS\b|CCRD|COMPRA/.test(`${tx.code || ''}`.toUpperCase());
  return Boolean(name) && !COMPANY.test(name) && !tx.mcc && !card && (tx.counterAccount || /TRANSF|TRF|ICDT|RCDT|PMNT/.test(`${tx.code || ''}`.toUpperCase()));
}

export function categorize(tx, rules = []) {
  // El banco manda los nombres como "NOMBRE;APELLIDO1;APELLIDO2": se cambia el ; por espacio para que las reglas coincidan
  const text = `${tx.description || ''} ${tx.counterparty || ''} ${tx.code || ''} ${tx.note || ''}`.replace(/;/g, ' ').toUpperCase();
  const abs = Math.round(Math.abs(Number(tx.amount) || 0) * 100) / 100;
  const matches = r => {
    try {
      return new RegExp(r.match, 'i').test(text)
        && (r.amount == null || Math.abs(r.amount - abs) < 0.005) && (r.min == null || abs >= r.min)
        && (r.dir == null || (r.dir === 'in') === (tx.amount > 0)); // dir: solo dinero que entra ('in') o que sale ('out')
    } catch { return false; } // regla mal escrita: se ignora
  };
  const result = r => ({
    category: r.category, label: r.label || null, fixed: Boolean(r.fixed) || FIXED_CATEGORIES.includes(r.category),
    charge: r.charge || null, // a qué gastos fijos "según banco" corresponde (p. ej. 80 € → consulta 60 + clase 20)
  });
  // Reglas "first": van incluso antes que el Bizum (p. ej. el Bizum de las plataformas, que se reparte a Spotify y Netflix)
  for (const r of rules) if (r.first && matches(r)) return result(r);
  // Un Bizum seguro va después: así su concepto ("Berlin", "cena"…) no se confunde con un comercio de tus reglas
  if (surelyBizum(tx)) return { category: 'Bizum', label: tx.amount > 0 ? 'Bizum recibido' : 'Bizum enviado', fixed: false };
  for (const r of rules) if (!r.first && matches(r)) return result(r);
  // Antes que las reglas por palabras: el concepto de un Bizum ("cena en el bar") no debe confundirse con un comercio
  if (looksLikeBizum(tx)) return { category: 'Bizum', label: tx.amount > 0 ? 'Bizum recibido' : 'Bizum enviado', fixed: false };
  for (const [category, re] of DEFAULT_RULES) {
    if (!re.test(text)) continue;
    // Dinero que entra con nombre de suscripción ("Netflix y Spotify") es alguien pagándote su parte, no un cargo
    if (category === 'Suscripciones' && tx.amount > 0) return { category: 'Bizum', label: 'Bizum recibido (suscripción compartida)', fixed: false };
    return { category, label: null, fixed: FIXED_CATEGORIES.includes(category) };
  }
  return { category: 'Otros', label: null, fixed: false };
}

// Lo gastado en el día a día por categoría y lo que te han devuelto por Bizum.
// Las devoluciones (p. ej. el descuento de Waylet) restan de su propia categoría.
// Reparte un importe entre gastos fijos: { consulta: 60, clase: 20 }, '*' = todo, 'rest' = lo que sobre,
// '50%' = la mitad (p. ej. el Bizum de las plataformas: mitad Spotify, mitad Netflix)
export function splitCharge(charge, abs) {
  const out = {};
  let used = 0;
  for (const [k, v] of Object.entries(charge)) if (typeof v === 'number') { out[k] = v; used += v; }
  for (const [k, v] of Object.entries(charge)) {
    if (v === '*') out[k] = abs;
    else if (typeof v === 'string' && v.endsWith('%')) out[k] = Math.round(abs * parseFloat(v)) / 100;
    else if (v === 'rest') out[k] = Math.max(0, Math.round((abs - used) * 100) / 100);
  }
  return out;
}

export function spendByCategory(list) {
  const byCat = {}, byDay = {}, bizumByDay = {};
  const fixedCharges = []; // lo que ha salido para gastos fijos "según banco" { date, key, amount }
  const oneOffs = [];      // puntuales detectados en el banco (impuestos, Hacienda…) { date, amount, concept }
  const seen = [];         // cargos que pueden ser un gasto fijo sin regla propia, para marcarlo en Revisar { date, amount, text, fixed }
  const add = (obj, key, v) => { obj[key] = Math.round(((obj[key] || 0) + v) * 100) / 100; };
  let bizumIn = 0;
  for (const t of list) {
    if (t.amount < 0 && !t.charge && t.date && t.category !== 'Impuestos') {
      const text = `${t.description || ''} ${t.counterparty || ''}`.replace(/;/g, ' ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().slice(0, 120);
      seen.push({ date: t.date, amount: Math.round(-(t.original ?? t.amount) * 100) / 100, text, fixed: Boolean(t.fixed) });
    }
    if (t.category === 'Impuestos') {
      oneOffs.push({ date: t.date, amount: t.amount, concept: t.label || t.description || 'Impuestos' });
      continue;
    }
    if (t.fixed) {
      // Lo que sale suma al fijo; lo que entra (te devuelven tu parte) resta
      if (t.charge && t.amount) {
        const sign = t.amount < 0 ? 1 : -1;
        for (const [key, amount] of Object.entries(splitCharge(t.charge, Math.abs(t.amount)))) fixedCharges.push({ date: t.date, key, amount: sign * amount });
      }
      continue;
    }
    if (t.category === 'Bizum' && t.amount > 0) {
      bizumIn += t.amount;
      if (t.date) add(bizumByDay, t.date, t.amount);
      continue;
    }
    if (t.amount > 0 && !BUDGET_CATEGORIES.includes(t.category)) continue; // ingresos que no son devoluciones
    add(byCat, t.category, -t.amount);
    if (t.date) add(byDay, t.date, -t.amount); // gasto del día a día por fecha
  }
  return { byCat, byDay, bizumByDay, fixedCharges, oneOffs, seen, bizumIn: Math.round(bizumIn * 100) / 100 };
}
