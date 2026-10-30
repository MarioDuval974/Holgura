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

// ---------- Fines de semana ----------

// Un día de fin de semana "pesa" weekendFactor días entre semana (se suele gastar más)
export function isWeekend(date, settings) {
  const wd = weekday(date);
  return wd === 0 || wd === 6 || (Boolean(settings.fridayWeekend) && wd === 5);
}
export const dayWeight = (date, settings) => (isWeekend(date, settings) ? Number(settings.weekendFactor) || 1 : 1);

// Suma de pesos de los días en [from, to)
export function weightedDays(from, to, settings) {
  let w = 0;
  for (let d = from; d < to; d = addDays(d, 1)) w += dayWeight(d, settings);
  return w;
}

// Reparte un presupuesto entre los días de [from, to): cuánto toca a un día entre semana, a uno de
// fin de semana, a lo que queda de esta semana (hasta el domingo) y a una semana completa
export function spendingPlan(budget, from, to, settings) {
  const factor = Number(settings.weekendFactor) || 1;
  const unit = Math.max(0, budget) / Math.max(1, weightedDays(from, to, settings));
  const nextMonday = addDays(from, ((8 - weekday(from)) % 7) || 7);
  const weekEnd = nextMonday < to ? nextMonday : to;
  return {
    weekday: unit,
    weekend: unit * factor,
    thisWeek: weightedDays(from, weekEnd, settings) * unit,
    weekUntil: addDays(weekEnd, -1),
    fullWeek: (settings.fridayWeekend ? 4 + 3 * factor : 5 + 2 * factor) * unit,
  };
}

// ---------- Aprender cuánto más se gasta el fin de semana ----------

// Gasto del día a día acumulado en cada punto conocido de un ciclo: inicio, cada revisión y cierre
function spendPoints(state, cyc) {
  const ks = state.checkins.filter(k => k.cycleId === cyc.id).sort((a, b) => a.date.localeCompare(b.date));
  const pts = [{ date: cyc.start, v: 0 }];
  let extra = 0;
  for (const k of ks) {
    extra += Number(k.extraIncome) || 0;
    const balance = k.balance - (Number(k.earlyIncome) || 0);
    const fixedCharged = cyc.fixedTotal - (Number(k.pendingFixed) || 0);
    pts.push({ date: k.date, v: cyc.startBalance - balance - fixedCharged - netToJars(state, cyc.id, k.date) + extra });
  }
  if (cyc.end) pts.push({ date: cyc.end, v: cyc.variable });
  return pts;
}

// Entre cada par de puntos sabemos cuánto se gastó y cuántos días eran entre semana (a) y de fin de
// semana (b). Si esos tramos mezclan días distintos (p. ej. revisar viernes y lunes) se puede separar
// el gasto de un día entre semana (x) y de uno de fin de semana (y) con mínimos cuadrados: S ≈ a·x + b·y.
export function learnWeekend(state) {
  const s = state.settings;
  const prior = Number(s.weekendFactor) || 1;
  const cycles = [
    ...state.history.filter(h => h.startBalance != null)
      .map(h => ({ id: h.id, start: h.start, startBalance: h.startBalance, fixedTotal: h.fixed, end: h.end, variable: h.variable })),
    ...(state.cycle ? [state.cycle] : []),
  ].slice(-4);

  const usualShare = s.fridayWeekend ? 3 / 7 : 2 / 7;
  let saa = 0, sab = 0, sbb = 0, sas = 0, sbs = 0, n = 0, informative = 0;
  for (const cyc of cycles) {
    const pts = spendPoints(state, cyc);
    for (let i = 1; i < pts.length; i++) {
      const from = pts[i - 1].date, to = pts[i].date;
      const days = diffDays(from, to);
      if (days <= 0) continue;
      let b = 0;
      for (let d = from; d < to; d = addDays(d, 1)) if (isWeekend(d, s)) b++;
      const a = days - b, S = pts[i].v - pts[i - 1].v;
      saa += a * a; sab += a * b; sbb += b * b; sas += a * S; sbs += b * S; n++;
      // Un tramo de semanas completas no aporta nada: tiene la misma mezcla de días que cualquier semana
      if (Math.abs(b / days - usualShare) > 0.15) informative++;
    }
  }

  let learned = null;
  const det = saa * sbb - sab * sab;
  if (n >= 3 && informative >= 2 && det > 0.05 * saa * sbb) {
    const x = (sas * sbb - sbs * sab) / det; // € por día entre semana
    const y = (saa * sbs - sab * sas) / det; // € por día de fin de semana
    if (x > 0 && y >= 0) learned = Math.min(4, Math.max(0.5, y / x));
    else if (x <= 0 && y > 0) learned = 4;
  }
  // Se fía más de lo aprendido cuantos más tramos útiles tenga; mientras, se mezcla con tu elección
  const confidence = learned == null ? 0 : Math.min(1, informative / 6);
  const factor = learned == null ? prior : confidence * learned + (1 - confidence) * prior;
  return { factor: Math.round(factor * 10) / 10, learned, confidence, informative, prior };
}

// Ajustes con el peso del fin de semana que toca usar (el aprendido o el elegido)
export function effectiveSettings(state) {
  const s = state.settings;
  return s.weekendMode === 'auto' ? { ...s, weekendFactor: learnWeekend(state).factor } : s;
}

// ---------- Aprendizaje del gasto diario ----------

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
  const s = effectiveSettings(state), c = state.cycle;
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
  const start = c ? c.start : todayStr();
  const plan = spendingPlan(dayToDay, start, addDays(start, days), s);
  return { income, fixed, sobrante, savings, cushion: round2(cushion), daily, source, dayToDay, perDay: dayToDay / days, days, plan };
}

// ---------- Semáforo de una revisión ----------

export function analyze(state, checkin) {
  const c = state.cycle, s = effectiveSettings(state);
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

  // Los días se ponderan: un fin de semana cuenta más que un día entre semana
  const from = addDays(c.start, elapsed);
  const elapsedW = Math.max(1, weightedDays(c.start, from, s));
  const remainingW = weightedDays(from, info.end, s);
  const cycleW = Math.max(1, weightedDays(c.start, info.end, s));

  // Los primeros días el ritmo real es poco fiable: se mezcla con lo aprendido de meses anteriores
  const hist = learnedDaily(state.history);
  const w = hist == null ? 1 : Math.min(1, elapsed / 10);
  const daily = w * observedDaily + (1 - w) * hist;
  const unit = w * (Math.max(0, variable) / elapsedW) + (1 - w) * (hist ?? 0) * info.totalDays / cycleW;

  const projectedVariable = Math.max(0, variable) + unit * remainingW;
  const margin = c.income + extra - c.fixedTotal; // lo que hay para el día a día + ahorro
  const goal = Number(c.savingsGoal) || 0;
  const budgetVar = margin - goal;
  const tight = margin * 0.05;

  let status = 'green';
  if (projectedVariable > margin) status = 'red';
  else if (projectedVariable > budgetVar || projectedVariable > margin - tight) status = 'yellow';

  return {
    status, elapsed, remaining, totalDays: info.totalDays, end: info.end,
    variable: round2(variable), observedDaily, daily, projectedVariable,
    margin, goal, saved, extra, pendingFixed,
    projectedSavings: margin - projectedVariable,
    planGoal: spendingPlan(budgetVar - variable, from, info.end, s), // para cumplir el objetivo de ahorro
    planNoJar: spendingPlan(margin - variable, from, info.end, s),   // para no tocar las huchas
    deficit: Math.max(0, projectedVariable - margin),                // lo que faltaría (saldría de la hucha)
    projectedEndBalance: balance - pendingFixed - unit * remainingW - Math.max(0, goal - saved),
  };
}

// Cierra el ciclo actual con el saldo que había justo antes de cobrar
export function closeCycle(state, endDate, endBalance) {
  const c = state.cycle;
  const extra = sum(state.checkins.filter(k => k.cycleId === c.id), k => k.extraIncome);
  const moved = netToJars(state, c.id, endDate);
  const days = Math.max(1, diffDays(c.start, endDate));
  return {
    id: c.id, start: c.start, end: endDate, days, startBalance: c.startBalance,
    income: c.income + extra, fixed: c.fixedTotal, goal: Number(c.savingsGoal) || 0,
    variable: round2(Math.max(0, c.startBalance - endBalance - c.fixedTotal - moved + extra)),
    saved: round2(netToJars(state, c.id, endDate, true)), endBalance: round2(endBalance),
  };
}
