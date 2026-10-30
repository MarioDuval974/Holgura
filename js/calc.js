// Cálculos puros de Holgura: fechas, ciclos, aprendizaje del gasto diario y semáforo.
// Las fechas se guardan como 'YYYY-MM-DD' y se operan en UTC para no sufrir el cambio de hora.

const DAY = 86400000;
export const pad = n => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const toUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const fromUTC = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (s, n) => fromUTC(toUTC(s) + n * DAY);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY);
export const weekday = s => new Date(toUTC(s)).getUTCDay(); // 0 = domingo
export const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

// Fecha con el día ajustado al último del mes si no existe (p. ej. 31 de febrero → 28/29)
export function makeDate(y, m0, d) {
  const t = new Date(Date.UTC(y, m0, 1));
  const yy = t.getUTCFullYear(), mm = t.getUTCMonth();
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(d, daysInMonth(yy, mm)))}`;
}

const round2 = n => Math.round(n * 100) / 100;
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function fixedTotalOf(settings) {
  return settings.fixedMode === 'total' ? Number(settings.fixedTotal) || 0 : sum(settings.fixedItems, i => i.amount);
}

// ---------- Ciclos ----------

// Fecha teórica de cobro más cercana a una fecha real (si cobras el 25 porque el 27 es domingo, sigue siendo el "27").
function nominalPayday(date, payDay) {
  const [y, m] = date.split('-').map(Number);
  return [-1, 0, 1]
    .map(k => makeDate(y, m - 1 + k, payDay))
    .reduce((best, c) => (Math.abs(diffDays(date, c)) < Math.abs(diffDays(date, best)) ? c : best));
}

// Último día de cobro teórico (para proponer la fecha de inicio en la configuración inicial)
export function lastNominalPayday(today, settings) {
  const [y, m] = today.split('-').map(Number);
  if (settings.cycleType === 'natural') return makeDate(y, m - 1, 1);
  const thisMonth = makeDate(y, m - 1, settings.payDay);
  return thisMonth <= today ? thisMonth : makeDate(y, m - 2, settings.payDay);
}

// Fecha prevista del siguiente cobro (fin del ciclo actual)
export function expectedCycleEnd(start, settings) {
  if (settings.cycleType === 'natural') {
    const [y, m] = start.split('-').map(Number);
    return makeDate(y, m, 1);
  }
  const [ny, nm] = nominalPayday(start, settings.payDay).split('-').map(Number);
  return makeDate(ny, nm, settings.payDay);
}

export function cycleInfo(cycle, settings, today = todayStr()) {
  const end = expectedCycleEnd(cycle.start, settings);
  const totalDays = Math.max(1, diffDays(cycle.start, end));
  const elapsed = Math.min(totalDays, Math.max(0, diffDays(cycle.start, today)));
  return {
    end, totalDays, elapsed,
    remaining: Math.max(0, diffDays(today, end)),
    // De nómina a nómina: desde 3 días antes del cobro previsto (puede adelantarse por un fin de semana).
    // Mes natural: a partir del día 1.
    paydaySoon: diffDays(today, end) <= (settings.cycleType === 'natural' ? 0 : 3),
  };
}

// ---------- Revisiones ----------

export function nextCheckinDate(base, freq) {
  switch (freq.type) {
    case 'diaria': return addDays(base, 1);
    case 'cadaX': return addDays(base, Math.max(1, Number(freq.every) || 1));
    case 'semanal': {
      let d = addDays(base, 1);
      while (weekday(d) !== Number(freq.weekday)) d = addDays(d, 1);
      return d;
    }
    case 'mensual': {
      let d = addDays(base, 1);
      for (let i = 0; i < 62; i++, d = addDays(d, 1)) {
        const [y, m, dd] = d.split('-').map(Number);
        if (dd === Math.min(Number(freq.monthDay), daysInMonth(y, m - 1))) return d;
      }
      return d;
    }
  }
  return addDays(base, 7);
}

// Dinero que ha salido de la cuenta hacia las huchas (neto) en el ciclo, hasta una fecha.
// Con onlyGoal se ignora lo que viene de sobras del ciclo anterior (no cuenta para el objetivo de este).
export function netToJars(state, cycleId, upTo, onlyGoal = false) {
  return sum(
    state.moves.filter(m => m.cycleId === cycleId && m.account && m.date <= upTo && !(onlyGoal && m.carry)),
    m => (m.type === 'in' ? m.amount : -m.amount),
  );
}

// Fecha en la que se cobra un gasto fijo dentro del ciclo
export function chargeDateInCycle(item, cycleStart) {
  if (!item.day) return null;
  const [y, m, d] = cycleStart.split('-').map(Number);
  const sameMonth = makeDate(y, m - 1, item.day);
  return Number(item.day) >= d ? sameMonth : makeDate(y, m, item.day);
}

// ---------- Aprendizaje ----------

// Gasto diario medio "del día a día" aprendido de los últimos ciclos (los recientes pesan más)
export function learnedDaily(history) {
  const recent = history.slice(-3).reverse();
  if (!recent.length) return null;
  const weights = [3, 2, 1];
  let total = 0, w = 0;
  recent.forEach((h, i) => { total += weights[i] * (h.variable / Math.max(1, h.days)); w += weights[i]; });
  return Math.max(0, total / w);
}

export function recommendation(state, analysis = null) {
  const s = state.settings, c = state.cycle;
  const income = c ? c.income : Number(s.salary) || 0;
  const fixed = c ? c.fixedTotal : fixedTotalOf(s);
  const days = c ? cycleInfo(c, s).totalDays : 30;
  const sobrante = income - fixed;

  let daily = learnedDaily(state.history), source = 'historial';
  if (daily == null && analysis && analysis.elapsed >= 7) { daily = analysis.observedDaily; source = 'mes'; }

  let savings, cushion = 0;
  if (daily == null) {
    // Sin datos todavía: regla 50/30/20 (ahorrar el 20 % del sueldo) sin pasar de la mitad del sobrante
    source = 'provisional';
    savings = Math.max(0, Math.min(income * 0.2, sobrante * 0.5));
  } else {
    const estVar = daily * days;
    cushion = estVar * (Number(s.safetyPct) || 0) / 100;
    savings = Math.max(0, sobrante - estVar - cushion);
  }
  savings = savings >= 10 ? Math.floor(savings / 10) * 10 : Math.floor(savings);
  const dayToDay = Math.max(0, sobrante - savings);
  return { income, fixed, sobrante, savings, cushion: round2(cushion), daily, source, dayToDay, perDay: dayToDay / days, days };
}

// ---------- Semáforo de una revisión ----------

export function analyze(state, checkin) {
  const c = state.cycle, s = state.settings;
  const info = cycleInfo(c, s, checkin.date);
  const elapsed = Math.max(1, info.elapsed);
  const remaining = Math.max(0, info.totalDays - elapsed);

  const cycleCheckins = state.checkins.filter(k => k.cycleId === c.id && k.date <= checkin.date && k.id !== checkin.id);
  const extra = sum(cycleCheckins, k => k.extraIncome) + (Number(checkin.extraIncome) || 0);
  const moved = netToJars(state, c.id, checkin.date);
  const saved = netToJars(state, c.id, checkin.date, true);
  const pendingFixed = Number(checkin.pendingFixed) || 0;
  const fixedCharged = c.fixedTotal - pendingFixed;
  // Si ya ha llegado la nómina del siguiente ciclo (mes natural), no cuenta para este
  const balance = checkin.balance - (Number(checkin.earlyIncome) || 0);

  // Lo gastado en el día a día = lo que ha bajado la cuenta, sin contar fijos, huchas ni ingresos extra
  const variable = c.startBalance - balance - fixedCharged - moved + extra;
  const observedDaily = Math.max(0, variable) / elapsed;

  // Los primeros días el ritmo real es poco fiable: se mezcla con lo aprendido de meses anteriores
  const hist = learnedDaily(state.history);
  const w = hist == null ? 1 : Math.min(1, elapsed / 10);
  const daily = w * observedDaily + (1 - w) * hist;

  const projectedVariable = Math.max(0, variable) + daily * remaining;
  const margin = c.income + extra - c.fixedTotal; // lo que hay para el día a día + ahorro
  const goal = Number(c.savingsGoal) || 0;
  const budgetVar = margin - goal;
  const tight = margin * 0.05;

  let status = 'green';
  if (projectedVariable > margin) status = 'red';
  else if (projectedVariable > budgetVar || projectedVariable > margin - tight) status = 'yellow';

  const days = Math.max(1, remaining);
  return {
    status, elapsed, remaining, totalDays: info.totalDays, end: info.end,
    variable: round2(variable), observedDaily, daily, projectedVariable,
    margin, goal, saved, extra, pendingFixed,
    projectedSavings: margin - projectedVariable,
    allowanceGoal: (budgetVar - variable) / days,       // €/día para cumplir el objetivo de ahorro
    allowanceNoJar: (margin - variable) / days,         // €/día para no tocar las huchas
    deficit: Math.max(0, projectedVariable - margin),   // lo que faltaría (saldría de la hucha)
    projectedEndBalance: balance - pendingFixed - daily * remaining - Math.max(0, goal - saved),
  };
}

// Cierra el ciclo actual con el saldo que había justo antes de cobrar
export function closeCycle(state, endDate, endBalance) {
  const c = state.cycle;
  const extra = sum(state.checkins.filter(k => k.cycleId === c.id), k => k.extraIncome);
  const moved = netToJars(state, c.id, endDate);
  const days = Math.max(1, diffDays(c.start, endDate));
  return {
    id: c.id, start: c.start, end: endDate, days,
    income: c.income + extra, fixed: c.fixedTotal, goal: Number(c.savingsGoal) || 0,
    variable: round2(Math.max(0, c.startBalance - endBalance - c.fixedTotal - moved + extra)),
    saved: round2(netToJars(state, c.id, endDate, true)), endBalance: round2(endBalance),
  };
}
