// Persistencia: todo se guarda en el propio dispositivo (localStorage). Nada sale del móvil.

const KEY = 'holgura.v1';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function defaultState() {
  return {
    version: 1,
    setup: false,
    settings: {
      cycleType: 'nomina',      // 'nomina' (de nómina a nómina) | 'natural' (del 1 al último día)
      payDay: 27,
      salary: 0,
      fixedMode: 'desglose',    // 'total' | 'desglose'
      fixedTotal: 0,
      fixedItems: [],           // { id, name, amount, day }
      checkFreq: { type: 'semanal', every: 3, weekday: 0, monthDay: 1 },
      reminderTime: '21:00',
      safetyPct: 15,
      allowanceView: 'dia',     // ver lo que puedes gastar 'dia' | 'semana'
      weekendMode: 'auto',      // 'auto' (lo aprende de las revisiones) | 'manual'
      weekendFactor: 2,         // un día de fin de semana gasta como N días entre semana (en auto, punto de partida)
      fridayWeekend: false,
      budgets: {},              // tope por categoría del día a día para cada ciclo { 'Supermercado': 150, … }
      bizumTo: 'Restaurantes y bares', // los Bizum que te devuelven se restan de esta categoría ('' = aparte)
    },
    cycle: null,                // { id, start, startBalance, income, fixedTotal, fixedItems, savingsGoal }
    checkins: [],               // { id, cycleId, date, balance, pendingFixed, pendingIds, trackedChecked, extraIncome }
    history: [],                // ciclos cerrados (ver calc.closeCycle)
    jars: [],                   // { id, name, emoji, goal }
    moves: [],                  // { id, jarId, date, type: 'in'|'out', amount, note, account, cycleId }
    rules: [],                  // reglas personales para clasificar movimientos { match, amount?, category, label? }
    analysis: null,             // resumen del análisis importado { period, categories, notes, importedAt }
    bankSpend: null,            // último gasto por categoría leído del banco { cycleId, at, byCat, bizumIn }
    lastBalance: null,          // último saldo informado (escrito o traído del banco) { amount, at, source: 'manual'|'bank' }
    adjustments: [],            // movimientos en los que solo cuenta una parte { key, date, amount, counted, note }
  };
}

// ---------- Normalizar datos (los guardados y las copias importadas) ----------

const LISTS = ['checkins', 'history', 'jars', 'moves', 'rules', 'adjustments'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[\w-]{1,40}$/; // los ids van dentro de atributos HTML: solo letras, números, _ y -
const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v.filter(isObj) : []);
const num = (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const oneOf = (v, options, d) => (options.includes(v) ? v : d);

// Rellena lo que falte y corrige tipos, para que una copia incompleta no deje la app sin poder abrirse
function normalize(data) {
  const base = defaultState(), b = base.settings;
  const s = { ...b, ...(isObj(data.settings) ? data.settings : {}) };
  const out = { ...base, ...data, settings: s };
  for (const k of LISTS) out[k] = list(out[k]);

  s.salary = Math.max(0, num(s.salary, 0));
  s.payDay = Math.min(31, Math.max(1, Math.round(num(s.payDay, b.payDay))));
  s.fixedTotal = Math.max(0, num(s.fixedTotal, 0));
  s.safetyPct = num(s.safetyPct, b.safetyPct);
  s.weekendFactor = num(s.weekendFactor, b.weekendFactor);
  s.cycleType = oneOf(s.cycleType, ['nomina', 'natural'], b.cycleType);
  s.fixedMode = oneOf(s.fixedMode, ['total', 'desglose'], b.fixedMode);
  s.allowanceView = oneOf(s.allowanceView, ['dia', 'semana'], b.allowanceView);
  s.weekendMode = oneOf(s.weekendMode, ['auto', 'manual'], b.weekendMode);
  s.reminderTime = /^\d{2}:\d{2}$/.test(s.reminderTime) ? s.reminderTime : b.reminderTime;
  const f = { ...b.checkFreq, ...(isObj(s.checkFreq) ? s.checkFreq : {}) };
  s.checkFreq = {
    type: oneOf(f.type, ['diaria', 'cadaX', 'semanal', 'mensual'], b.checkFreq.type),
    every: Math.max(1, num(f.every, b.checkFreq.every)),
    weekday: Math.min(6, Math.max(0, num(f.weekday, b.checkFreq.weekday))),
    monthDay: Math.min(28, Math.max(1, num(f.monthDay, b.checkFreq.monthDay))),
  };
  s.fixedItems = list(s.fixedItems).map(i => ({ ...i, amount: num(i.amount, 0) }));
  s.budgets = isObj(s.budgets) ? s.budgets : {};

  // Sin un ciclo válido no se puede pintar nada: se vuelve al asistente (huchas e historial se conservan)
  const c = out.cycle;
  if (isObj(c) && DATE.test(c.start)) {
    out.cycle = {
      ...c, startBalance: num(c.startBalance, 0), income: num(c.income, 0), fixedTotal: num(c.fixedTotal, 0),
      fixedItems: list(c.fixedItems).map(i => ({ ...i, amount: num(i.amount, 0) })), extras: list(c.extras),
    };
  } else {
    out.cycle = null;
    out.setup = false;
  }
  out.checkins = out.checkins.filter(k => DATE.test(k.date));
  out.moves = out.moves.filter(m => DATE.test(m.date)).map(m => ({ ...m, amount: num(m.amount, 0) }));
  return out;
}

// Todos los ids de una copia: si alguno trae caracteres raros, la copia está manipulada o rota
function badIds(d) {
  const ids = [
    d.cycle?.id, ...(d.cycle?.fixedItems || []).map(i => i.id), ...(d.cycle?.extras || []).map(e => e.id),
    ...d.settings.fixedItems.map(i => i.id), ...d.jars.map(j => j.id), ...d.history.map(h => h.id),
    ...d.moves.flatMap(m => [m.id, m.jarId, m.cycleId, m.carry]), ...d.checkins.flatMap(k => [k.id, k.cycleId, ...(k.pendingIds || [])]),
  ];
  return ids.some(id => id != null && typeof id !== 'boolean' && !ID.test(String(id)));
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    return isObj(data) ? normalize(data) : defaultState();
  } catch {
    return defaultState();
  }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function importData(text) {
  const invalid = () => new Error('El archivo no es una copia de seguridad de Holgura');
  let data;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (!isObj(data) || !isObj(data.settings) || !Array.isArray(data.jars)) throw invalid();
  const out = normalize(data);
  if (badIds(out)) throw new Error('La copia de seguridad tiene datos no válidos');
  return out;
}

export function clearAll() {
  localStorage.removeItem(KEY);
}
