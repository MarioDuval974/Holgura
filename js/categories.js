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
  'Efectivo', 'Bizum', 'Comida a domicilio', 'Lotería', 'Viajes', 'Salud y cuidado', 'Familia', 'Otros'];

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
  ['Supermercado', /MERCADONA|LIDL|ALCAMPO|CARREF|CRF EXPRESS|CONDIS|\bDIA\b|CONSUM|BON PREU|ESCLAT|COVIRAN|SUPERMERCA|SUPERMARKET|ALDI|CAPRABO|EROSKI|AHORRAMAS|ALIMENTACI/],
  ['Comida a domicilio', /GLOVO|JUST ?EAT|UBER ?EATS|DELIVEROO/],
  ['Fiesta y conciertos', /FESTIVAL|FESTVAL|TOMORROWLAND|MEDUSA|TICKET|DICE\.FM|PAYLOGIC|RESIDENT ADVISOR|SALA |DISCOTECA|CASHLESS|CINES?\b|MULTICINES|OKTOBERFEST|SUTTON|SHOKO|APOLO|LUZ DE GAS/],
  ['Viajes', /HOTEL|BOOKING|AIRBNB|VUELING|RYANAIR|IBERIA|RENFE|TRAINLINE|PETIT PALACE|AEROPUER/],
  ['Transporte', /CABIFY|UBER|\bUBR\*|TAXI|METRO|TMB|MOBILITAT|BICING|MOTOSHAR|REPSOL|WAYLET|BENZINERA|ESCLATOIL|GASOLIN|CEPSA|GALP|SHELL|ESTACIONAMENT|PARKING|\bSABA\b|APPLUS|ITV/],
  ['Compras', /AMAZON|ZARA|ZALANDO|ZALA NDO|DECATHLON|\bH&M|HM ES|LEFTIES|PRIMARK|PULL|BERSHKA|CORTE INGLES|DRUNI|SEPHORA|JACK AND JONES|TJX|SIVASDESCALZO|IKEA|MEDIA ?MARKT/],
  ['Salud y cuidado', /FARMACIA|PSICOLOG|CLINICA|DENTAL|OPTICA|PELUQUER/],
  ['Lotería', /LOTERO|LOTER[IÍ]A|ADMINISTRACION GI|APUESTA|BET365|CODERE/],
  ['Impuestos', /IMPUESTO|AJUNT|AYUNTAMIENTO|AGENCIA TRIBUTARIA|HACIENDA|DGT/],
  ['Restaurantes y bares', /REST|BAR\b|BARS?\s|CAFE|CAFETER|TAPAS|BURGER|MC.?DONALD|\bBK\d|TACOS|PIZZ|SUSHI|CERVECER|VERMUT|GASTRO|CHIRINGUITO|BODEGA|TABERNA|EUREST|CHURRER|HELADER/],
];

// Clasifica un movimiento {description, counterparty, amount}. Devuelve { category, label, fixed }.
// fixed = ya está contado en los gastos fijos (p. ej. el efectivo de la psicóloga), así no se cuenta dos veces.
export function categorize(tx, rules = []) {
  const text = `${tx.description || ''} ${tx.counterparty || ''}`.toUpperCase();
  const abs = Math.round(Math.abs(Number(tx.amount) || 0) * 100) / 100;
  for (const r of rules) {
    try {
      if (new RegExp(r.match, 'i').test(text) && (r.amount == null || Math.abs(r.amount - abs) < 0.005)) {
        return { category: r.category, label: r.label || null, fixed: Boolean(r.fixed) || FIXED_CATEGORIES.includes(r.category) };
      }
    } catch { /* regla mal escrita: se ignora */ }
  }
  for (const [category, re] of DEFAULT_RULES) if (re.test(text)) return { category, label: null, fixed: FIXED_CATEGORIES.includes(category) };
  return { category: 'Otros', label: null, fixed: false };
}

// Lo gastado en el día a día por categoría (solo salidas) y lo que te han devuelto por Bizum
export function spendByCategory(list) {
  const byCat = {};
  let bizumIn = 0;
  for (const t of list) {
    if (t.fixed) continue;
    if (t.amount < 0) byCat[t.category] = Math.round(((byCat[t.category] || 0) - t.amount) * 100) / 100;
    else if (t.category === 'Bizum') bizumIn += t.amount;
  }
  return { byCat, bizumIn: Math.round(bizumIn * 100) / 100 };
}
