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
    },
    cycle: null,                // { id, start, startBalance, income, fixedTotal, fixedItems, savingsGoal }
    checkins: [],               // { id, cycleId, date, balance, pendingFixed, pendingIds, extraIncome }
    history: [],                // ciclos cerrados (ver calc.closeCycle)
    jars: [],                   // { id, name, emoji, goal }
    moves: [],                  // { id, jarId, date, type: 'in'|'out', amount, note, account, cycleId }
    rules: [],                  // reglas personales para clasificar movimientos { match, amount?, category, label? }
    analysis: null,             // resumen del análisis importado { period, categories, notes, importedAt }
    bankSpend: null,            // último gasto por categoría leído del banco { cycleId, at, byCat, bizumIn }
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const base = defaultState();
    return { ...base, ...data, settings: { ...base.settings, ...data.settings } };
  } catch {
    return defaultState();
  }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function importData(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !data.settings || !Array.isArray(data.jars)) {
    throw new Error('El archivo no es una copia de seguridad de Holgura');
  }
  const base = defaultState();
  return { ...base, ...data, settings: { ...base.settings, ...data.settings } };
}

export function clearAll() {
  localStorage.removeItem(KEY);
}
