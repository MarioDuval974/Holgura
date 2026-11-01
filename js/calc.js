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

// Gastos fijos de un mes normal (sin contar los que solo se cobran algunos meses, p. ej. trimestrales)
export function fixedTotalOf(settings) {
  return settings.fixedMode === 'total'
    ? Number(settings.fixedTotal) || 0
    : sum(settings.fixedItems.filter(i => !i.months?.length), i => i.amount);
}
export const periodicTotalOf = settings =>
  settings.fixedMode === 'total' ? 0 : sum(settings.fixedItems.filter(i => i.months?.length), i => i.amount);

// Gastos que tocan en el ciclo [start, end): los mensuales siempre; los de meses concretos solo si cae uno
export function dueItems(items, start, end) {
  return items.filter(i => {
    if (!i.months?.length) return true;
    for (let d = start; d < end; d = addDays(d, 1)) {
      const [, m, dd] = d.split('-').map(Number);
      if (i.months.includes(m) && (!i.day || dd === Math.min(Number(i.day), daysInMonth(Number(d.slice(0, 4)), m - 1)))) return true;
    }
    return false;
  });
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
  const fixed = c ? cycleFixedTotal(state) : fixedTotalOf(s);
  const days = c ? cycleInfo(c, s).totalDays : 30;
  const oo = c ? cycleOneOffs(state) : { in: 0, out: 0 };
  const oneOffs = round2(oo.in - oo.out); // ingresos y gastos puntuales del ciclo
  const sobrante = income + oneOffs - fixed;

  let daily = learnedDaily(state.history), source = 'historial';
  if (daily == null && analysis && analysis.elapsed >= 7) { daily = analysis.observedDaily; source = 'mes'; }

  let savings, cushion = 0, basis = null, planned = 0;
  if (daily == null) {
    // Sin datos todavía: regla 50/30/20 (ahorrar el 20 % del sueldo) sin pasar de la mitad del sobrante.
    // Si los fijos ya se llevan más de la mitad de la nómina, el 20 % deja muy poco para comer: se propone el 10 %
    source = 'provisional';
    basis = fixed > income * 0.5 ? '10' : '20';
    savings = Math.max(0, Math.min(income * (basis === '10' ? 0.1 : 0.2), sobrante * 0.5));
    // Con presupuesto del día a día repartido, se respeta lo que necesitas (más el margen): solo puede bajar la propuesta
    planned = sum(Object.values(s.budgets || {}), v => v);
    if (planned > 0) {
      const room = sobrante - planned * (1 + (Number(s.safetyPct) || 0) / 100);
      if (room < savings) { savings = Math.max(0, room); basis = 'presupuesto'; cushion = planned * (Number(s.safetyPct) || 0) / 100; }
    }
  } else {
    const estVar = daily * days;
    cushion = estVar * (Number(s.safetyPct) || 0) / 100;
    savings = Math.max(0, sobrante - estVar - cushion);
  }
  savings = savings >= 10 ? Math.floor(savings / 10) * 10 : Math.floor(savings);
  const dayToDay = Math.max(0, sobrante - savings);
  const start = c ? c.start : todayStr();
  const plan = spendingPlan(dayToDay, start, addDays(start, days), s);
  return { income, fixed, oneOffs, sobrante, savings, cushion: round2(cushion), daily, source, basis, planned, dayToDay, perDay: dayToDay / days, days, plan };
}

// ---------- Gastos fijos "según banco" ----------

// Los fijos con "key" (una consulta, una clase, un pago a un familiar…) no se marcan a mano: cuenta lo que de verdad
// ha salido de la cuenta en el ciclo para ellos, según los movimientos del banco. Si no ha salido nada, no cuenta.
export function trackedFixed(state, upTo = '9999-12-31') {
  const c = state.cycle, sp = state.bankSpend;
  const items = (c?.fixedItems || []).filter(i => i.key);
  if (!items.length || sp?.cycleId !== c.id || !sp.fixedCharges) return null;
  const paid = {}, back = {};
  for (const f of sp.fixedCharges) {
    if (f.date < c.start || f.date > upTo) continue;
    if (f.amount >= 0) paid[f.key] = (paid[f.key] || 0) + f.amount;
    else back[f.key] = (back[f.key] || 0) - f.amount; // te han devuelto tu parte (p. ej. el Bizum de las plataformas)
  }
  const byId = {}, paidById = {}, backById = {};
  let charged = 0, over = 0;
  for (const i of items) {
    const a = round2((paid[i.key] || 0) - (back[i.key] || 0));
    byId[i.id] = a;
    paidById[i.id] = round2(paid[i.key] || 0);
    backById[i.id] = round2(back[i.key] || 0);
    charged += a;
    over += Math.max(0, a - i.amount); // p. ej. una sesión de más: el fijo de este ciclo sube
  }
  return { byId, paidById, backById, ids: new Set(items.map(i => i.id)), charged: round2(charged), over: round2(over) };
}

// Gastos fijos del ciclo contando lo que se haya pasado de lo previsto en los "según banco"
export const cycleFixedTotal = (state, upTo) => (state.cycle?.fixedTotal || 0) + (trackedFixed(state, upTo)?.over || 0);

// ---------- Ingresos y gastos puntuales ----------

// Lo que entra o sale una vez (Hacienda, una venta, un regalo…): suma o resta a lo que te sobra este ciclo
// y no cuenta como gasto del día a día. Los apuntas tú (cycle.extras) o los detecta el banco (impuestos).
export function cycleOneOffs(state, upTo = '9999-12-31') {
  const c = state.cycle, sp = state.bankSpend;
  if (!c) return { in: 0, out: 0, list: [] };
  const manual = (c.extras || []).map(e => ({ ...e, source: 'manual' }));
  const bank = sp?.cycleId === c.id ? (sp.oneOffs || []).map(e => ({ ...e, source: 'bank' })) : [];
  const list = [...manual, ...bank].filter(e => e.date >= c.start && e.date <= upTo)
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    in: round2(sum(list.filter(e => e.amount > 0), e => e.amount)),
    out: round2(-sum(list.filter(e => e.amount < 0), e => e.amount)),
    list,
  };
}

// ---------- Semáforo de una revisión ----------

// El semáforo mira solo este ciclo: lo gastado en el día a día frente a lo que te sobra tras los fijos
// (sin adivinar con meses anteriores, porque cada mes es distinto).
export function analyze(state, checkin) {
  const c = state.cycle, s = effectiveSettings(state);
  const info = cycleInfo(c, s, checkin.date);
  // Días transcurridos contando el de la revisión (lo que has gastado hoy ya está en el saldo)
  const elapsed = Math.max(1, Math.min(info.totalDays, info.elapsed + 1));
  const remaining = Math.max(0, info.totalDays - elapsed);

  const cycleCheckins = state.checkins.filter(k => k.cycleId === c.id && k.date <= checkin.date && k.id !== checkin.id);
  const extra = sum(cycleCheckins, k => k.extraIncome) + (Number(checkin.extraIncome) || 0);
  const moved = netToJars(state, c.id, checkin.date);
  const saved = netToJars(state, c.id, checkin.date, true);
  // Lo pendiente se recalcula con los importes actuales (por si cambiaste algún fijo después de la revisión)
  let pendingFixed = c.fixedItems?.length && Array.isArray(checkin.pendingIds)
    ? sum(c.fixedItems.filter(i => checkin.pendingIds.includes(i.id)), i => i.amount)
    : Number(checkin.pendingFixed) || 0;
  let fixedCharged = c.fixedTotal - pendingFixed;
  let fixedTotal = c.fixedTotal;
  // Los fijos "según banco" no usan el check: cuenta lo realmente retirado hasta el día de la revisión
  const tracked = trackedFixed(state, checkin.date);
  if (tracked) {
    const markedTracked = sum(c.fixedItems.filter(i => tracked.ids.has(i.id) && !(checkin.pendingIds || []).includes(i.id)), i => i.amount);
    fixedCharged = fixedCharged - markedTracked + tracked.charged;
    fixedTotal += tracked.over;
    pendingFixed = Math.max(0, fixedTotal - fixedCharged);
  }
  // Si ya ha llegado la nómina del siguiente ciclo (mes natural), no cuenta para este
  const balance = checkin.balance - (Number(checkin.earlyIncome) || 0);

  // Lo gastado en el día a día = lo que ha bajado la cuenta, sin contar fijos, huchas ni ingresos extra
  // Ajustes: de algún cargo solo cuenta una parte (p. ej. un gasto compartido del que otra persona te devuelve su parte en efectivo)
  const notMine = sum((state.adjustments || []).filter(a => a.date >= c.start && a.date <= checkin.date),
    a => Math.abs(a.amount) - a.counted);
  // Puntuales (Hacienda, una venta…): no son gasto del día a día, pero cambian lo que te sobra
  const oo = cycleOneOffs(state, checkin.date);
  const variable = c.startBalance - balance - fixedCharged - moved + extra - notMine + oo.in - oo.out;
  const spent = Math.max(0, variable);
  const observedDaily = spent / elapsed;

  const margin = c.income + extra + oo.in - oo.out - fixedTotal; // lo que te sobra tras los fijos y los puntuales
  const goal = Number(c.savingsGoal) || 0;
  const available = margin - goal;                // lo que puedes gastar sin tocar tu objetivo de ahorro

  // Lo que "tocaría" llevar gastado hoy: lo que te sobra repartido por días (el fin de semana pesa más)
  const from = addDays(c.start, elapsed);
  const cycleW = Math.max(1, weightedDays(c.start, info.end, s));
  const expected = Math.max(0, available) * weightedDays(c.start, from, s) / cycleW;

  let status = 'green';
  if (spent > margin) status = 'red';
  else if (spent > available || spent > expected * 1.05 + 1) status = 'yellow';

  return {
    status, elapsed, remaining, totalDays: info.totalDays, end: info.end,
    variable: round2(variable), spent: round2(spent), observedDaily, daily: observedDaily,
    margin, goal, available, expected, left: available - spent, saved, extra, pendingFixed,
    planGoal: spendingPlan(available - spent, from, info.end, s), // para cumplir el objetivo de ahorro
    planNoJar: spendingPlan(margin - spent, from, info.end, s),   // para no tocar las huchas
    deficit: Math.max(0, spent - margin),                          // lo que ya falta (saldría de la hucha)
  };
}

// Cierra el ciclo actual con el saldo que había justo antes de cobrar
export function closeCycle(state, endDate, endBalance) {
  const c = state.cycle;
  const extra = sum(state.checkins.filter(k => k.cycleId === c.id), k => k.extraIncome);
  const moved = netToJars(state, c.id, endDate);
  const days = Math.max(1, diffDays(c.start, endDate));
  const oo = cycleOneOffs(state, endDate);
  // Igual que en la revisión: los fijos "según banco" cuentan lo que de verdad salió (más o menos de lo previsto)
  // y de los cargos con ajuste solo cuenta tu parte; si no, el gasto del día a día aprendido sale inflado
  const tracked = trackedFixed(state, endDate);
  const fixed = tracked
    ? round2(c.fixedTotal - sum(c.fixedItems.filter(i => tracked.ids.has(i.id)), i => i.amount) + tracked.charged)
    : c.fixedTotal;
  const notMine = sum((state.adjustments || []).filter(a => a.date >= c.start && a.date <= endDate),
    a => Math.abs(a.amount) - a.counted);
  return {
    id: c.id, start: c.start, end: endDate, days, startBalance: c.startBalance,
    income: c.income + extra + oo.in, fixed, oneOffOut: oo.out, goal: Number(c.savingsGoal) || 0,
    variable: round2(Math.max(0, c.startBalance - endBalance - fixed - moved + extra - notMine + oo.in - oo.out)),
    saved: round2(netToJars(state, c.id, endDate, true)), endBalance: round2(endBalance),
  };
}
