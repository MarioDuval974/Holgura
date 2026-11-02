// Interfaz de Holgura: vistas, hojas (bottom sheets) y acciones.
import * as C from './calc.js';
import * as S from './store.js';
import * as B from './bank.js';
import { CATEGORY_NAMES, BUDGET_CATEGORIES, icon, categorize, spendByCategory } from './categories.js';

let state = S.load();
let bankUI = { status: null, loading: false, error: null }; // estado de la conexión con el banco
let tab = 'inicio';
let wizStep = 0;
let wizDraft = { start: null, balance: '' };
let sheetCtx = null; // contexto de la hoja abierta (ids, tipo de movimiento…)

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const sheetRoot = document.getElementById('sheet-root');

// ---------- Utilidades ----------

const $ = sel => document.querySelector(sel);
// useGrouping 'always': en español Intl no separa los miles en números de 4 cifras (1850 → 1.850)
const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
const money = n => eur.format(Number.isFinite(n) ? n : 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

// Acepta "1500", "1.500", "1500,50", "1.500,50" y "1500.50"
function parseMoney(v) {
  let s = String(v ?? '').trim().replace(/[\s€]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}
const numStr = n => (Number.isFinite(n) && n !== 0 ? String(Math.round(n * 100) / 100).replace('.', ',') : '');

const dateFmt = (s, o = { day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('es-ES', { ...o, timeZone: 'UTC' }).format(new Date(C.toUTC(s)));
const dayFmt = s => dateFmt(s, { weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const EMOJIS = ['🐷', '🛟', '✈️', '🚗', '🏠', '🎁', '🎓', '💍', '🩺', '🐶', '🎮', '📦'];

const persist = () => S.save(state);
function commit() { persist(); render(); }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Consultas sobre el estado ----------

const cycleCheckins = () => state.checkins.filter(k => k.cycleId === state.cycle?.id).sort((a, b) => a.date.localeCompare(b.date));
const lastCheckin = () => cycleCheckins().at(-1) || null;
const nextDue = () => C.nextCheckinDate(lastCheckin()?.date || state.cycle.start, state.settings.checkFreq);
const jarBalance = id => sum(state.moves.filter(m => m.jarId === id), m => (m.type === 'in' ? m.amount : -m.amount));
const jarsTotal = () => sum(state.jars, j => jarBalance(j.id));

function freqLabel(f) {
  switch (f.type) {
    case 'diaria': return 'cada día';
    case 'cadaX': return `cada ${f.every} días`;
    case 'semanal': return `los ${WEEKDAYS[f.weekday]}${[0, 6].includes(Number(f.weekday)) ? 's' : ''}`;
    case 'mensual': return `el día ${f.monthDay} de cada mes`;
  }
  return '';
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach(k => { o = o[k]; });
  o[keys.at(-1)] = value;
}

// El ciclo en curso refleja los cambios de "Mi mes" (gastos fijos y sueldo)
function syncCycle(prevSalary) {
  const c = state.cycle, s = state.settings;
  if (!c) return;
  if (s.fixedMode === 'desglose') {
    // Solo los gastos que se cobran dentro de este ciclo (los trimestrales, solo cuando tocan)
    c.fixedItems = C.dueItems(s.fixedItems, c.start, C.expectedCycleEnd(c.start, s)).map(i => ({ ...i }));
    c.fixedTotal = sum(c.fixedItems, i => i.amount);
  } else {
    c.fixedItems = [];
    c.fixedTotal = C.fixedTotalOf(s);
  }
  if (prevSalary !== undefined && c.income === prevSalary) c.income = Number(state.settings.salary) || 0;
}

// ---------- Componentes ----------

const header = (title, sub = '') => `<header class="top"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</header>`;

const seg = (path, options, current, cls = '') => `
  <div class="seg ${cls}" role="radiogroup">
    ${options.map(([v, label]) => `<button role="radio" aria-checked="${String(v) === String(current)}" class="${String(v) === String(current) ? 'on' : ''}" data-act="seg" data-path="${path}" data-value="${v}">${label}</button>`).join('')}
  </div>`;

const moneyField = (label, attrs, value, hint = '') => `
  <label class="field"><span>${label}</span>
    <div class="money-input"><input inputmode="decimal" autocomplete="off" placeholder="0,00" ${attrs} value="${esc(value)}"><em>€</em></div>
    ${hint ? `<small>${hint}</small>` : ''}
  </label>`;

const banner = (icon, title, text, act, btn) => `
  <section class="banner">
    <div class="banner-icon">${icon}</div>
    <div class="banner-text"><strong>${title}</strong><p>${text}</p></div>
    <button class="btn primary small" data-act="${act}">${btn}</button>
  </section>`;

const STATUS = {
  green: { title: 'Vas bien', icon: '🟢' },
  yellow: { title: 'Vas un poco rápido', icon: '🟡' },
  red: { title: 'Te has pasado este ciclo', icon: '🔴' },
};

// Solo con lo que ha pasado en este ciclo: lo gastado frente a lo que te sobra tras los fijos
function statusMessage(a) {
  const of = `de los <b>${money(a.available)}</b> que te sobran tras los fijos${a.goal ? ' (sin tocar tu ahorro)' : ''}`;
  const days = a.remaining === 1 ? 'mañana' : `los próximos ${a.remaining} días`;
  if (a.status === 'green') {
    return `Llevas <b>${money(a.spent)}</b> ${of}. Te quedan <b>${money(a.left)}</b> para ${days}.`;
  }
  if (a.status === 'yellow') {
    return a.spent > a.available
      ? `Ya has gastado lo que te sobraba sin tocar tu objetivo de ahorro (<b>${money(a.spent)}</b> de ${money(a.available)}). Lo que gastes a partir de ahora sale del ahorro previsto.`
      : `Llevas <b>${money(a.spent)}</b> ${of}; a estas alturas del ciclo lo normal serían unos ${money(a.expected)}. Te quedan <b>${money(a.left)}</b> para ${days}.`;
  }
  return `Has gastado <b>${money(a.spent)}</b> en el día a día y este ciclo te sobraban <b>${money(a.margin)}</b> tras los fijos. Te faltan <b>${money(a.deficit)}</b>: si no ajustas, saldrán de la hucha.${
    a.elapsed <= 5 ? '<br><small>¿Te parece raro tan pronto? Revisa en Mi mes el saldo con el que empezaste el ciclo.</small>' : ''}`;
}

// Con los movimientos del banco: lo que puedes gastar hoy y esta semana, y lo que llevas gastado.
// Se calcula desde el principio del día (o de la semana), así "llevas X / Y" cuadra.
function livePlan(useGoal) {
  const c = state.cycle, sp = state.bankSpend;
  if (!c || sp?.cycleId !== c.id || !sp.byDay) return null;
  const s = C.effectiveSettings(state), today = C.todayStr();
  const end = C.expectedCycleEnd(c.start, s);
  if (today < c.start || today >= end) return null;

  const back = s.bizumTo ? sp.bizumByDay || {} : {}; // Bizum devueltos que compensan gasto
  // Sin redondear a 0 por día: un Bizum devuelto un día sin gasto también resta de la semana
  const net = d => (sp.byDay[d] || 0) - (back[d] || 0);
  const spentBetween = (from, to) => { let t = 0; for (let d = from; d < to; d = C.addDays(d, 1)) t += net(d); return t; };
  const oo = C.cycleOneOffs(state);
  const available = c.income + oo.in - oo.out - C.cycleFixedTotal(state) - (useGoal ? Number(c.savingsGoal) || 0 : 0);

  const day = C.spendingPlan(available - spentBetween(c.start, today), today, end, s);
  const monday = C.addDays(today, -((C.weekday(today) + 6) % 7));
  const weekStart = monday < c.start ? c.start : monday;
  const week = C.spendingPlan(available - spentBetween(c.start, weekStart), weekStart, end, s);
  return {
    plan: day,
    todayIsWeekend: C.isWeekend(today, s),
    today: { spent: net(today), allowance: C.isWeekend(today, s) ? day.weekend : day.weekday },
    week: { spent: spentBetween(weekStart, C.addDays(today, 1)), allowance: week.thisWeek, from: weekStart, until: week.weekUntil },
  };
}

const progress = (label, spent, allowance) => `
  <div class="prog ${spent > allowance + 0.005 ? 'over' : ''}">
    <span>${label}</span><b>${money(Math.max(0, spent)).replace(/\s?€/, '')} / ${money(allowance)}</b>
    <span class="bar"><i style="width:${allowance > 0 ? Math.min(100, (Math.max(0, spent) / allowance) * 100) : 100}%"></i></span>
  </div>`;

// Lo que puedes gastar a partir de la revisión, por día (entre semana / fin de semana) o por semana
function allowanceBlock(a) {
  const s = state.settings;
  if (a.remaining <= 0) return '';
  const useGoal = a.goal > 0 && a.planGoal.weekday > 0;
  const live = livePlan(useGoal);
  const plan = live ? live.plan : useGoal ? a.planGoal : a.planNoJar;
  let body;
  if (s.allowanceView === 'semana') {
    body = `<div class="allow-grid">
      <div><span>Esta semana<small>${live ? `del ${dateFmt(live.week.from, { weekday: 'short', day: 'numeric' })} al ${dateFmt(live.week.until, { weekday: 'short', day: 'numeric' })}` : `de hoy al ${dayFmt(plan.weekUntil)}`}</small></span>
        <strong>${money(live ? live.week.allowance : plan.thisWeek)}</strong>
        ${live ? progress('Llevas', live.week.spent, live.week.allowance) : ''}</div>
      <div><span>Semana completa<small>de lunes a domingo</small></span><strong>${money(plan.fullWeek)}</strong></div>
    </div>`;
  } else if (C.effectiveSettings(state).weekendFactor === 1) {
    body = `<div class="allow-grid one"><div><span>Cada día</span><strong>${money(plan.weekday)}</strong>
      ${live ? progress('Hoy llevas', live.today.spent, live.today.allowance) : ''}</div></div>`;
  } else {
    const todayBox = weekend => (live && live.todayIsWeekend === weekend ? progress('Hoy llevas', live.today.spent, live.today.allowance) : '');
    body = `<div class="allow-grid">
      <div><span>Entre semana<small>${s.fridayWeekend ? 'lunes a jueves' : 'lunes a viernes'}</small></span><strong>${money(plan.weekday)}<em>/día</em></strong>${todayBox(false)}</div>
      <div><span>Fin de semana<small>${s.fridayWeekend ? 'viernes a domingo' : 'sábado y domingo'}</small></span><strong>${money(plan.weekend)}<em>/día</em></strong>${todayBox(true)}</div>
    </div>`;
  }
  return `<div class="allow">
    <div class="allow-head">
      <div><p class="eyebrow">Puedes gastar</p><p class="allow-sub">${useGoal ? 'cumpliendo tu objetivo de ahorro' : 'sin tocar tus huchas'}</p></div>
      ${seg('allowanceView', [['dia', 'Día'], ['semana', 'Semana']], s.allowanceView, 'mini')}
    </div>
    ${body}
  </div>`;
}

// Cómo se reparte el día a día del ciclo, según cómo quieras verlo
function planSummary(plan, perDay) {
  const s = state.settings;
  if (s.allowanceView === 'semana') return `≈ ${money(plan.fullWeek)} por semana`;
  if (C.effectiveSettings(state).weekendFactor === 1) return `≈ ${money(perDay)}/día`;
  return `≈ ${money(plan.weekday)}/día entre semana y ${money(plan.weekend)}/día el fin de semana`;
}

function statusBlock(a, k) {
  const st = STATUS[a.status];
  return `
    <section class="card status status-${a.status}">
      <div class="status-head">
        <span class="light" aria-hidden="true"></span>
        <div><h2>${st.title}</h2><p class="muted">Revisión del ${dayFmt(k.date)} · saldo ${money(k.balance)}</p></div>
      </div>
      <p class="status-text">${statusMessage(a)}</p>
      <button class="link spent-link" data-act="spent-open">¿De dónde salen estos ${money(a.spent)}? ›</button>
      ${allowanceBlock(a)}
      <div class="stats">
        <div><span>Gastado este ciclo</span><strong>${money(a.spent)}</strong></div>
        <div><span>Te queda</span><strong class="${a.left < 0 ? 'neg' : ''}">${money(a.left)}</strong></div>
        <div><span>Tu ritmo</span><strong>${money(a.daily)}/día</strong></div>
      </div>
    </section>`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Detalles cortos de un gasto fijo para la lista: día, meses en que se cobra y si va "según banco"
const fixedTags = i => [
  i.day ? `día ${i.day}` : '',
  i.months?.length ? `solo ${i.months.map(m => MONTHS[m - 1]).join(', ')}` : '',
  i.key ? 'según banco' : '',
].filter(Boolean).join(' · ');

// Hoja para crear o editar un gasto fijo
function openFixedForm(id = null) {
  const i = id ? state.settings.fixedItems.find(x => x.id === id) : null;
  openSheet(i ? 'Editar gasto fijo' : 'Nuevo gasto fijo', `
    <label class="field"><span>Nombre</span><input id="fx-name" placeholder="Ej.: Alquiler" value="${esc(i?.name || '')}"></label>
    <label class="field"><span>Categoría</span><select id="fx-cat">
      ${CATEGORY_NAMES.map(c => `<option value="${c}" ${c === (i?.category || 'Otros') ? 'selected' : ''}>${icon(c)} ${c}</option>`).join('')}
    </select></label>
    ${moneyField(i?.months?.length ? 'Importe cada vez que se cobra' : 'Importe al mes', 'id="fx-amount"', numStr(i?.amount || 0))}
    <label class="field"><span>Día en que te lo cobran (opcional)</span>
      <input id="fx-day" type="number" min="1" max="31" inputmode="numeric" placeholder="—" value="${i?.day ?? ''}">
      <small>Si lo pones, en cada revisión sabré si ya te lo han cobrado.</small></label>
    ${i?.months?.length ? `<p class="note">Solo se cobra en: ${i.months.map(m => MONTHS[m - 1]).join(', ')}.</p>` : ''}
    ${i?.key ? '<p class="note">Se cuenta <b>según tu banco</b>: lo que de verdad salga de tu cuenta para este gasto. El importe de aquí es lo previsto.</p>' : ''}
    <button class="btn primary block" data-act="fixed-save">${i ? 'Guardar' : 'Añadir'}</button>
    ${i ? `<button class="btn text danger block" data-act="fixed-del" data-id="${i.id}">Eliminar este gasto</button>` : ''}`, { fixedId: id });
}

function fixedEditor() {
  const s = state.settings;
  let html = seg('fixedMode', [['total', 'Importe total'], ['desglose', 'Gasto a gasto']], s.fixedMode);
  if (s.fixedMode === 'total') {
    html += moneyField('Total de gastos fijos al mes', 'data-bind="fixedTotal" data-kind="money"', numStr(s.fixedTotal),
      'Alquiler o hipoteca, recibos, suscripciones, seguros…');
  } else {
    // Agrupados por categoría, en el orden de la lista de categorías
    const groups = new Map();
    for (const i of s.fixedItems) {
      const cat = CATEGORY_NAMES.includes(i.category) ? i.category : 'Otros';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(i);
    }
    const ordered = CATEGORY_NAMES.filter(c => groups.has(c));
    // Una línea por gasto; al tocarlo se edita en una hoja (la lista con todos los campos era muy larga)
    html += `<div class="fx-list compact">${ordered.map(cat => `
      <p class="fx-group">${icon(cat)} ${cat}<span>${[
        sum(groups.get(cat).filter(i => !i.months?.length), i => i.amount),
        sum(groups.get(cat).filter(i => i.months?.length), i => i.amount),
      ].map((v, k) => (v ? `${money(v)}${k ? ' trimestral' : '/mes'}` : '')).filter(Boolean).join(' + ')}</span></p>
      <div class="fx-items">${groups.get(cat).map(i => `
        <button class="fx-item" data-act="fixed-edit" data-id="${i.id}">
          <span class="grow"><b>${esc(i.name || 'Sin nombre')}</b>${fixedTags(i) ? `<small>${fixedTags(i)}</small>` : ''}</span>
          <strong>${money(i.amount)}</strong><span class="chev">›</span>
        </button>`).join('')}
      </div>`).join('')}
    </div>
    <button class="btn ghost block" data-act="fixed-add">+ Añadir gasto fijo</button>
    <p class="fx-total">Total al mes: <strong data-fixed-total>${money(C.fixedTotalOf(s))}</strong></p>
    ${C.periodicTotalOf(s) ? `<small class="hint">Además, ${money(C.periodicTotalOf(s))} en gastos que solo se cobran algunos meses (trimestrales): se descuentan en el ciclo en que tocan.</small>` : ''}
    <small class="hint">Toca un gasto para cambiarlo o eliminarlo.</small>`;
  }
  return html;
}

function freqEditor() {
  const f = state.settings.checkFreq;
  let html = `<label class="field"><span>¿Cada cuánto quieres revisar?</span>
    <select data-bind="checkFreq.type" data-kind="text" data-rerender>
      ${[['diaria', 'Cada día'], ['cadaX', 'Cada X días'], ['semanal', 'Un día de la semana'], ['mensual', 'Un día del mes']]
        .map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>`;
  if (f.type === 'cadaX') {
    html += `<label class="field"><span>Número de días</span><input type="number" min="2" max="30" inputmode="numeric" data-bind="checkFreq.every" data-kind="int" value="${f.every}"></label>`;
  } else if (f.type === 'semanal') {
    html += `<label class="field"><span>Día de la semana</span><select data-bind="checkFreq.weekday" data-kind="int">
      ${[1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}" ${Number(f.weekday) === d ? 'selected' : ''}>${WEEKDAYS[d][0].toUpperCase() + WEEKDAYS[d].slice(1)}</option>`).join('')}
    </select></label>`;
  } else if (f.type === 'mensual') {
    html += `<label class="field"><span>Día del mes</span><select data-bind="checkFreq.monthDay" data-kind="int">
      ${Array.from({ length: 28 }, (_, i) => i + 1).map(d => `<option value="${d}" ${Number(f.monthDay) === d ? 'selected' : ''}>${d}</option>`).join('')}
    </select></label>`;
  }
  html += `<label class="field"><span>Hora del recordatorio</span><input type="time" data-bind="reminderTime" data-kind="text" value="${state.settings.reminderTime}"></label>`;
  return html;
}

// ---------- Asistente inicial ----------

function viewWizard() {
  const s = state.settings;
  const steps = 5;
  const dots = `<div class="dots">${Array.from({ length: steps }, (_, i) => `<span class="${i <= wizStep ? 'on' : ''}"></span>`).join('')}</div>`;
  const nav = (next = 'Siguiente') => `
    <div class="wiz-nav">
      ${wizStep > 0 ? '<button class="btn ghost" data-act="wiz-back">Atrás</button>' : '<span></span>'}
      <button class="btn primary" data-act="wiz-next">${next}</button>
    </div>`;

  if (wizStep === 0) {
    return `<div class="wizard hero">
      <img class="hero-logo" src="icons/icon-192.png" alt="">
      <h1>Holgura</h1>
      <p class="lead">Llega a fin de mes con margen y ahorra sin agobios.</p>
      <ul class="features">
        <li><span>💶</span><div><b>Tu mes de un vistazo</b><p>Nómina, gastos fijos y lo que te sobra.</p></div></li>
        <li><span>🚦</span><div><b>Revisiones periódicas</b><p>Escribes tu saldo y te digo si vas bien, si debes ajustar o si tendrás que tirar de la hucha.</p></div></li>
        <li><span>🐷</span><div><b>Huchas</b><p>Tantas como quieras, con sus ingresos y retiradas.</p></div></li>
      </ul>
      <p class="privacy">🔒 Tus datos se guardan solo en este móvil.</p>
      <button class="btn primary block" data-act="wiz-next">Empezar</button>
    </div>`;
  }
  if (wizStep === 1) {
    return `<div class="wizard">${dots}
      <h2>Tus ingresos</h2>
      <p class="muted">Lo que te llega a la cuenta cada mes, ya neto.</p>
      ${moneyField('Nómina mensual', 'data-bind="salary" data-kind="money"', numStr(s.salary))}
      <div class="field"><span>¿Cómo quieres contar el mes?</span>
        ${seg('cycleType', [['nomina', 'De nómina a nómina'], ['natural', 'Del 1 al 30/31']], s.cycleType)}
      </div>
      ${s.cycleType === 'nomina' ? `
        <label class="field"><span>Día en que sueles cobrar</span>
          <input type="number" min="1" max="31" inputmode="numeric" data-bind="payDay" data-kind="int" value="${s.payDay}">
          <small>Si ese día cae en fin de semana y cobras antes o después, no pasa nada: el nuevo ciclo empieza el día que marques <b>«He cobrado»</b>.</small>
        </label>` : `<small class="hint">La nómina que cobras a final de mes se usa para vivir el mes siguiente.</small>`}
      ${nav()}
    </div>`;
  }
  if (wizStep === 2) {
    return `<div class="wizard">${dots}
      <h2>Gastos fijos</h2>
      <p class="muted">Lo que pagas todos los meses sí o sí. Puedes poner el total o ir gasto a gasto.</p>
      ${fixedEditor()}
      ${nav()}
    </div>`;
  }
  if (wizStep === 3) {
    const natural = s.cycleType === 'natural';
    wizDraft.start ||= C.lastNominalPayday(C.todayStr(), s);
    return `<div class="wizard">${dots}
      <h2>Punto de partida</h2>
      <p class="muted">Para saber cómo vas, necesito saber con cuánto empezaste este ciclo.</p>
      <label class="field"><span>${natural ? 'Inicio del mes' : 'Día en que cobraste la última nómina'}</span>
        <input type="date" id="wz-start" value="${wizDraft.start}" max="${C.todayStr()}"></label>
      ${moneyField(natural ? 'Saldo de tu cuenta el día 1' : 'Saldo de tu cuenta justo después de cobrar', 'id="wz-balance"', wizDraft.balance,
        'Míralo en los movimientos de tu banco. Si no lo sabes exacto, pon una cifra aproximada.')}
      ${nav()}
    </div>`;
  }
  return `<div class="wizard">${dots}
    <h2>Revisiones</h2>
    <p class="muted">Cada cierto tiempo escribes el saldo de tu cuenta y te digo cómo vas. Elige cuándo te viene bien.</p>
    ${freqEditor()}
    ${nav('Empezar a usar Holgura')}
  </div>`;
}

function wizNext() {
  const s = state.settings;
  if (wizStep === 1 && !(s.salary > 0)) return toast('Escribe tu nómina mensual');
  if (wizStep === 3) {
    wizDraft.start = $('#wz-start').value || wizDraft.start;
    wizDraft.balance = $('#wz-balance').value;
    if (!Number.isFinite(parseMoney(wizDraft.balance))) return toast('Escribe el saldo de tu cuenta');
  }
  if (wizStep === 4) {
    state.cycle = {
      id: S.uid(), start: wizDraft.start, startBalance: parseMoney(wizDraft.balance),
      income: Number(s.salary) || 0, fixedTotal: 0, fixedItems: [], savingsGoal: null,
    };
    syncCycle();
    state.setup = true;
    tab = 'inicio';
    commit();
    toast('¡Listo! Ya puedes hacer tu primera revisión');
    return;
  }
  wizStep++;
  render();
  window.scrollTo(0, 0);
}

// ---------- Inicio ----------

// Pantalla que explica de dónde sale lo gastado en el día a día del semáforo
let spentDetail = false;

function viewSpentDetail(a, k) {
  const c = state.cycle, d = a.breakdown;
  const line = (label, value, cls = '', note = '') => `<div class="row ${cls}"><span>${label}${note ? `<small>${note}</small>` : ''}</span><strong>${value}</strong></div>`;
  const minus = v => `−&nbsp;${money(v)}`, plus = v => `+&nbsp;${money(v)}`;
  const drop = d.startBalance - d.balance;
  const ooNet = d.oneOffs.out - d.oneOffs.in;
  // Fijos "según banco" cuyo día ya pasó y el banco aún no ha reconocido (p. ej. llegan con otro importe)
  const tracked = C.trackedFixed(state, k.date);
  // (los que marcaste a mano en la revisión ya cuentan como cobrados)
  const notYet = tracked ? c.fixedItems.filter(i => tracked.ids.has(i.id) && !tracked.paidById[i.id]
    && i.day && C.chargeDateInCycle(i, c.start) <= k.date
    && !(k.trackedChecked && !(k.pendingIds || []).includes(i.id))) : [];

  let html = `<header class="top">
      <button class="link back" data-act="spent-back">‹ Inicio</button>
      <h1 class="sub-title">🧾 Lo gastado este ciclo</h1>
    </header>
    <section class="card">
      <h3>Cómo lo calculo</h3>
      <p class="muted">Miro cuánto ha bajado tu cuenta desde que cobraste y le quito lo que no es gasto del día a día.</p>
      <div class="rows breakdown">
        ${line('Saldo al empezar el ciclo', money(d.startBalance), '', dayFmt(c.start))}
        ${line('Saldo en tu última revisión', money(d.balance), '', `${dayFmt(k.date)}${d.earlyIncome ? ` · sin contar ${money(d.earlyIncome)} de la nómina siguiente` : ''}`)}
        ${line('Ha salido de la cuenta', money(drop), 'sub')}
        ${d.extra ? line('Ingresos extra que han entrado', plus(d.extra), '', 'también se han gastado o siguen en la cuenta') : ''}
        ${line('Gastos fijos ya cobrados', minus(d.fixedCharged))}
        ${ooNet ? line(ooNet > 0 ? 'Gastos puntuales' : 'Ingresos puntuales', ooNet > 0 ? minus(ooNet) : plus(-ooNet)) : ''}
        ${d.moved ? line(d.moved > 0 ? 'Pasado a tus huchas' : 'Sacado de tus huchas', d.moved > 0 ? minus(d.moved) : plus(-d.moved)) : ''}
        ${d.notMine ? line('Partes que no son tuyas', minus(d.notMine), '', 'gastos compartidos que te devolvieron en efectivo') : ''}
        ${line('Gastado en el día a día', money(a.variable), 'total')}
      </div>
      ${notYet.length ? `<p class="note">Según tu banco aún no te han cobrado <b>${notYet.map(i => esc(i.name || 'Sin nombre')).join(', ')}</b>, así que de momento cuenta${notYet.length > 1 ? 'n' : ''} como gasto del día a día. Si ya te ${notYet.length > 1 ? 'los' : 'lo'} han cobrado, márca${notYet.length > 1 ? 'los' : 'lo'} en tu próxima revisión, o búscalo en <b>Ver movimientos</b> y asígnalo a su gasto fijo para que se marque solo.</p>` : ''}
      ${a.variable < 0 ? '<p class="note">Sale negativo: ha bajado menos la cuenta de lo que suman los fijos. Puede que algún fijo marcado como cobrado aún no haya salido.</p>' : ''}
    </section>`;

  if (d.fixedList.length) {
    html += `<section class="card">
      <details class="analysis">
        <summary><h3>Fijos cobrados · ${money(d.fixedCharged)}</h3><span class="chev">›</span></summary>
        <div class="rows compact">${d.fixedList.map(i => line(esc(i.name || 'Sin nombre'), money(i.amount), '', i.tracked ? 'según banco' : '')).join('')}</div>
      </details>
    </section>`;
  }
  if (d.oneOffs.list.length) {
    html += `<section class="card">
      <h3>Puntuales</h3>
      <div class="rows compact">${d.oneOffs.list.map(e => line(esc(e.concept || 'Puntual'), e.amount > 0 ? plus(e.amount) : minus(-e.amount), '', dayFmt(e.date))).join('')}</div>
    </section>`;
  }

  // Lo mismo visto con los movimientos del banco, por categoría (aunque no tengan presupuesto)
  const sp = state.bankSpend?.cycleId === c.id ? state.bankSpend : null;
  if (sp) {
    const to = bizumTo();
    const cats = Object.keys(sp.byCat).filter(cat => !(cat === 'Bizum' && to));
    if (to && !cats.includes(to) && (sp.byCat.Bizum || sp.bizumIn)) cats.push(to);
    const rows = cats.map(cat => ({ cat, ...netSpent(cat, sp) })).filter(r => Math.abs(r.net) >= 0.005).sort((x, y) => y.net - x.net);
    const back = to ? 0 : sp.bizumIn || 0;
    const total = sum(rows, r => r.net) - back;
    const budgets = state.settings.budgets || {};
    const diff = a.variable - total;
    html += `<section class="card">
      <h3>Según tus movimientos del banco</h3>
      <p class="muted">Tus cargos del día a día por categoría, hasta el ${dateFmt(sp.at.slice(0, 10), { day: 'numeric', month: 'long' })}.</p>
      <div class="rows compact">
        ${rows.map(r => line(`${icon(r.cat)} ${esc(r.cat)}`, money(r.net), '', [
          r.back ? `${money(r.gross)} − ${money(r.back)} devuelto por Bizum` : '',
          budgets[r.cat] > 0 ? '' : 'sin presupuesto',
        ].filter(Boolean).join(' · '))).join('')}
        ${back ? line('Bizum recibidos', minus(back)) : ''}
        ${line('Total en el banco', money(total), 'total')}
      </div>
      ${Math.abs(diff) >= 1 ? `<p class="note">Hay <b>${money(Math.abs(diff))}</b> de diferencia con el cálculo por saldo. ${diff > 0
        ? 'Suele ser algún fijo que ha salido por un importe distinto, un cargo que aún no ha llegado al banco o gastos de antes de la última revisión que el banco aún no ha traído.'
        : 'Suele ser algún gasto de después de tu última revisión (el banco ya lo trae, el saldo de la revisión no) o un fijo que el banco no ha reconocido como tal.'}</p>` : ''}
      ${rows.some(r => !(budgets[r.cat] > 0)) ? '<p class="note">Las categorías «sin presupuesto» cuentan como gasto del día a día pero no salen en tu presupuesto del ciclo: por eso lo gastado puede no cuadrar con la suma del presupuesto.</p>' : ''}
      <button class="btn ghost block" data-act="bank-tx">Ver movimientos</button>
    </section>`;
  }
  return html;
}

function viewInicio() {
  const c = state.cycle, s = state.settings, today = C.todayStr();
  const info = C.cycleInfo(c, s);
  const last = lastCheckin();
  const a = last ? C.analyze(state, last) : null;
  if (spentDetail && a) return viewSpentDetail(a, last);
  const rec = C.recommendation(state, a);
  const natural = s.cycleType === 'natural';

  let html = header('Holgura', `${dateFmt(c.start)} → ${dateFmt(info.end)}${natural ? '' : ' (aprox.)'} · ${info.remaining === 0 ? 'ciclo terminado' : `quedan ${info.remaining} días`}`);

  if (info.paydaySoon) {
    html += natural
      ? banner('📅', '¡Empieza un nuevo mes!', 'Cierra el mes anterior para ver cómo te fue y empezar el nuevo.', 'cobro-open', 'Empezar')
      : banner('💶', '¿Ya has cobrado?', `Tu próximo cobro es hacia el ${dayFmt(info.end)}. Cuando te llegue la nómina, empieza el nuevo ciclo.`, 'cobro-open', 'He cobrado');
  }
  if (nextDue() <= today) {
    html += banner('📝', 'Te toca revisar', last ? `Última revisión: ${dayFmt(last.date)}.` : 'Aún no has hecho ninguna revisión en este ciclo.', 'go-revisar', 'Revisar');
  }

  html += a ? statusBlock(a, last) : `
    <section class="card empty">
      <h2>¿Cómo vas este mes?</h2>
      <p class="muted">Haz una revisión escribiendo el saldo de tu cuenta y te diré si llegas bien al próximo cobro.</p>
      <button class="btn primary" data-act="go-revisar">Hacer revisión</button>
    </section>`;

  html += budgetCard();
  html += monthCard(rec);
  html += debtsCard();
  html += jarsSummary();
  html += historyCard();
  html += analysisCard();
  return html;
}

// Cuánto se va cada mes en préstamos y financiación (gastos fijos de la categoría Deudas)
function debtsCard() {
  const s = state.settings;
  const items = s.fixedMode === 'desglose' ? s.fixedItems.filter(i => i.category === 'Deudas') : [];
  if (!items.length) return '';
  const total = sum(items, i => i.amount);
  const pct = s.salary > 0 ? Math.round((total / s.salary) * 100) : null;
  return `<section class="card">
    <h3>💳 Préstamos y financiación</h3>
    <p class="big">${money(total)}<span class="unit"> /mes</span></p>
    ${pct != null ? `<p class="muted">El <b>${pct} %</b> de tu nómina se va en cuotas.</p>
      <div class="bar debt"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}
    <div class="rows compact">${items.map(i => `<div class="row"><span>${esc(i.name)}</span><strong>${money(i.amount)}</strong></div>`).join('')}</div>
    ${items.some(i => /revolving/i.test(i.name)) ? '<p class="note">El revolving sube la cuota cada vez que dispones de dinero y suele tener intereses altos. Consulta en tu financiera cuánto te queda pendiente.</p>' : ''}
  </section>`;
}

// Resumen del análisis del extracto importado: media mensual por categoría
function analysisCard() {
  const a = state.analysis;
  if (!a?.categories?.length) return '';
  const vars = a.categories.filter(c => c.kind === 'variable').sort((x, y) => y.monthly - x.monthly);
  const max = Math.max(1, ...vars.map(c => c.monthly));
  const period = `${dateFmt(a.period.from, { month: 'short' })} – ${dateFmt(a.period.to, { month: 'short', year: 'numeric' })}`;
  return `<section class="card">
    <details class="analysis">
      <summary><h3>📊 Tu análisis · ${period}</h3><span class="chev">›</span></summary>
      <p class="muted">Media al mes de tus gastos del día a día:</p>
      ${vars.map(c => `<div class="cat-row">
        <span>${icon(c.category)} ${esc(c.label || c.category)}</span><strong>${money(c.monthly)}</strong>
        <span class="bar"><i style="width:${(c.monthly / max) * 100}%"></i></span>
      </div>`).join('')}
      ${a.notes?.length ? `<ul class="notes">${a.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </details>
  </section>`;
}

// Aplica un análisis de extracto: gastos fijos, historial para aprender, fin de semana y reglas de categorías
function applyAnalysis(a) {
  const items = a.fixedItems || [];
  const monthly = sum(items.filter(i => !i.months?.length), i => i.amount);
  const ok = confirm(`Análisis de tu cuenta (${a.period.from} → ${a.period.to}):

• Tus gastos fijos se sustituirán por los ${items.length} detectados (${money(monthly)} al mes).
• Se añadirán ${a.history.length} ciclos de nómina para que Holgura aprenda tu gasto real.
• Se activarán las reglas para clasificar tus movimientos.${a.budgets ? `
• Se propondrá un presupuesto por categorías (${money(sum(Object.values(a.budgets), v => v))} por ciclo).` : ''}

Tus revisiones y huchas no se tocan. ¿Continuar?`);
  if (!ok) return;
  const s = state.settings;
  s.fixedMode = 'desglose';
  s.fixedItems = items.map(i => ({
    id: S.uid(), name: i.name, amount: Number(i.amount) || 0, day: i.day ?? null, category: i.category || 'Otros',
    ...(i.months?.length ? { months: i.months } : {}),
  }));
  if (a.weekend) {
    s.fridayWeekend = Boolean(a.weekend.friday);
    s.weekendFactor = Number(a.weekend.factor) || s.weekendFactor;
  }
  // Los ciclos importados van antes de los reales y sustituyen a los de un análisis anterior
  const real = state.history.filter(h => !h.imported);
  const firstReal = real[0]?.start;
  const imported = (a.history || []).filter(h => !firstReal || h.end <= firstReal).map(h => ({ ...h, id: S.uid(), imported: true }));
  state.history = [...imported, ...real];
  state.rules = a.rules || [];
  if (a.budgets) { s.budgets = { ...a.budgets }; mergeBizumBudget(); }
  state.bankSpend = null; // las reglas han cambiado: se vuelve a calcular
  state.analysis = { period: a.period, categories: a.categories || [], notes: a.notes || [], importedAt: C.todayStr() };
  syncCycle();
  tab = 'inicio';
  commit();
  toast('Análisis importado');
}

function monthCard(rec) {
  const c = state.cycle, s = state.settings;
  const later = 'Cuando cierres tu primer ciclo lo ajustaré a lo que gastas de verdad.';
  const notes = {
    provisional: {
      20: `Cálculo provisional (regla 50/30/20: ahorrar el 20 % de la nómina). ${later}`,
      10: `Cálculo provisional: tus gastos fijos ya se llevan más de la mitad de la nómina, así que empiezo proponiendo ahorrar el 10 %. ${later}`,
      presupuesto: `Cálculo provisional: lo que te sobra menos tu presupuesto del día a día (${money(rec.planned)}) y un margen del ${s.safetyPct} %. ${later}`,
    }[rec.basis],
    mes: `Basado en lo que llevas gastado este ciclo (≈ ${money(rec.daily)}/día) más un margen de seguridad del ${s.safetyPct} %.`,
    historial: `Basado en tu gasto real de los últimos ciclos (≈ ${money(rec.daily)}/día) más un margen de seguridad del ${s.safetyPct} % (${money(rec.cushion)}).`,
  };
  const saved = C.netToJars(state, c.id, C.todayStr(), true);
  const goal = c.savingsGoal;

  let goalHtml;
  if (rec.sobrante <= 0) {
    goalHtml = '<p class="warn">Tus gastos fijos igualan o superan tu nómina: este mes no hay margen para ahorrar.</p>';
  } else if (goal == null) {
    goalHtml = rec.savings > 0
      ? `<div class="btn-row">
          <button class="btn primary" data-act="goal-apply" data-amount="${rec.savings}">Fijar ${money(rec.savings)} como objetivo</button>
          <button class="btn ghost" data-act="goal-edit">Otra cantidad</button></div>`
      : '<div class="btn-row"><button class="btn ghost" data-act="goal-edit">Fijar un objetivo de ahorro igualmente</button></div>';
  } else {
    const pct = goal > 0 ? Math.min(100, Math.max(0, (saved / goal) * 100)) : 100;
    goalHtml = `
      <div class="goal">
        <div class="goal-head"><span>Tu objetivo: <b>${money(goal)}</b></span><span>Apartado: <b>${money(saved)}</b></span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="btn-row">
        ${saved < goal ? `<button class="btn primary" data-act="move-new" data-type="in" data-amount="${Math.round((goal - saved) * 100) / 100}">Apartar en una hucha</button>` : '<span class="ok">✓ Objetivo cumplido</span>'}
        <button class="btn ghost" data-act="goal-edit">Cambiar</button>
      </div>`;
  }

  return `
    <section class="card">
      <h3>Este ciclo</h3>
      <div class="rows">
        <div class="row"><span>Nómina</span><strong>${money(rec.income)}</strong></div>
        <div class="row"><span>Gastos fijos</span><strong>− ${money(rec.fixed)}</strong></div>
        ${rec.oneOffs ? `<div class="row"><span>Ingresos y gastos puntuales</span><strong>${rec.oneOffs < 0 ? '− ' : '+ '}${money(Math.abs(rec.oneOffs))}</strong></div>` : ''}
        <div class="row total"><span>Te sobra</span><strong>${money(rec.sobrante)}</strong></div>
      </div>
      ${rec.sobrante > 0 ? `
      <div class="reco">
        <p class="eyebrow">Ahorro recomendado</p>
        <p class="big">${money(rec.savings)}</p>
        ${rec.savings > 0
          ? `<p>Te quedarían <b>${money(rec.dayToDay)}</b> para el día a día (${planSummary(rec.plan, rec.perDay)}).</p>`
          : `<p>Con tu gasto habitual${rec.daily ? ` (≈ ${money(rec.daily)}/día)` : ''} este ciclo no queda margen para ahorrar. Para llegar al cobro sin tirar de la hucha, el día a día tendría que quedarse en <b>${money(rec.dayToDay)}</b> (${planSummary(rec.plan, rec.perDay)}).</p>`}
        <p class="note">${notes[rec.source]}</p>
        ${rec.source === 'provisional' && !rec.planned ? `<p class="note">¿No te encaja? Reparte en <button class="link" data-act="tab" data-tab="mimes" data-sec="presupuesto">Presupuesto del día a día</button> lo que sueles gastar en comida, transporte… y ajusto la propuesta.</p>` : ''}
      </div>` : ''}
      ${goalHtml}
    </section>`;
}

function jarsSummary() {
  if (!state.jars.length) {
    return `<section class="card empty">
      <h3>Huchas</h3>
      <p class="muted">Crea una hucha para guardar lo que vas ahorrando.</p>
      <button class="btn ghost" data-act="jar-new">+ Crear hucha</button>
    </section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>Huchas</h3><button class="link" data-act="tab" data-tab="huchas">Ver todas</button></div>
    <p class="big">${money(jarsTotal())}</p>
    <div class="chips">${state.jars.slice(0, 4).map(j => `<button class="chip" data-act="jar-open" data-id="${j.id}">${esc(j.emoji)} ${esc(j.name)} · ${money(jarBalance(j.id))}</button>`).join('')}</div>
  </section>`;
}

function historyCard() {
  if (!state.history.length) return '';
  return `<section class="card">
    <h3>Ciclos anteriores</h3>
    <div class="hist">${state.history.slice(-6).reverse().map(h => `
      <div class="hist-row">
        <span class="hist-date">${dateFmt(h.start)} → ${dateFmt(h.end)}${h.imported ? ' <small>del extracto</small>' : ''}</span>
        <span>Día a día <b>${money(h.variable)}</b> <small>(${money(h.variable / Math.max(1, h.days))}/día)</small></span>
        <span>${h.saved == null ? `Fijos <b>${money(h.fixed)}</b>` : `Ahorrado <b>${money(h.saved)}</b>`}</span>
      </div>`).join('')}
    </div>
  </section>`;
}

// ---------- Revisar ----------

function pendingDefaults() {
  const c = state.cycle, last = lastCheckin(), today = C.todayStr();
  if (!c.fixedItems.length) return { mode: 'total', amount: last ? last.pendingFixed : c.fixedTotal };
  const tracked = C.trackedFixed(state);
  const seen = C.bankFixedSeen(state) || {};
  const ids = c.fixedItems.filter(i => {
    const d = C.chargeDateInCycle(i, c.start);
    // Las revisiones de antes de la v3.8 no guardaban el check de los "según banco"
    const lastSays = !last || (tracked?.ids.has(i.id) && !last.trackedChecked) ? true : (last.pendingIds || []).includes(i.id);
    // Si el banco ya muestra el cobro, se marca solo (salvo que lo desmarcaras en una revisión posterior)
    if (seen[i.id]) return last?.trackedChecked && last.date >= seen[i.id].date ? lastSays : false;
    if (!d || tracked?.ids.has(i.id)) return lastSays; // los "según banco" sin cobro visto: lo que marcaste tú
    if (d > today) return true;
    // Ya pasó el día de cobro: si revisaste después de esa fecha, manda lo que marcaste
    // (un recibo puede llegar más tarde, p. ej. el primer día laborable)
    return last && last.date >= d ? lastSays : false;
  }).map(i => i.id);
  return { mode: 'items', ids };
}

function viewRevisar() {
  const c = state.cycle, s = state.settings, today = C.todayStr();
  const next = nextDue();
  const pend = pendingDefaults();
  const last = lastBalance();
  const tracked = C.trackedFixed(state);
  const seen = C.bankFixedSeen(state);
  const [y, m, d] = today.split('-').map(Number);
  const showEarly = s.cycleType === 'natural' && d >= Math.min(s.payDay, 28) - 4;

  let html = header('Revisar', `Próxima revisión: <b>${next <= today ? 'hoy' : dayFmt(next)}</b> · ${freqLabel(s.checkFreq)}`);

  html += `<section class="card">
    <h3>Nueva revisión</h3>
    ${moneyField('Saldo actual de tu cuenta', 'id="ck-balance"', last ? inputNum(last.amount) : '', `<span id="bk-note">${balanceNote(last)}</span>`)}
    ${B.isReady() ? '<button class="btn ghost block bank-btn" data-act="bank-balance">🏦 Traer saldo del banco</button>' : ''}
    ${pend.mode === 'items' ? `
      <div class="field"><span>Gastos fijos que <b>ya</b> te han cobrado</span>
        <small class="hint">${seen ? 'Se marcan solos cuando veo el cargo en tu banco; puedes marcarlos o desmarcarlos tú.' : 'Marca cada uno cuando veas el cargo en tu banco.'} <b id="ck-charged">${chargedText(c.fixedItems.filter(i => !pend.ids.includes(i.id)))}</b></small>
        <div class="checks">${c.fixedItems.map(i => {
          const tr = tracked?.ids.has(i.id);
          const s = seen?.[i.id];
          const differs = s && Math.abs(s.amount - i.amount) >= 0.01;
          const note = [
            s ? `en tu banco el ${dayFmt(s.date)}` : tr ? 'según tu banco · aún no lo veo' : i.day ? `día ${i.day}` : '',
            differs ? `previsto ${money(i.amount)}` : '',
            tr && tracked.backById[i.id] ? `${money(tracked.backById[i.id])} devuelto` : '',
          ].filter(Boolean).join(' · ');
          return `
          <label class="check"><input type="checkbox" data-fixed-id="${i.id}" ${pend.ids.includes(i.id) ? '' : 'checked'}>
            <span>${esc(i.name || 'Sin nombre')}${note ? `<small>${note}</small>` : ''}</span><em>${money(differs ? Math.max(0, s.amount) : i.amount)}</em></label>`;
        }).join('')}
        ${tracked && c.fixedItems.some(i => tracked.ids.has(i.id) && !tracked.paidById[i.id] && i.day && C.chargeDateInCycle(i, c.start) <= today)
          ? '<small class="hint">¿Ya te han cobrado alguno que pone «aún no lo veo»? Márcalo tú y contará su importe. Para que la próxima vez se marque solo, búscalo en <b>Ver movimientos</b>, tócalo y asígnalo a su gasto fijo.</small>' : ''}
        </div>
      </div>` : c.fixedTotal > 0 ? moneyField('Gastos fijos que aún no te han cobrado', 'id="ck-pending"', numStr(pend.amount), `De tus ${money(c.fixedTotal)} de gastos fijos.`) : ''}
    ${showEarly ? `<label class="check solo"><input type="checkbox" id="ck-early"><span>Ya me ha llegado la nómina del mes que viene</span></label>` : ''}
    <label class="field"><span>Fecha</span><input type="date" id="ck-date" value="${today}" min="${c.start}" max="${today}"></label>
    <button class="btn primary block" data-act="checkin-save">Guardar</button>
  </section>`;

  html += oneOffsCard();

  const list = cycleCheckins().reverse();
  if (list.length) {
    html += `<section class="card"><h3>Revisiones de este ciclo</h3><div class="list">
      ${list.map(k => {
        const a = C.analyze(state, k);
        return `<button class="list-row" data-act="checkin-open" data-id="${k.id}">
          <span class="dot dot-${a.status}"></span>
          <span class="grow">${dayFmt(k.date)}</span>
          <span class="muted">${money(k.balance)}</span><span class="chev">›</span></button>`;
      }).join('')}
    </div></section>`;
  }

  if (B.isReady()) {
    html += `<section class="card">
      <h3>Movimientos del ciclo</h3>
      <p class="muted">Lo que ha entrado y salido de tu cuenta desde el ${dateFmt(c.start)}, leído de tu banco.</p>
      <button class="btn ghost block" data-act="bank-tx">Ver movimientos</button>
    </section>`;
  }

  html += `<section class="card">
    <h3>Recordatorio</h3>
    <p class="muted">Revisas ${freqLabel(s.checkFreq)} a las ${s.reminderTime}. Añádelo a tu Calendario para que el móvil te avise.</p>
    <div class="btn-row">
      <button class="btn ghost" data-act="ics">📅 Añadir al Calendario</button>
      <button class="btn ghost" data-act="tab" data-tab="mimes" data-sec="revisiones">Cambiar</button>
    </div>
  </section>`;
  return html;
}

// Último saldo conocido: el último que escribiste o trajiste del banco (o el de la última revisión)
function lastBalance() {
  if (state.lastBalance) return state.lastBalance;
  const k = [...state.checkins].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return k ? { amount: k.balance, at: `${k.date}T12:00:00`, source: 'manual' } : null;
}
const inputNum = n => String(Math.round(n * 100) / 100).replace('.', ',');

function balanceNote(last) {
  if (!last) return B.isReady() ? 'Escríbelo o tráelo de tu banco.' : 'El que ves ahora mismo en la app de tu banco.';
  const at = new Date(last.at);
  const when = isNaN(at) ? '' : at.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Último saldo ${last.source === 'bank' ? 'traído de tu banco' : 'informado'}${when ? ` (${when})` : ''}. ${B.isReady() ? 'Actualízalo o tráelo de nuevo del banco.' : 'Cámbialo si ha variado.'}`;
}

function setLastBalance(amount, source, at = new Date().toISOString()) {
  if (!Number.isFinite(amount)) return;
  state.lastBalance = { amount, at, source };
  persist();
}

// ---------- Ingresos y gastos puntuales ----------

function oneOffsCard() {
  const oo = C.cycleOneOffs(state);
  return `<section class="card">
    <h3>Ingresos y gastos puntuales</h3>
    <p class="muted">Lo que entra o sale una sola vez (Hacienda, una multa, una venta, un regalo…). Suma o resta a lo que te sobra este ciclo y no cuenta como gasto del día a día.</p>
    ${oo.list.length ? `<div class="list">${oo.list.map(e => `
      <div class="list-row static">
        <span class="mv ${e.amount > 0 ? 'in' : 'out'}">${e.amount > 0 ? '＋' : '−'}</span>
        <span class="grow">${esc(e.concept)}<small>${dayFmt(e.date)}${e.source === 'bank' ? ' · detectado en tu banco' : ''}</small></span>
        <strong class="${e.amount < 0 ? 'neg' : 'pos'}">${e.amount < 0 ? '− ' : '+ '}${money(Math.abs(e.amount))}</strong>
        ${e.source === 'manual' ? `<button class="icon-btn" data-act="oneoff-del" data-id="${e.id}" aria-label="Eliminar">✕</button>` : ''}
      </div>`).join('')}</div>` : ''}
    <div class="btn-row two">
      <button class="btn ghost" data-act="oneoff-new" data-type="out">− Gasto puntual</button>
      <button class="btn ghost" data-act="oneoff-new" data-type="in">＋ Ingreso puntual</button>
    </div>
    ${oo.list.some(e => e.source === 'bank') ? '<small class="hint">Los impuestos que detecta tu banco se apuntan solos: no hace falta añadirlos.</small>' : ''}
  </section>`;
}

function openOneOffForm(type) {
  const c = state.cycle;
  openSheet(type === 'in' ? 'Ingreso puntual' : 'Gasto puntual', `
    <label class="field"><span>Concepto</span><input id="oo-concept" placeholder="${type === 'in' ? 'Ej.: Venta de la bici' : 'Ej.: Pago a Hacienda'}"></label>
    ${moneyField('Importe', 'id="oo-amount"', '')}
    <label class="field"><span>Fecha</span><input type="date" id="oo-date" value="${C.todayStr()}" min="${c.start}" max="${C.todayStr()}"></label>
    <button class="btn primary block" data-act="oneoff-save">Guardar</button>`, { oneOffType: type });
}

// Cobrados hasta ahora: los marcados a mano + lo retirado de verdad para los fijos "según banco"
// Redibuja Revisar sin perder lo que ya habías tocado en el formulario (checks, fecha, ingresos extra)
function renderKeepingForm(seenBefore = null) {
  const checks = Object.fromEntries([...document.querySelectorAll('[data-fixed-id]')].map(el => [el.dataset.fixedId, el.checked]));
  const keep = ['ck-date', 'ck-extra', 'ck-pending'].map(id => [id, $(`#${id}`)?.value]);
  const early = $('#ck-early')?.checked;
  render();
  // Lo que acabas de tocar se respeta, salvo los cobros que el banco acaba de mostrar por primera vez: esos se marcan
  const seenNow = C.bankFixedSeen(state) || {};
  if (seenBefore) for (const id of Object.keys(seenNow)) if (!seenBefore[id]) checks[id] = true;
  for (const el of document.querySelectorAll('[data-fixed-id]')) if (el.dataset.fixedId in checks) el.checked = checks[el.dataset.fixedId];
  for (const [id, v] of keep) if (v != null && $(`#${id}`)) $(`#${id}`).value = v;
  if (early != null && $('#ck-early')) $('#ck-early').checked = early;
  const counter = $('#ck-charged');
  if (counter) counter.textContent = chargedText(state.cycle.fixedItems.filter(i => checks[i.id]));
}

function chargedText(marked) {
  // Los "según banco" ya cobrados cuentan lo que salió de verdad; el resto, su importe
  const tracked = C.trackedFixed(state);
  const charged = sum(marked, i => (tracked?.paidById[i.id] ? tracked.byId[i.id] : i.amount));
  return `Cobrados: ${money(charged)} de ${money(C.cycleFixedTotal(state))}.`;
}

function saveCheckin() {
  const c = state.cycle, today = C.todayStr();
  const balance = parseMoney($('#ck-balance').value);
  if (!Number.isFinite(balance)) return toast('Escribe el saldo de tu cuenta');
  const date = $('#ck-date').value || today;
  let pendingFixed = 0, pendingIds = [];
  if (c.fixedItems.length) {
    // Marcado = ya cobrado; los que quedan sin marcar son los pendientes
    pendingIds = [...document.querySelectorAll('[data-fixed-id]')].filter(el => !el.checked).map(el => el.dataset.fixedId);
    pendingFixed = sum(c.fixedItems.filter(i => pendingIds.includes(i.id)), i => i.amount);
  } else if ($('#ck-pending')) {
    pendingFixed = Math.min(c.fixedTotal, Math.max(0, parseMoney($('#ck-pending').value) || 0));
  }
  const k = {
    id: S.uid(), cycleId: c.id, date, balance, pendingFixed, pendingIds,
    trackedChecked: true, // los "según banco" también llevan check (antes de la v3.8 se guardaban siempre como pendientes)
    extraIncome: 0, // los ingresos extra ahora van en "Ingresos y gastos puntuales" del ciclo
    earlyIncome: $('#ck-early')?.checked ? Number(state.settings.salary) || 0 : 0,
  };
  if (state.lastBalance?.amount !== balance) setLastBalance(balance, 'manual');
  // Una revisión por día: la nueva sustituye a la anterior
  state.checkins = state.checkins.filter(x => !(x.cycleId === c.id && x.date === date));
  state.checkins.push(k);
  commit();
  openCheckinResult(k.id);
  // El presupuesto del ciclo se actualiza solo con los movimientos del banco
  if (B.isReady()) refreshSpend({ silent: true });
}

function openCheckinResult(id) {
  const k = state.checkins.find(x => x.id === id);
  if (!k) return;
  const a = C.analyze(state, k);
  const canWithdraw = a.status === 'red' && state.jars.length;
  openSheet('Resultado de la revisión', `
    ${statusBlock(a, k)}
    ${a.elapsed < 5 && !state.history.length ? '<p class="note">Con tan pocos días la previsión es orientativa: al principio del ciclo se suele gastar más (compra grande, recibos…). Se irá afinando con cada revisión.</p>' : ''}
    <div class="rows compact">
      <div class="row"><span>Llevas</span><strong>${a.elapsed} de ${a.totalDays} días</strong></div>
      ${a.pendingFixed ? `<div class="row"><span>Gastos fijos pendientes</span><strong>${money(a.pendingFixed)}</strong></div>` : ''}
    </div>
    <div class="btn-col">
      ${canWithdraw ? `<button class="btn primary block" data-act="move-new" data-type="out" data-amount="${Math.ceil(a.deficit)}">Retirar de una hucha</button>` : ''}
      <button class="btn ${canWithdraw ? 'ghost' : 'primary'} block" data-act="sheet-close">Entendido</button>
      <button class="btn text danger block" data-act="checkin-del" data-id="${k.id}">Eliminar esta revisión</button>
    </div>`, { checkinId: id });
}

// ---------- Huchas ----------

function viewHuchas() {
  let html = header('Huchas', `Total ahorrado: <b>${money(jarsTotal())}</b>`);
  if (!state.jars.length) {
    html += `<section class="card empty">
      <div class="empty-emoji">🐷</div>
      <h2>Aún no tienes huchas</h2>
      <p class="muted">Crea una por cada cosa para la que ahorras: emergencias, un viaje, el coche… Si ya tienes dinero ahorrado, ponlo como saldo inicial.</p>
    </section>`;
  } else {
    html += `<div class="jars">${state.jars.map(j => {
      const bal = jarBalance(j.id);
      const pct = j.goal ? Math.min(100, Math.max(0, (bal / j.goal) * 100)) : null;
      return `<button class="jar card" data-act="jar-open" data-id="${j.id}">
        <span class="jar-emoji">${esc(j.emoji)}</span>
        <span class="jar-name">${esc(j.name)}</span>
        <strong class="jar-bal">${money(bal)}</strong>
        ${pct != null ? `<span class="bar"><i style="width:${pct}%"></i></span><small>${Math.round(pct)} % de ${money(j.goal)}</small>` : ''}
      </button>`;
    }).join('')}</div>`;
  }
  html += '<button class="btn primary block" data-act="jar-new">+ Nueva hucha</button>';
  return html;
}

function openJar(id) {
  const j = state.jars.find(x => x.id === id);
  if (!j) return;
  const bal = jarBalance(id);
  const moves = state.moves.filter(m => m.jarId === id).reverse().sort((a, b) => b.date.localeCompare(a.date));
  openSheet(`${esc(j.emoji)} ${esc(j.name)}`, `
    <p class="big center">${money(bal)}</p>
    ${j.goal ? `<div class="goal"><div class="bar"><i style="width:${Math.min(100, Math.max(0, bal / j.goal * 100))}%"></i></div><p class="muted center">Objetivo: ${money(j.goal)}</p></div>` : ''}
    <div class="btn-row two">
      <button class="btn primary" data-act="move-new" data-type="in" data-jar="${id}">＋ Ingresar</button>
      <button class="btn ghost" data-act="move-new" data-type="out" data-jar="${id}">− Retirar</button>
    </div>
    <h3>Movimientos</h3>
    ${moves.length ? `<div class="list">${moves.map(m => `
      <div class="list-row static">
        <span class="mv ${m.type}">${m.type === 'in' ? '＋' : '−'}</span>
        <span class="grow">${esc(m.note || (m.type === 'in' ? 'Ingreso' : 'Retirada'))}<small>${dayFmt(m.date)}${m.account ? ' · cuenta' : ''}</small></span>
        <strong class="${m.type === 'out' ? 'neg' : ''}">${m.type === 'in' ? '' : '− '}${money(m.amount)}</strong>
        <button class="icon-btn" data-act="move-del" data-id="${m.id}" aria-label="Eliminar movimiento">✕</button>
      </div>`).join('')}</div>` : '<p class="muted">Sin movimientos todavía.</p>'}
    <div class="btn-row">
      <button class="btn text" data-act="jar-edit" data-id="${id}">Editar hucha</button>
      <button class="btn text danger" data-act="jar-del" data-id="${id}">Eliminar hucha</button>
    </div>`, { jarId: id });
}

function openJarForm(id = null) {
  const j = id ? state.jars.find(x => x.id === id) : null;
  const emoji = j?.emoji || EMOJIS[0];
  openSheet(j ? 'Editar hucha' : 'Nueva hucha', `
    <label class="field"><span>Nombre</span><input id="jar-name" placeholder="Ej.: Emergencias" value="${esc(j?.name || '')}"></label>
    <div class="field"><span>Icono</span><div class="emoji-pick">
      ${EMOJIS.map(e => `<label><input type="radio" name="jar-emoji" value="${e}" ${e === emoji ? 'checked' : ''}><span>${e}</span></label>`).join('')}
    </div></div>
    ${moneyField('Objetivo (opcional)', 'id="jar-goal"', numStr(j?.goal || 0), 'Si ahorras para algo concreto, te enseño cuánto te falta.')}
    ${j ? '' : moneyField('Dinero que ya tienes ahorrado', 'id="jar-initial"', '', 'Se guarda como saldo inicial; no cuenta como gasto de este mes.')}
    <button class="btn primary block" data-act="jar-save">${j ? 'Guardar' : 'Crear hucha'}</button>`, { jarId: id });
}

function saveJar() {
  const name = $('#jar-name').value.trim();
  if (!name) return toast('Ponle un nombre a la hucha');
  const emoji = document.querySelector('input[name="jar-emoji"]:checked')?.value || EMOJIS[0];
  const goal = parseMoney($('#jar-goal').value);
  const data = { name, emoji, goal: Number.isFinite(goal) && goal > 0 ? goal : null };
  let id = sheetCtx?.jarId;
  if (id) {
    Object.assign(state.jars.find(x => x.id === id), data);
  } else {
    id = S.uid();
    state.jars.push({ id, ...data });
    const initial = parseMoney($('#jar-initial').value);
    if (initial > 0) state.moves.push({ id: S.uid(), jarId: id, date: C.todayStr(), type: 'in', amount: initial, note: 'Saldo inicial', account: false, cycleId: null });
  }
  commit();
  openJar(id);
}

function openMoveForm({ type = 'in', jarId = null, amount = '', carry = null } = {}) {
  if (!state.jars.length) { toast('Primero crea una hucha'); return openJarForm(); }
  jarId ||= state.jars[0].id;
  openSheet(type === 'in' ? 'Ingresar en hucha' : 'Retirar de hucha', `
    ${seg('move-type', [['in', '＋ Ingreso'], ['out', '− Retirada']], type)}
    <label class="field"><span>Hucha</span><select id="mv-jar">
      ${state.jars.map(j => `<option value="${j.id}" ${j.id === jarId ? 'selected' : ''}>${esc(j.emoji)} ${esc(j.name)} (${money(jarBalance(j.id))})</option>`).join('')}
    </select></label>
    ${moneyField('Importe', 'id="mv-amount"', numStr(Number(amount) || 0))}
    <label class="field"><span>Fecha</span><input type="date" id="mv-date" value="${C.todayStr()}" max="${C.todayStr()}"></label>
    <label class="field"><span>Nota (opcional)</span><input id="mv-note" placeholder="${type === 'in' ? 'Ej.: Ahorro de noviembre' : 'Ej.: Reparación del coche'}"></label>
    <label class="check solo"><input type="checkbox" id="mv-account" checked>
      <span>${type === 'in' ? 'El dinero sale de mi cuenta corriente' : 'El dinero vuelve a mi cuenta corriente'}</span></label>
    <small class="hint">Déjalo marcado para que lo tenga en cuenta al calcular cómo vas este mes. Desmárcalo si es dinero que no pasa por tu cuenta (un regalo en efectivo, intereses…).</small>
    <button class="btn primary block" data-act="move-save">${type === 'in' ? 'Ingresar' : 'Retirar'}</button>`, { type, carry });
}

function saveMove() {
  const { type, carry } = sheetCtx;
  const jarId = $('#mv-jar').value;
  const amount = parseMoney($('#mv-amount').value);
  if (!(amount > 0)) return toast('Escribe un importe');
  if (type === 'out' && amount > jarBalance(jarId) + 0.005) return toast(`En esa hucha solo hay ${money(jarBalance(jarId))}`);
  const date = $('#mv-date').value || C.todayStr();
  const account = $('#mv-account').checked;
  state.moves.push({
    id: S.uid(), jarId, date, type, amount, account,
    note: $('#mv-note').value.trim(),
    cycleId: state.cycle && date >= state.cycle.start ? state.cycle.id : null,
    carry: Boolean(carry),
  });
  // Lo que sobró del ciclo anterior cuenta como ahorro de ese ciclo en el historial
  if (carry) {
    const h = state.history.find(x => x.id === carry);
    if (h) h.saved = Math.round((h.saved + amount) * 100) / 100;
  }
  commit();
  toast(type === 'in' ? `Has ingresado ${money(amount)}` : `Has retirado ${money(amount)}`);
  openJar(jarId);
}

// ---------- Nuevo ciclo (He cobrado) ----------

function openCobro() {
  const s = state.settings, natural = s.cycleType === 'natural';
  openSheet(natural ? 'Empezar nuevo mes' : 'He cobrado', `
    <p class="muted">Cierro el ciclo actual, guardo cómo te fue y empiezo uno nuevo.</p>
    <label class="field"><span>${natural ? 'Primer día del nuevo mes' : 'Día en que has cobrado'}</span>
      <input type="date" id="cb-date" value="${C.todayStr()}" min="${C.addDays(state.cycle.start, 1)}" max="${C.todayStr()}"></label>
    ${moneyField(natural ? 'Nómina con la que vivirás este mes' : 'Importe de la nómina', 'id="cb-salary"', numStr(s.salary), 'Cámbialo si este mes es distinto (paga extra, horas extra…).')}
    ${moneyField('Saldo de tu cuenta ahora', 'id="cb-balance"', '', 'Ya con la nómina dentro.')}
    <button class="btn primary block" data-act="cobro-save">Empezar nuevo ciclo</button>`);
}

function saveCobro() {
  const date = $('#cb-date').value || C.todayStr();
  const salary = parseMoney($('#cb-salary').value);
  const balance = parseMoney($('#cb-balance').value);
  if (!(salary > 0)) return toast('Escribe el importe de la nómina');
  if (!Number.isFinite(balance)) return toast('Escribe el saldo de tu cuenta');
  if (date <= state.cycle.start) return toast('La fecha debe ser posterior al inicio del ciclo');

  const closed = C.closeCycle(state, date, balance - salary);
  state.history.push(closed);
  state.cycle = {
    id: S.uid(), start: date, startBalance: balance, income: salary,
    fixedTotal: 0, fixedItems: [], savingsGoal: null,
  };
  syncCycle();
  commit();

  const leftover = Math.round((closed.income - closed.fixed - (closed.oneOffOut || 0) - closed.variable - closed.saved) * 100) / 100;
  openSheet('Resumen del ciclo', `
    <p class="muted center">${dateFmt(closed.start)} → ${dateFmt(closed.end)}</p>
    <div class="rows">
      <div class="row"><span>Ingresos</span><strong>${money(closed.income)}</strong></div>
      <div class="row"><span>Gastos fijos</span><strong>− ${money(closed.fixed)}</strong></div>
      <div class="row"><span>Día a día</span><strong>− ${money(closed.variable)}</strong></div>
      <div class="row"><span>Apartado a huchas</span><strong>${money(closed.saved)}</strong></div>
      <div class="row total"><span>${leftover >= 0 ? 'Te sobró sin ahorrar' : 'Te faltó'}</span><strong class="${leftover < 0 ? 'neg' : ''}">${money(Math.abs(leftover))}</strong></div>
    </div>
    ${leftover > 1 ? `<p>¿Quieres pasar lo que te sobró a una hucha?</p>
      <button class="btn primary block" data-act="move-new" data-type="in" data-amount="${leftover}" data-carry="${closed.id}">Pasar ${money(leftover)} a una hucha</button>` : ''}
    <button class="btn ghost block" data-act="sheet-close">Ver el nuevo ciclo</button>`);
}

// ---------- Mi mes ----------

// Mi mes es un menú: cada apartado se abre en su propia pantalla (la de una sola página era demasiado larga)
let mimesSection = null;

// Quita el título de una tarjeta cuando ya lo lleva la cabecera de la pantalla
const untitled = html => html.replace(/<h3>[^<]*<\/h3>/, '');

const MIMES_SECTIONS = {
  ingresos: {
    icon: '💶', title: 'Ingresos',
    summary: s => `${money(s.salary)}/mes · ${s.cycleType === 'natural' ? 'del 1 al 30/31' : `cobras hacia el día ${s.payDay}`}`,
    view: s => `<section class="card">
      ${moneyField('Nómina mensual', 'data-bind="salary" data-kind="money"', numStr(s.salary))}
      <div class="field"><span>¿Cómo cuentas el mes?</span>${seg('cycleType', [['nomina', 'De nómina a nómina'], ['natural', 'Del 1 al 30/31']], s.cycleType)}</div>
      <label class="field"><span>Día en que sueles cobrar</span>
        <input type="number" min="1" max="31" inputmode="numeric" data-bind="payDay" data-kind="int" data-rerender value="${s.payDay}"></label>
    </section>`,
  },
  fijos: {
    icon: '🧾', title: 'Gastos fijos',
    summary: s => `${money(C.fixedTotalOf(s))}/mes · ${s.fixedMode === 'total' ? 'importe total' : `${s.fixedItems.length} gastos`}`,
    view: () => `<section class="card">${fixedEditor()}</section>`,
  },
  presupuesto: {
    icon: '🎯', title: 'Presupuesto del día a día',
    summary: () => `Repartido ${money(budgetTotal())} de ${money(dayToDayAvailable())}`,
    view: () => untitled(budgetSection()),
  },
  revisiones: {
    icon: '🔔', title: 'Revisiones',
    summary: s => `${freqLabel(s.checkFreq).replace(/^./, ch => ch.toUpperCase())} a las ${s.reminderTime}`,
    view: () => `<section class="card">
      ${freqEditor()}
      <button class="btn ghost block" data-act="ics">📅 Añadir recordatorio al Calendario</button>
    </section>`,
  },
  gastar: {
    icon: '📊', title: 'Lo que puedes gastar y ahorro',
    summary: s => `Por ${s.allowanceView === 'semana' ? 'semana' : 'día'} · finde ${String(C.effectiveSettings(state).weekendFactor).replace('.', ',')}× · margen ${s.safetyPct} %`,
    view: s => `<section class="card">
      <h3>Lo que puedes gastar</h3>
      <div class="field"><span>Quiero verlo</span>${seg('allowanceView', [['dia', 'Por día'], ['semana', 'Por semana']], s.allowanceView)}</div>
      <div class="field"><span>¿Cuánto más gastas el fin de semana?</span>
        ${seg('weekendMode', [['auto', 'Que lo aprenda'], ['manual', 'Lo elijo yo']], s.weekendMode)}
      </div>
      ${weekendSettings()}
      <label class="check solo"><input type="checkbox" data-bind="fridayWeekend" data-kind="bool" data-rerender ${s.fridayWeekend ? 'checked' : ''}>
        <span>El viernes cuenta como fin de semana</span></label>
    </section>
    <section class="card">
      <h3>Recomendación de ahorro</h3>
      <div class="field"><span>Margen de seguridad para imprevistos</span>
        ${seg('safetyPct', [[10, '10 %'], [15, '15 %'], [20, '20 %'], [25, '25 %']], s.safetyPct)}
        <small>Cuánto dejo de colchón sobre lo que sueles gastar antes de recomendarte ahorrar. Más margen = más tranquilidad, menos ahorro.</small>
      </div>
    </section>`,
  },
  ciclo: {
    icon: '🔄', title: 'Ciclo actual',
    summary: () => `Desde el ${dateFmt(state.cycle.start)} · empezó con ${money(state.cycle.startBalance)}`,
    view: s => `<section class="card">
      <label class="field"><span>Empezó el</span><input type="date" data-cbind="start" value="${state.cycle.start}" max="${C.todayStr()}"></label>
      ${moneyField('Saldo al empezar', 'data-cbind="startBalance"', numStr(state.cycle.startBalance))}
      <button class="btn ghost block" data-act="cobro-open">${s.cycleType === 'natural' ? 'Empezar nuevo mes' : 'He cobrado: empezar nuevo ciclo'}</button>
    </section>`,
  },
  banco: {
    icon: '🏦', title: 'Conexión con el banco',
    summary: () => {
      const st = bankUI.status;
      if (!B.getConfig().password) return 'Opcional · requiere servidor propio';
      if (st?.connected) return `Conectado a ${st.bank}${st.validUntil ? ` · hasta el ${dateFmt(st.validUntil.slice(0, 10))}` : ''}`;
      return st ? 'Sin conectar o caducada' : 'Comprobando…';
    },
    view: () => untitled(bankSection()),
  },
  datos: {
    icon: '💾', title: 'Tus datos',
    summary: () => 'Copias de seguridad e importar',
    view: () => `<section class="card">
      <p class="muted">Todo se guarda solo en este móvil. Haz una copia de vez en cuando por si cambias de móvil o borras la app.</p>
      <div class="btn-col">
        <button class="btn ghost block" data-act="export">⬇️ Exportar copia de seguridad</button>
        <button class="btn ghost block" data-act="import">⬆️ Importar copia de seguridad</button>
        <button class="btn ghost block" data-act="import">📊 Importar análisis del banco</button>
        <button class="btn text danger block" data-act="reset">Borrar todos los datos</button>
      </div>
    </section>`,
  },
};

function viewMiMes() {
  const s = state.settings;
  const sec = MIMES_SECTIONS[mimesSection];
  if (sec) {
    return `<header class="top">
        <button class="link back" data-act="mimes-back">‹ Mi mes</button>
        <h1 class="sub-title">${sec.icon} ${sec.title}</h1>
      </header>${sec.view(s)}`;
  }
  return header('Mi mes', 'Tus datos y preferencias') + `
    <section class="card menu">${Object.entries(MIMES_SECTIONS).map(([id, m]) => `
      <button class="menu-row" data-act="mimes-open" data-sec="${id}">
        <span class="menu-icon">${m.icon}</span>
        <span class="grow"><b>${m.title}</b><small>${esc(m.summary(s))}</small></span>
        <span class="chev">›</span>
      </button>`).join('')}
    </section>
    <p class="footer">Holgura · v3.8</p>`;
}

// ---------- Presupuesto por categorías ----------

// Lo que hay para el día a día en este ciclo: nómina − fijos − objetivo de ahorro
const dayToDayAvailable = () => {
  const c = state.cycle;
  if (!c) return 0;
  const oo = C.cycleOneOffs(state);
  return c.income + oo.in - oo.out - C.cycleFixedTotal(state) - (Number(c.savingsGoal) || 0);
};
const budgetTotal = () => sum(budgetCategories(), c => (state.settings.budgets || {})[c] || 0);

function budgetSummaryText() {
  const total = budgetTotal(), avail = dayToDayAvailable();
  const diff = avail - total;
  return `Repartido <b>${money(total)}</b> de <b>${money(avail)}</b>${Math.abs(diff) >= 1
    ? (diff > 0 ? ` · quedan ${money(diff)} sin repartir` : ` · <span class="neg">te pasas ${money(-diff)}</span>`) : ' ✓'}`;
}

function budgetSection() {
  const b = state.settings.budgets || {};
  return `<section class="card">
    <h3>Presupuesto del día a día</h3>
    <p class="muted">${B.isReady()
      ? 'Reparte por categorías lo que te queda tras los gastos fijos. Holgura lo compara con tus movimientos del banco y te avisa si vas rápido.'
      : 'Reparte por categorías lo que sueles gastar en el día a día (comida, transporte, ocio…). Mientras no tenga tu historial, lo uso para proponerte un ahorro que te deje lo suficiente para vivir. Lo que gastas lo sigo con tus revisiones de saldo.'}</p>
    <div class="budget-list">${budgetCategories().map(cat => `
      <label class="budget-row"><span>${icon(cat)} ${cat}</span>
        <div class="money-input"><input inputmode="decimal" placeholder="—" data-budget="${cat}" value="${numStr(b[cat] || 0)}" aria-label="Tope de ${cat}"><em>€</em></div>
      </label>`).join('')}
    </div>
    <p class="fx-total" id="budget-summary">${budgetSummaryText()}</p>
    ${B.isReady() ? `<label class="field"><span>Los Bizum cuentan en…</span>
      <select data-bind="bizumTo" data-kind="text" data-rerender>
        ${BUDGET_CATEGORIES.filter(c => c !== 'Bizum').map(c => `<option value="${c}" ${state.settings.bizumTo === c ? 'selected' : ''}>${icon(c)} ${c}</option>`).join('')}
        <option value="" ${!state.settings.bizumTo ? 'selected' : ''}>Ninguna (los veo aparte, con su propio tope)</option>
      </select>
      <small>Los que envías suman en esa categoría y los que te devuelven restan: si pagas una cena y te devuelven tu parte, cuenta solo lo tuyo.</small>
    </label>` : ''}
  </section>`;
}

// Categoría a la que van los Bizum (los que envías suman y los que te devuelven restan); '' = aparte
const bizumTo = () => state.settings.bizumTo || '';
// Categorías con tope: si los Bizum van a otra categoría, "Bizum" deja de tener tope propio
const budgetCategories = () => BUDGET_CATEGORIES.filter(c => !(c === 'Bizum' && bizumTo()));

// Nunca por debajo de 0: una devolución de algo pagado en el ciclo anterior no "regala" presupuesto en este
function netSpent(cat, sp) {
  const isTo = Boolean(sp) && cat === bizumTo();
  const sent = isTo ? Math.max(0, sp.byCat.Bizum || 0) : 0;
  const gross = Math.max(0, sp?.byCat[cat] || 0) + sent;
  const back = isTo ? Math.min(sp.bizumIn || 0, gross) : 0;
  return { gross, sent, back, net: Math.max(0, Math.round((gross - back) * 100) / 100) };
}

function budgetStatus(spent, budget, elapsedFrac) {
  if (spent > budget) return 'red';
  if (spent / budget > Math.min(1, elapsedFrac + 0.15)) return 'yellow';
  return 'green';
}

function budgetCard() {
  const b = state.settings.budgets || {};
  const cats = budgetCategories().filter(c => b[c] > 0);
  // Sin banco no hay gasto por categoría que enseñar (sería «0 € de 220 €» siempre): el presupuesto solo sirve para planificar
  if (!cats.length || !state.cycle || !B.isReady()) return '';
  const info = C.cycleInfo(state.cycle, state.settings);
  const elapsedFrac = info.elapsed / info.totalDays;
  const sp = state.bankSpend?.cycleId === state.cycle.id ? state.bankSpend : null;
  const remainingDays = Math.max(1, info.remaining);
  const totalSpent = sp ? sum(cats, c => netSpent(c, sp).net) : 0;
  const bizumAside = sp?.bizumIn && !(bizumTo() && cats.includes(bizumTo()));

  const rows = cats.map(cat => {
    const budget = b[cat];
    const { gross, sent, back, net: spent } = netSpent(cat, sp);
    const left = budget - spent;
    const st = budgetStatus(Math.max(0, spent), budget, elapsedFrac);
    // Por categoría se entiende mejor por semana que por día (1,50 €/día en bares no dice mucho)
    const pace = left > 0 && remainingDays > 7 ? `(≈ ${money((left / remainingDays) * 7)}/semana)` : '';
    return `<div class="budget-item">
      <div class="budget-top"><span>${icon(cat)} ${cat}</span><strong>${money(Math.max(0, spent))} <small>de ${money(budget)}</small></strong></div>
      <span class="bar budget-${st}"><i style="width:${Math.min(100, Math.max(0, spent / budget) * 100)}%"></i><b style="left:${Math.min(100, elapsedFrac * 100)}%"></b></span>
      ${back || sent ? `<small>${money(gross)} gastado${sent ? ` (${money(sent)} por Bizum)` : ''}${back ? ` <span class="pos">− ${money(back)} devuelto por Bizum</span>` : ''}</small>` : ''}
      <small class="${st === 'red' ? 'neg' : ''}">${left >= 0 ? `Te quedan ${money(left)} ${pace}` : `Te has pasado ${money(-left)}`}</small>
    </div>`;
  }).join('');

  return `<section class="card">
    <h3>🎯 Presupuesto del ciclo</h3>
    ${sp ? `<p class="muted">Llevas <b>${money(Math.max(0, totalSpent))}</b> de ${money(budgetTotal())} · día ${info.elapsed} de ${info.totalDays}${bizumAside ? ` · <span class="pos">+${money(sp.bizumIn)} devueltos por Bizum</span>` : ''}</p>`
      : '<p class="muted">Se actualiza solo al traer el saldo del banco o al guardar una revisión.</p>'}
    ${rows}
    ${sp ? `<p class="note">Actualizado ${new Date(sp.at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. La rayita marca hasta dónde «tocaría» llevar gastado hoy.</p>` : ''}
  </section>`;
}

// Si los Bizum van a una categoría, su tope propio se suma a esa categoría (el reparto total no cambia)
function mergeBizumBudget() {
  const s = state.settings, b = s.budgets || {};
  if (!s.bizumTo || !b.Bizum) return false;
  b[s.bizumTo] = (b[s.bizumTo] || 0) + b.Bizum;
  delete b.Bizum;
  return true;
}

// Lee los movimientos del ciclo, guarda el gasto por categoría y avisa de lo que va rápido
async function refreshSpend({ silent = false, list = null } = {}) {
  const c = state.cycle;
  if (!c || !B.isReady()) return;
  try {
    const txs = list || applyAdjustments((await B.transactions(c.start)).transactions.map(t => ({ ...t, ...categorize(t, state.rules) })));
    state.bankSpend = { cycleId: c.id, at: new Date().toISOString(), ...spendByCategory(txs) };
    persist();
    const b = state.settings.budgets || {};
    const info = C.cycleInfo(c, state.settings);
    const alerts = budgetCategories().filter(cat => b[cat] > 0)
      .map(cat => ({ cat, st: budgetStatus(Math.max(0, netSpent(cat, state.bankSpend).net), b[cat], info.elapsed / info.totalDays) }))
      .filter(a => a.st !== 'green');
    if (alerts.length && !list) {
      const worst = alerts.find(a => a.st === 'red') || alerts[0];
      toast(worst.st === 'red' ? `Te has pasado en ${worst.cat}` : `Ojo: vas rápido en ${worst.cat}`);
    } else if (!silent && !list) toast('Presupuesto actualizado');
    rerenderIf('inicio');
  } catch (err) {
    if (!silent) bankError(err);
  }
}

// ---------- Conexión con el banco ----------

function bankSection() {
  const cfg = B.getConfig(), st = bankUI.status;
  let body;
  if (!cfg.password) {
    body = `<p class="muted"><b>No lo necesitas para usar Holgura</b>: todo funciona escribiendo el saldo de tu cuenta en cada revisión.</p>
      <p class="note">Solo sirve si tienes tu propio servidor de Holgura conectado a tu banco (solo lectura: nadie puede mover dinero). Si no sabes qué es, ignora este apartado.</p>
      <label class="field"><span>Contraseña de tu servidor</span>
        <input type="password" id="bk-pass" autocomplete="current-password" placeholder="Contraseña del servidor"></label>
      <button class="btn primary block" data-act="bank-save-pass">Guardar</button>`;
  } else if (bankUI.loading && !st) {
    body = '<p class="muted">Comprobando la conexión…</p>';
  } else if (bankUI.error) {
    body = `<p class="warn">${esc(bankUI.error)}</p>
      <div class="btn-row"><button class="btn ghost" data-act="bank-refresh">Reintentar</button>
      <button class="btn text" data-act="bank-forget">Cambiar contraseña</button></div>`;
  } else if (!st) {
    body = '<p class="muted">Comprobando la conexión…</p>';
  } else if (!st.connected) {
    body = `${st.status && st.status !== 'AUTHORIZED' ? '<p class="warn">El permiso del banco ha caducado o se ha cancelado. Vuelve a conectar.</p>' : ''}
      <p class="muted">Te llevaré a CaixaBank para que autorices el acceso de solo lectura (con la app de CaixaBank). Al terminar, vuelve a Holgura.</p>
      <button class="btn primary block" data-act="bank-connect">🏦 Conectar con mi banco</button>
      <button class="btn text block" data-act="bank-forget">Olvidar contraseña de este móvil</button>`;
  } else {
    const until = st.validUntil ? st.validUntil.slice(0, 10) : null;
    const days = until ? C.diffDays(C.todayStr(), until) : null;
    body = `<div class="learn">
        <p>✅ Conectado a <b>${esc(st.bank)}</b></p>
        ${until ? `<p class="note">Permiso válido hasta el ${dateFmt(until, { day: 'numeric', month: 'long', year: 'numeric' })} (${days} días). Te avisaré para renovarlo.</p>` : ''}
      </div>
      ${st.accounts.length > 1 ? `<label class="field"><span>Cuenta de la nómina</span><select id="bk-account">
          <option value="">Elige una cuenta…</option>
          ${st.accounts.map(a => `<option value="${esc(a.uid)}" ${a.uid === cfg.account ? 'selected' : ''}>${esc(a.name)} ${esc(a.iban)}</option>`).join('')}
        </select></label>` : st.accounts.map(a => `<p class="muted">🏦 ${esc(a.name)} ${esc(a.iban)}</p>`).join('')}
      <div class="btn-row">
        <button class="btn ghost" data-act="bank-connect">Renovar permiso</button>
        <button class="btn text danger" data-act="bank-disconnect">Desconectar</button>
      </div>`;
  }
  return `<section class="card"><h3>Conexión con el banco</h3>${body}</section>`;
}

const rerenderIf = t => { if (state.setup && tab === t && !sheetRoot.innerHTML) render(); };

async function loadBankStatus() {
  if (!B.getConfig().password || bankUI.loading) return;
  bankUI.loading = true;
  bankUI.error = null;
  try {
    const st = await B.status();
    bankUI.status = st;
    const cfg = B.getConfig();
    if (st.connected && !st.accounts.some(a => a.uid === cfg.account)) {
      B.saveConfig({ account: st.accounts.length === 1 ? st.accounts[0].uid : null });
    }
  } catch (err) {
    if (err.code === 'bad_password') { B.saveConfig({ password: null }); toast('La contraseña del servidor no es correcta'); }
    else bankUI.error = err.message;
  } finally {
    bankUI.loading = false;
    rerenderIf('mimes');
    rerenderIf('revisar');
  }
}

function bankError(err) {
  if (err.code === 'expired' || err.code === 'not_connected') {
    bankUI.status = null;
    toast('La conexión con el banco ha caducado: renuévala en Mi mes');
  } else if (err.code === 'bad_password') {
    B.saveConfig({ password: null });
    toast('La contraseña del servidor no es correcta');
  } else {
    toast(err.message);
  }
}

async function startBankConnect(bank) {
  try {
    if (!bank) {
      const { banks } = await B.banks();
      if (!banks.length) throw new Error('No encuentro CaixaBank ni imagin en Enable Banking');
      if (banks.length > 1) {
        return openSheet('¿Con qué banco conectas?', `
          <p class="muted">Elige el mismo que vinculaste en Enable Banking.</p>
          <div class="btn-col">${banks.map(b => `<button class="btn ghost block" data-act="bank-pick" data-name="${esc(b.name)}">${esc(b.name)}</button>`).join('')}</div>`);
      }
      bank = banks[0].name;
    }
    B.saveConfig({ bank });
    toast('Abriendo tu banco…');
    const { url } = await B.connect(bank);
    location.href = url;
  } catch (err) {
    bankError(err);
  }
}

let txCache = []; // últimos movimientos mostrados (para ver el detalle de uno)

// Ajustes: de un cargo solo cuenta una parte como gasto tuyo (p. ej. un gasto compartido del que otra persona te devuelve su parte en efectivo)
const adjKey = t => `${t.date}|${Math.round(Number(t.amount) * 100) / 100}`;
function applyAdjustments(list) {
  return list.map(t => {
    const a = (state.adjustments || []).find(x => x.key === adjKey(t));
    return a ? { ...t, original: t.amount, amount: Math.sign(t.amount) * a.counted, adjusted: a } : t;
  });
}

// Todo lo que manda el banco de un movimiento: sirve para ver por qué se clasificó así
function openTxDetail(i) {
  const t = txCache[i];
  if (!t) return;
  const row = (label, value) => (value || value === 0 ? `<div class="row"><span>${label}</span><strong class="wrap">${esc(value)}</strong></div>` : '');
  const amount = t.original ?? t.amount;
  openSheet('Detalle del movimiento', `
    <p class="big center ${amount < 0 ? 'neg' : 'pos'}">${amount < 0 ? '− ' : '+ '}${money(Math.abs(amount))}</p>
    ${t.adjusted ? `<p class="muted center">Cuenta como gasto tuyo: <b>${money(t.adjusted.counted)}</b>${t.adjusted.note ? ` · ${esc(t.adjusted.note)}` : ''}</p>` : ''}
    <div class="rows compact">
      ${row('Categoría', `${icon(t.category)} ${t.label || t.category}${t.fixed ? ' (gasto fijo)' : ''}`)}
      ${row('Fecha', t.date ? dayFmt(t.date) : '')}
      ${row('Descripción / concepto', t.description)}
      ${row('Ordenante o beneficiario', t.counterparty)}
      ${row('Código de operación', t.code)}
      ${row('Nota del banco', t.note)}
      ${row('Referencia', t.reference || t.id)}
      ${row('Código de comercio (MCC)', t.mcc)}
      ${row('Cuenta de contrapartida', t.counterAccount ? 'Sí' : 'No')}
      ${row('Estado', t.pending ? 'Pendiente' : 'Contabilizado')}
    </div>
    ${state.settings.fixedItems.length ? `<div class="learn">
      <label class="field"><span>¿Es uno de tus gastos fijos?</span>
        <select id="tx-fixed">
          <option value="">Elige el gasto fijo…</option>
          ${state.settings.fixedItems.map(f => `<option value="${esc(f.id)}">${esc(f.name || 'Sin nombre')}</option>`).join('')}
        </select>
        <small>Desde ahora, todo movimiento con este concepto contará para ese gasto con el importe que traiga el banco.</small>
      </label>
      <button class="btn primary block" data-act="tx-assign" data-i="${i}">Asignar</button>
    </div>` : ''}
    <p class="note">Si está mal clasificado, haz una captura de esta pantalla y pásamela para ajustar las reglas.</p>
    <button class="btn ghost block" data-act="bank-tx">‹ Volver a los movimientos</button>`);
}

// Patrón para reconocer el concepto de un movimiento en los meses siguientes: se saltan las fechas y las
// referencias largas (cambian cada mes), pero se mantienen los números cortos (p. ej. el final de un préstamo)
function conceptPattern(t) {
  const words = String(t.description || t.counterparty || '').replace(/;/g, ' ').toUpperCase().split(/\s+/)
    .filter(w => w && !/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(w) && !/\d{6,}/.test(w)).slice(0, 8);
  return words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

// Asigna un movimiento del banco a un gasto fijo: ese gasto pasa a contar "según banco" con el importe real
function assignToFixed(t, fixedId) {
  const item = state.settings.fixedItems.find(f => f.id === fixedId);
  const match = conceptPattern(t);
  if (!item || !match) return false;
  item.key ||= `f-${item.id}`;
  for (const ci of state.cycle?.fixedItems || []) if (ci.id === item.id) ci.key = item.key;
  const dir = (t.original ?? t.amount) < 0 ? 'out' : 'in';
  // Va la primera y por delante del Bizum: es una decisión tuya sobre ese concepto concreto
  state.rules = [
    { match, dir, first: true, category: item.category || 'Otros', label: item.name, fixed: true, charge: { [item.key]: '*' } },
    ...(state.rules || []).filter(r => !(r.match === match && r.dir === dir)),
  ];
  return true;
}

async function openTransactions() {
  const c = state.cycle;
  openSheet('Movimientos', '<p class="muted center">Leyendo tus movimientos del banco…</p>');
  try {
    const { transactions } = await B.transactions(c.start);
    const list = applyAdjustments(transactions.map(t => ({ ...t, ...categorize(t, state.rules) })));
    refreshSpend({ list }); // de paso, actualiza el presupuesto
    const raw = t => t.original ?? t.amount; // lo que movió el banco (sin ajustes)
    const income = sum(list.filter(t => raw(t) > 0), raw);
    const spent = -sum(list.filter(t => raw(t) < 0), raw);
    const days = [...new Set(list.map(t => t.date))];

    // Salidas por categoría (de mayor a menor); las devoluciones restan de su categoría (p. ej. Waylet)
    const byCat = new Map();
    for (const t of list) {
      const refund = t.amount > 0 && t.category !== 'Bizum' && BUDGET_CATEGORIES.includes(t.category);
      if (t.amount < 0 || refund) byCat.set(t.category, (byCat.get(t.category) || 0) - t.amount);
    }
    const cats = [...byCat].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...cats.map(([, v]) => v));

    openSheet('Movimientos', `
      <p class="muted center">Desde el ${dayFmt(c.start)} · ${list.length} movimientos</p>
      <div class="stats two">
        <div><span>Entradas</span><strong class="pos">+ ${money(income)}</strong></div>
        <div><span>Salidas</span><strong class="neg">− ${money(spent)}</strong></div>
      </div>
      ${cats.length ? `<h3>En qué se ha ido</h3>
        ${cats.map(([cat, v]) => `<div class="cat-row">
          <span>${icon(cat)} ${esc(cat)}</span><strong>${money(v)}</strong>
          <span class="bar"><i style="width:${(v / max) * 100}%"></i></span>
        </div>`).join('')}` : ''}
      ${list.length ? days.map(d => `
        <h3>${d ? dayFmt(d) : 'Sin fecha'}</h3>
        <div class="list">${list.filter(t => t.date === d).map(t => `
          <button class="list-row" data-act="tx-detail" data-i="${list.indexOf(t)}">
            <span class="mv ${t.amount >= 0 ? 'in' : 'out'}">${icon(t.category)}</span>
            <span class="grow tx-desc">${esc(t.description)}<small>${esc(t.label || t.category)}${t.adjusted ? ` · cuenta ${money(t.adjusted.counted)}` : ''}${t.pending ? ' · pendiente' : ''}</small></span>
            <strong class="${raw(t) < 0 ? 'neg' : 'pos'}">${raw(t) < 0 ? '− ' : '+ '}${money(Math.abs(raw(t)))}</strong>
          </button>`).join('')}</div>`).join('') : '<p class="muted center">No hay movimientos en este ciclo.</p>'}`);
    txCache = list;
  } catch (err) {
    closeSheet();
    bankError(err);
  }
}

const fmtFactor = f => `${String(f).replace('.', ',')}×`;

function weekendSettings() {
  const s = state.settings;
  const factors = seg('weekendFactor', [[1, 'Igual'], [1.5, '1,5×'], [2, '2×'], [3, '3×']], s.weekendFactor);
  if (s.weekendMode !== 'auto') {
    return `<div class="field">${factors}
      <small>Comparado con un día entre semana. Con 2×, si entre semana te tocan 20 €/día, el fin de semana te tocarán 40 €/día. Así la previsión no se asusta el lunes tras un finde movido.</small></div>`;
  }
  const L = C.learnWeekend(state);
  const info = L.learned == null
    ? `<p><b>Aún estoy aprendiendo.</b> Mientras tanto uso <b>${fmtFactor(L.prior)}</b>: un día de fin de semana cuenta como ${String(L.prior).replace('.', ',')} días entre semana.</p>
       <p class="note">Para aprenderlo necesito revisiones en días distintos de la semana: por ejemplo, revisar <b>cada 3 o 4 días</b>, o hacer alguna revisión suelta un viernes y un lunes. Si siempre revisas el mismo día, todas las semanas se parecen y no puedo separar el fin de semana del resto.</p>`
    : `<p>Según tus revisiones, un día de fin de semana gastas <b>${fmtFactor(Math.round(L.learned * 10) / 10)}</b> lo de un día entre semana.</p>
       <p class="note">${L.confidence < 1
        ? `Aún tengo pocos datos (${L.informative} de 6 tramos útiles), así que lo mezclo con tu punto de partida: ahora uso <b>${fmtFactor(L.factor)}</b>.`
        : `Ya tengo datos suficientes: uso <b>${fmtFactor(L.factor)}</b> y lo seguiré ajustando con cada revisión.`}</p>`;
  return `<div class="learn">${info}</div>
    <div class="field"><span>Punto de partida mientras aprendo</span>${factors}</div>`;
}

// ---------- Archivos (copia de seguridad y calendario) ----------

async function shareOrDownload(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function buildICS() {
  const s = state.settings, f = s.checkFreq;
  const [hh, mm] = (s.reminderTime || '21:00').split(':');
  const start = `${nextDue().replace(/-/g, '')}T${hh}${mm}00`;
  const byday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][Number(f.weekday)];
  const rrule = {
    diaria: 'FREQ=DAILY',
    cadaX: `FREQ=DAILY;INTERVAL=${f.every}`,
    semanal: `FREQ=WEEKLY;BYDAY=${byday}`,
    mensual: `FREQ=MONTHLY;BYMONTHDAY=${f.monthDay}`,
  }[f.type];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.href.split('#')[0];
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Holgura//ES', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:holgura-revision-${S.uid()}`, `DTSTAMP:${stamp}`,
    `DTSTART:${start}`, 'DURATION:PT10M', `RRULE:${rrule}`,
    'SUMMARY:💶 Holgura: revisa tu saldo', `DESCRIPTION:Abre Holgura y escribe el saldo de tu cuenta.\\n${url}`, `URL:${url}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Revisa tu saldo en Holgura', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

// ---------- Hojas (bottom sheets) ----------

function openSheet(title, body, ctx = null) {
  sheetCtx = ctx;
  sheetRoot.innerHTML = `
    <div class="backdrop" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title.replace(/<[^>]+>/g, ''))}">
      <div class="grabber"></div>
      <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="sheet-close" aria-label="Cerrar">✕</button></div>
      <div class="sheet-body">${body}</div>
    </div>`;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => sheetRoot.classList.add('open'));
}

function closeSheet() {
  sheetRoot.classList.remove('open');
  sheetRoot.innerHTML = '';
  document.body.classList.remove('sheet-open');
  sheetCtx = null;
}

// ---------- Acciones ----------

const actions = {
  tab: el => {
    closeSheet(); tab = el.dataset.tab;
    if (tab === 'mimes') mimesSection = el.dataset.sec || null; // pulsar Mi mes vuelve al menú (o abre el apartado pedido)
    if (tab === 'inicio') spentDetail = false;
    render(); window.scrollTo(0, 0);
    if (tab === 'mimes') loadBankStatus();
  },
  'spent-open': () => { spentDetail = true; render(); window.scrollTo(0, 0); },
  'spent-back': () => { spentDetail = false; render(); window.scrollTo(0, 0); },
  'mimes-open': el => { mimesSection = el.dataset.sec; render(); window.scrollTo(0, 0); },
  'mimes-back': () => { mimesSection = null; render(); window.scrollTo(0, 0); },
  'go-revisar': () => { tab = 'revisar'; render(); window.scrollTo(0, 0); },
  'wiz-next': wizNext,
  'wiz-back': () => { wizStep = Math.max(0, wizStep - 1); render(); },

  seg: el => {
    const { path, value } = el.dataset;
    if (path === 'move-type') { // dentro de la hoja de movimiento: se vuelve a abrir con el otro tipo
      return openMoveForm({ type: value, jarId: $('#mv-jar').value, amount: parseMoney($('#mv-amount').value) || '', carry: sheetCtx?.carry });
    }
    const prevSalary = state.settings.salary;
    setPath(state.settings, path, /^\d+(\.\d+)?$/.test(value) ? Number(value) : value);
    if (path === 'cycleType') wizDraft.start = null;
    syncCycle(prevSalary);
    commit();
    if (sheetCtx?.checkinId) openCheckinResult(sheetCtx.checkinId); // cambio Día/Semana dentro del resultado
  },

  'fixed-add': () => openFixedForm(),
  'fixed-edit': el => openFixedForm(el.dataset.id),
  'fixed-save': () => {
    const name = $('#fx-name').value.trim();
    const amount = parseMoney($('#fx-amount').value);
    if (!name) return toast('Ponle un nombre al gasto');
    if (!(amount >= 0)) return toast('Escribe el importe');
    const d = parseInt($('#fx-day').value, 10);
    const data = { name, amount, category: $('#fx-cat').value, day: d >= 1 && d <= 31 ? d : null };
    const id = sheetCtx?.fixedId;
    if (id) Object.assign(state.settings.fixedItems.find(i => i.id === id), data);
    else state.settings.fixedItems.push({ id: S.uid(), ...data });
    closeSheet();
    syncCycle();
    commit();
    toast(id ? 'Gasto guardado' : 'Gasto añadido');
  },
  'fixed-del': el => {
    const item = state.settings.fixedItems.find(i => i.id === el.dataset.id);
    if (!item || !confirm(`¿Eliminar «${item.name || 'este gasto'}» de tus gastos fijos?`)) return;
    state.settings.fixedItems = state.settings.fixedItems.filter(i => i.id !== el.dataset.id);
    closeSheet();
    syncCycle();
    commit();
  },

  'goal-apply': el => { state.cycle.savingsGoal = Number(el.dataset.amount); commit(); toast('Objetivo de ahorro fijado'); },
  'goal-edit': () => openSheet('Objetivo de ahorro', `
    ${moneyField('¿Cuánto quieres ahorrar este ciclo?', 'id="goal-amount"', numStr(state.cycle.savingsGoal ?? C.recommendation(state).savings))}
    <button class="btn primary block" data-act="goal-save">Guardar</button>
    ${state.cycle.savingsGoal != null ? '<button class="btn text danger block" data-act="goal-clear">Quitar objetivo</button>' : ''}`),
  'goal-save': () => {
    const v = parseMoney($('#goal-amount').value);
    if (!(v >= 0)) return toast('Escribe una cantidad');
    state.cycle.savingsGoal = v;
    closeSheet(); commit();
  },
  'goal-clear': () => { state.cycle.savingsGoal = null; closeSheet(); commit(); },

  'checkin-save': saveCheckin,
  'checkin-open': el => openCheckinResult(el.dataset.id),
  'checkin-del': el => {
    if (!confirm('¿Eliminar esta revisión?')) return;
    state.checkins = state.checkins.filter(k => k.id !== el.dataset.id);
    closeSheet(); commit();
  },

  'cobro-open': openCobro,
  'cobro-save': saveCobro,

  'jar-new': () => openJarForm(),
  'jar-open': el => openJar(el.dataset.id),
  'jar-edit': el => openJarForm(el.dataset.id),
  'jar-save': saveJar,
  'jar-del': el => {
    const j = state.jars.find(x => x.id === el.dataset.id);
    if (!confirm(`¿Eliminar la hucha «${j.name}» y todos sus movimientos?`)) return;
    state.jars = state.jars.filter(x => x.id !== j.id);
    state.moves = state.moves.filter(m => m.jarId !== j.id);
    closeSheet(); commit();
  },
  'move-new': el => openMoveForm({
    type: el.dataset.type, jarId: el.dataset.jar || sheetCtx?.jarId, amount: el.dataset.amount || '', carry: el.dataset.carry || null,
  }),
  'move-save': saveMove,
  'move-del': el => {
    if (!confirm('¿Eliminar este movimiento?')) return;
    const jarId = sheetCtx?.jarId;
    state.moves = state.moves.filter(m => m.id !== el.dataset.id);
    commit();
    openJar(jarId);
  },

  ics: () => shareOrDownload('holgura-recordatorio.ics', buildICS(), 'text/calendar'),
  export: () => shareOrDownload(`holgura-copia-${C.todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json'),
  import: () => $('#import-file').click(),
  reset: () => {
    if (!confirm('Se borrarán tu configuración, revisiones y huchas de este móvil. ¿Seguro?')) return;
    if (!confirm('Esta acción no se puede deshacer. ¿Borrar todo?')) return;
    S.clearAll();
    state = S.load();
    wizStep = 0; wizDraft = { start: null, balance: '' }; tab = 'inicio';
    render();
  },
  'sheet-close': closeSheet,

  'bank-save-pass': () => {
    const pw = $('#bk-pass').value.trim();
    if (pw.length < 8) return toast('La contraseña tiene al menos 8 caracteres');
    B.saveConfig({ password: pw });
    bankUI = { status: null, loading: false, error: null };
    render();
    loadBankStatus();
  },
  'bank-refresh': () => { bankUI.error = null; render(); loadBankStatus(); },
  'bank-forget': () => { B.clearConfig(); bankUI = { status: null, loading: false, error: null }; render(); },
  'bank-connect': () => startBankConnect(B.getConfig().bank),
  'bank-pick': el => { closeSheet(); startBankConnect(el.dataset.name); },
  'bank-disconnect': async () => {
    if (!confirm('¿Desconectar tu banco? Holgura dejará de poder leer tu saldo y tus movimientos.')) return;
    try {
      await B.disconnect();
      B.saveConfig({ account: null });
      bankUI.status = null;
      toast('Banco desconectado');
      loadBankStatus();
    } catch (err) { bankError(err); }
  },
  'bank-balance': async el => {
    el.disabled = true;
    el.textContent = 'Consultando tu banco…';
    try {
      const b = await B.balance();
      $('#ck-balance').value = inputNum(b.amount);
      setLastBalance(b.amount, 'bank');
      // De paso se leen los movimientos: así se marcan solos los gastos fijos que ya te han cobrado
      const seenBefore = C.bankFixedSeen(state) || {};
      await refreshSpend({ silent: true });
      if (tab === 'revisar') renderKeepingForm(seenBefore);
      const note = $('#bk-note');
      if (note) note.textContent = `${balanceNote(state.lastBalance)} Puedes corregirlo antes de guardar.`;
      toast('Saldo y movimientos traídos del banco');
    } catch (err) {
      bankError(err);
    } finally {
      el.disabled = false;
      el.textContent = '🏦 Traer saldo del banco';
    }
  },
  'bank-tx': openTransactions,
  'tx-detail': el => openTxDetail(Number(el.dataset.i)),
  'tx-assign': el => {
    const t = txCache[Number(el.dataset.i)];
    const fixedId = $('#tx-fixed').value;
    if (!fixedId) return toast('Elige a qué gasto fijo corresponde');
    if (!t || !assignToFixed(t, fixedId)) return toast('No se ha podido asignar este movimiento');
    persist();
    toast(`Asignado a ${state.settings.fixedItems.find(f => f.id === fixedId)?.name || 'ese gasto'}`);
    openTransactions(); // vuelve a la lista y recalcula presupuesto y fijos con la regla nueva
  },
  'oneoff-new': el => openOneOffForm(el.dataset.type),
  'oneoff-save': () => {
    const concept = $('#oo-concept').value.trim();
    const amount = parseMoney($('#oo-amount').value);
    if (!concept) return toast('Escribe el concepto');
    if (!(amount > 0)) return toast('Escribe el importe');
    const type = sheetCtx?.oneOffType;
    state.cycle.extras = [...(state.cycle.extras || []),
      { id: S.uid(), date: $('#oo-date').value || C.todayStr(), concept, amount: type === 'in' ? amount : -amount }];
    closeSheet();
    commit();
    toast(type === 'in' ? 'Ingreso puntual apuntado' : 'Gasto puntual apuntado');
  },
  'oneoff-del': el => {
    if (!confirm('¿Eliminar este movimiento puntual?')) return;
    state.cycle.extras = (state.cycle.extras || []).filter(e => e.id !== el.dataset.id);
    commit();
  },
  'spend-refresh': async el => {
    el.textContent = 'Leyendo…';
    await refreshSpend();
    render();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  actions[el.dataset.act]?.(el);
});

// Campos de configuración: se guardan al salir del campo, sin redibujar (para no cerrar el teclado)
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.bind) {
    const kind = el.dataset.kind;
    let v = el.value;
    if (kind === 'money') v = Math.max(0, parseMoney(v) || 0);
    if (kind === 'int') {
      // Los límites salen del propio campo: el día de la semana admite 0 (domingo)
      const n = parseInt(v, 10);
      v = Number.isFinite(n) ? n : Number(el.min || 1);
      if (el.min) v = Math.max(Number(el.min), v);
      if (el.max) v = Math.min(Number(el.max), v);
    }
    if (kind === 'bool') v = el.checked;
    if (el.dataset.bind === 'reminderTime' && !v) { el.value = state.settings.reminderTime; return; }
    const prevSalary = state.settings.salary;
    setPath(state.settings, el.dataset.bind, v);
    if (el.dataset.bind === 'bizumTo') mergeBizumBudget();
    syncCycle(prevSalary);
    persist();
    if ('rerender' in el.dataset) render();
  } else if (el.dataset.cbind) {
    if (el.dataset.cbind === 'start' && el.value) state.cycle.start = el.value;
    if (el.dataset.cbind === 'startBalance') { const v = parseMoney(el.value); if (Number.isFinite(v)) state.cycle.startBalance = v; }
    persist();
  } else if (el.id === 'ck-balance') {
    // Se recuerda aunque no guardes la revisión: al volver a la app sigue ahí
    const v = parseMoney(el.value);
    if (Number.isFinite(v) && v !== state.lastBalance?.amount) setLastBalance(v, 'manual');
  } else if (el.dataset.fixedId) {
    const ids = [...document.querySelectorAll('[data-fixed-id]')].filter(x => x.checked).map(x => x.dataset.fixedId);
    const counter = $('#ck-charged');
    if (counter) counter.textContent = chargedText(state.cycle.fixedItems.filter(i => ids.includes(i.id)));
  } else if (el.dataset.budget) {
    const v = Math.max(0, parseMoney(el.value) || 0);
    state.settings.budgets = { ...(state.settings.budgets || {}), [el.dataset.budget]: v };
    if (!v) delete state.settings.budgets[el.dataset.budget];
    persist();
    const summary = $('#budget-summary');
    if (summary) summary.innerHTML = budgetSummaryText();
  } else if (el.id === 'bk-account') {
    B.saveConfig({ account: el.value || null });
    toast(el.value ? 'Cuenta elegida' : 'Elige una cuenta para traer el saldo');
  } else if (el.id === 'import-file' && el.files[0]) {
    el.files[0].text().then(text => {
      try {
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error('El archivo no es una copia de seguridad de Holgura'); }
        if (parsed?.type === 'holgura-analisis') return applyAnalysis(parsed);
        const data = S.importData(text);
        if (!confirm('Se sustituirán los datos actuales por los de la copia. ¿Continuar?')) return;
        state = data;
        // Si la copia no trae un ciclo válido se vuelve a empezar el asistente desde el principio
        wizStep = 0; wizDraft = { start: null, balance: '' }; tab = 'inicio';
        commit();
        toast(state.setup ? 'Copia de seguridad importada' : 'Copia importada: falta el ciclo actual, vuelve a completar el inicio');
      } catch (err) {
        toast(err.message);
      } finally {
        el.value = '';
      }
    });
  }
});

// El saldo también se guarda mientras escribes (en el móvil puedes salir de la app sin "salir" del campo)
document.addEventListener('input', e => {
  if (e.target.id !== 'ck-balance') return;
  const v = parseMoney(e.target.value);
  if (Number.isFinite(v)) { state.lastBalance = { amount: v, at: new Date().toISOString(), source: 'manual' }; persist(); }
});

// ---------- Render ----------

function render() {
  try {
    if (!state.setup) {
      tabbar.hidden = true;
      view.innerHTML = viewWizard();
      return;
    }
    tabbar.hidden = false;
    view.innerHTML = { inicio: viewInicio, revisar: viewRevisar, huchas: viewHuchas, mimes: viewMiMes }[tab]();
    tabbar.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  } catch (err) {
    // Si algún dato raro rompe la pantalla, al menos se puede sacar una copia o empezar de cero
    console.error(err);
    tabbar.hidden = true;
    view.innerHTML = `<div class="wizard">
      <h2>Algo ha fallado al mostrar tus datos</h2>
      <p class="muted">Saca una copia de seguridad antes de nada y pásamela para revisarla. Si no tiene arreglo, puedes borrar los datos de este móvil y empezar de nuevo.</p>
      <p class="note">${esc(err.message)}</p>
      <div class="btn-col">
        <button class="btn primary block" data-act="export">⬇️ Exportar copia de seguridad</button>
        <button class="btn text danger block" data-act="reset">Borrar todos los datos</button>
      </div>
    </div>`;
  }
}

// Al volver a la app (puede haber cambiado el día) se recalcula todo
// Al volver del banco también se comprueba si la conexión ya está hecha
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!sheetRoot.innerHTML) render();
  if (tab === 'mimes' || (B.getConfig().password && !B.isReady())) loadBankStatus();
});

if (mergeBizumBudget()) persist(); // v2.6: el tope de "Bizum" pasa a la categoría de los Bizum
render();
if (B.getConfig().password) loadBankStatus();

// Con el banco conectado, el gasto (presupuesto y "hoy llevas") se actualiza solo al abrir la app,
// como mucho cada hora para no pedir datos al banco a cada momento
const spendAge = state.bankSpend ? Date.now() - new Date(state.bankSpend.at) : Infinity;
if (state.setup && B.isReady()
    && (state.bankSpend?.cycleId !== state.cycle?.id || !state.bankSpend?.fixedCharges || spendAge > 3600 * 1000)) {
  refreshSpend({ silent: true });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Cuando llega una versión nueva se recarga sola, salvo que estés escribiendo algo
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const busy = sheetRoot.innerHTML || ['INPUT', 'SELECT'].includes(document.activeElement?.tagName);
    if (hadController && !busy) location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
