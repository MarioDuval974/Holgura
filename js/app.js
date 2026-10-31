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
  yellow: { title: 'Ajusta un poco', icon: '🟡' },
  red: { title: 'Tendrás que tirar de la hucha', icon: '🔴' },
};

function statusMessage(a) {
  if (a.status === 'green') {
    const extra = a.projectedSavings - a.goal;
    return a.goal
      ? `Al ritmo actual llegarás bien al cobro y cumplirás tu objetivo de ahorro.${extra >= 20 ? ` Incluso podrías apartar unos <b>${money(extra)}</b> más.` : ''}`
      : `Al ritmo actual llegarás bien al cobro y te sobrarán unos <b>${money(a.projectedSavings)}</b>.`;
  }
  if (a.status === 'yellow') {
    return a.goal && a.projectedVariable > a.margin - a.goal
      ? `Si sigues así solo podrás ahorrar <b>${money(Math.max(0, a.projectedSavings))}</b> de tus ${money(a.goal)}. Para cumplir el objetivo, ajusta un poco tu gasto.`
      : `Vas muy justo: te sobrarían solo <b>${money(Math.max(0, a.projectedSavings))}</b>. Ajusta un poco tu gasto.`;
  }
  return a.planNoJar.weekday <= 0
    ? `Ya has gastado más de lo que ingresas este ciclo. Necesitarás unos <b>${money(a.deficit)}</b> de tus huchas para llegar al cobro.`
    : `Al ritmo actual gastarás unos <b>${money(a.deficit)}</b> más de lo que ingresas. Para no tocar tus huchas, ajusta tu gasto.`;
}

// Lo que puedes gastar a partir de la revisión, por día (entre semana / fin de semana) o por semana
function allowanceBlock(a) {
  const s = state.settings;
  if (a.remaining <= 0) return '';
  const useGoal = a.goal > 0 && a.planGoal.weekday > 0;
  const plan = useGoal ? a.planGoal : a.planNoJar;
  let body;
  if (s.allowanceView === 'semana') {
    body = `<div class="allow-grid">
      <div><span>Esta semana<small>de hoy al ${dayFmt(plan.weekUntil)}</small></span><strong>${money(plan.thisWeek)}</strong></div>
      <div><span>Semana completa<small>de lunes a domingo</small></span><strong>${money(plan.fullWeek)}</strong></div>
    </div>`;
  } else if (C.effectiveSettings(state).weekendFactor === 1) {
    body = `<div class="allow-grid one"><div><span>Cada día</span><strong>${money(plan.weekday)}</strong></div></div>`;
  } else {
    body = `<div class="allow-grid">
      <div><span>Entre semana<small>${s.fridayWeekend ? 'lunes a jueves' : 'lunes a viernes'}</small></span><strong>${money(plan.weekday)}<em>/día</em></strong></div>
      <div><span>Fin de semana<small>${s.fridayWeekend ? 'viernes a domingo' : 'sábado y domingo'}</small></span><strong>${money(plan.weekend)}<em>/día</em></strong></div>
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
      ${allowanceBlock(a)}
      <div class="stats">
        <div><span>Gastado en el día a día</span><strong>${money(Math.max(0, a.variable))}</strong></div>
        <div><span>Ritmo</span><strong>${money(a.daily)}/día</strong></div>
        <div><span>Saldo previsto al cobrar</span><strong class="${a.projectedEndBalance < 0 ? 'neg' : ''}">${money(a.projectedEndBalance)}</strong></div>
      </div>
    </section>`;
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
    const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    html += `<div class="fx-list">${ordered.map(cat => `
      <p class="fx-group">${icon(cat)} ${cat}<span>${[
        sum(groups.get(cat).filter(i => !i.months?.length), i => i.amount),
        sum(groups.get(cat).filter(i => i.months?.length), i => i.amount),
      ].map((v, k) => (v ? `${money(v)}${k ? ' trimestral' : '/mes'}` : '')).filter(Boolean).join(' + ')}</span></p>
      ${groups.get(cat).map(i => `
      <div class="fx-row">
        <div class="fx-top">
          <input class="fx-name" placeholder="Ej.: Alquiler" data-item="${i.id}" data-field="name" value="${esc(i.name)}" aria-label="Nombre del gasto">
          <select data-item="${i.id}" data-field="category" aria-label="Categoría">
            ${CATEGORY_NAMES.map(c => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        ${i.months?.length ? `<small class="fx-tag">Solo algunos meses: ${i.months.map(m => MONTHS[m - 1]).join(', ')}</small>` : ''}
        <div class="fx-line">
          <div class="money-input"><input inputmode="decimal" placeholder="0,00" data-item="${i.id}" data-field="amount" value="${numStr(i.amount)}" aria-label="Importe"><em>€</em></div>
          <input class="fx-day" inputmode="numeric" placeholder="Día" data-item="${i.id}" data-field="day" value="${i.day ?? ''}" aria-label="Día de cargo">
          <button class="icon-btn danger" data-act="fixed-del" data-id="${i.id}" aria-label="Eliminar">✕</button>
        </div>
      </div>`).join('')}`).join('')}
    </div>
    <button class="btn ghost block" data-act="fixed-add">+ Añadir gasto fijo</button>
    <p class="fx-total">Total al mes: <strong data-fixed-total>${money(C.fixedTotalOf(s))}</strong></p>
    ${C.periodicTotalOf(s) ? `<small class="hint">Además, ${money(C.periodicTotalOf(s))} en gastos que solo se cobran algunos meses (trimestrales): se descuentan en el ciclo en que tocan.</small>` : ''}
    <small class="hint">El <b>día</b> en que te lo cobran es opcional, pero si lo pones sabré qué recibos te quedan por pagar en cada revisión.</small>`;
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

function viewInicio() {
  const c = state.cycle, s = state.settings, today = C.todayStr();
  const info = C.cycleInfo(c, s);
  const last = lastCheckin();
  const a = last ? C.analyze(state, last) : null;
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
    ${items.some(i => /revolving/i.test(i.name)) ? '<p class="note">El revolving sube la cuota cada vez que dispones de dinero y suele tener intereses altos. Puedes consultar en Cetelem cuánto queda pendiente.</p>' : ''}
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
  if (a.budgets) s.budgets = { ...a.budgets };
  state.bankSpend = null; // las reglas han cambiado: se vuelve a calcular
  state.analysis = { period: a.period, categories: a.categories || [], notes: a.notes || [], importedAt: C.todayStr() };
  syncCycle();
  tab = 'inicio';
  commit();
  toast('Análisis importado');
}

function monthCard(rec) {
  const c = state.cycle, s = state.settings;
  const notes = {
    provisional: 'Cálculo provisional (regla 50/30/20). Cuando cierres tu primer ciclo lo ajustaré a lo que gastas de verdad.',
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
    <div class="chips">${state.jars.slice(0, 4).map(j => `<button class="chip" data-act="jar-open" data-id="${j.id}">${j.emoji} ${esc(j.name)} · ${money(jarBalance(j.id))}</button>`).join('')}</div>
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
  const ids = c.fixedItems.filter(i => {
    const d = C.chargeDateInCycle(i, c.start);
    if (d) return d > today;
    return last ? (last.pendingIds || []).includes(i.id) : true;
  }).map(i => i.id);
  return { mode: 'items', ids };
}

function viewRevisar() {
  const c = state.cycle, s = state.settings, today = C.todayStr();
  const next = nextDue();
  const pend = pendingDefaults();
  const [y, m, d] = today.split('-').map(Number);
  const showEarly = s.cycleType === 'natural' && d >= Math.min(s.payDay, 28) - 4;

  let html = header('Revisar', `Próxima revisión: <b>${next <= today ? 'hoy' : dayFmt(next)}</b> · ${freqLabel(s.checkFreq)}`);

  html += `<section class="card">
    <h3>Nueva revisión</h3>
    ${moneyField('Saldo actual de tu cuenta', 'id="ck-balance"', '', B.isReady() ? '<span id="bk-note">Escríbelo o tráelo de tu banco.</span>' : 'El que ves ahora mismo en la app de tu banco.')}
    ${B.isReady() ? '<button class="btn ghost block bank-btn" data-act="bank-balance">🏦 Traer saldo del banco</button>' : ''}
    ${pend.mode === 'items' ? `
      <div class="field"><span>Gastos fijos que <b>ya</b> te han cobrado</span>
        <small class="hint">Marca cada uno cuando veas el cargo en tu banco. <b id="ck-charged">${chargedText(c.fixedItems.filter(i => !pend.ids.includes(i.id)))}</b></small>
        <div class="checks">${c.fixedItems.map(i => `
          <label class="check"><input type="checkbox" data-fixed-id="${i.id}" ${pend.ids.includes(i.id) ? '' : 'checked'}>
            <span>${esc(i.name || 'Sin nombre')}</span><em>${money(i.amount)}${i.day ? ` · día ${i.day}` : ''}</em></label>`).join('')}
        </div>
      </div>` : c.fixedTotal > 0 ? moneyField('Gastos fijos que aún no te han cobrado', 'id="ck-pending"', numStr(pend.amount), `De tus ${money(c.fixedTotal)} de gastos fijos.`) : ''}
    ${showEarly ? `<label class="check solo"><input type="checkbox" id="ck-early"><span>Ya me ha llegado la nómina del mes que viene</span></label>` : ''}
    <details class="more"><summary>¿Has recibido algún ingreso extra?</summary>
      ${moneyField('Ingresos extra desde la última revisión', 'id="ck-extra"', '', 'Un Bizum, una venta, un regalo… Lo sumo a lo que tienes para este ciclo.')}
    </details>
    <label class="field"><span>Fecha</span><input type="date" id="ck-date" value="${today}" min="${c.start}" max="${today}"></label>
    <button class="btn primary block" data-act="checkin-save">Ver cómo voy</button>
  </section>`;

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
      <button class="btn ghost" data-act="tab" data-tab="mimes">Cambiar</button>
    </div>
  </section>`;
  return html;
}

function chargedText(charged) {
  const c = state.cycle;
  return `Cobrados: ${money(sum(charged, i => i.amount))} de ${money(c.fixedTotal)}.`;
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
    extraIncome: Math.max(0, parseMoney($('#ck-extra')?.value) || 0),
    earlyIncome: $('#ck-early')?.checked ? Number(state.settings.salary) || 0 : 0,
  };
  // Una revisión por día: la nueva sustituye a la anterior
  state.checkins = state.checkins.filter(x => !(x.cycleId === c.id && x.date === date));
  state.checkins.push(k);
  commit();
  openCheckinResult(k.id);
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
        <span class="jar-emoji">${j.emoji}</span>
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
  openSheet(`${j.emoji} ${esc(j.name)}`, `
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
      ${state.jars.map(j => `<option value="${j.id}" ${j.id === jarId ? 'selected' : ''}>${j.emoji} ${esc(j.name)} (${money(jarBalance(j.id))})</option>`).join('')}
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

  const leftover = Math.round((closed.income - closed.fixed - closed.variable - closed.saved) * 100) / 100;
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

function viewMiMes() {
  const s = state.settings, c = state.cycle;
  return header('Mi mes', 'Tus datos y preferencias') + `
    <section class="card">
      <h3>Ingresos</h3>
      ${moneyField('Nómina mensual', 'data-bind="salary" data-kind="money"', numStr(s.salary))}
      <div class="field"><span>¿Cómo cuentas el mes?</span>${seg('cycleType', [['nomina', 'De nómina a nómina'], ['natural', 'Del 1 al 30/31']], s.cycleType)}</div>
      <label class="field"><span>Día en que sueles cobrar</span>
        <input type="number" min="1" max="31" inputmode="numeric" data-bind="payDay" data-kind="int" data-rerender value="${s.payDay}"></label>
    </section>

    <section class="card">
      <h3>Gastos fijos</h3>
      ${fixedEditor()}
    </section>

    ${budgetSection()}

    <section class="card">
      <h3>Revisiones</h3>
      ${freqEditor()}
      <button class="btn ghost block" data-act="ics">📅 Añadir recordatorio al Calendario</button>
    </section>

    <section class="card">
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
    </section>

    <section class="card">
      <h3>Ciclo actual</h3>
      <label class="field"><span>Empezó el</span><input type="date" data-cbind="start" value="${c.start}" max="${C.todayStr()}"></label>
      ${moneyField('Saldo al empezar', 'data-cbind="startBalance"', numStr(c.startBalance))}
      <button class="btn ghost block" data-act="cobro-open">${s.cycleType === 'natural' ? 'Empezar nuevo mes' : 'He cobrado: empezar nuevo ciclo'}</button>
    </section>

    ${bankSection()}

    <section class="card">
      <h3>Tus datos</h3>
      <p class="muted">Todo se guarda solo en este móvil. Haz una copia de vez en cuando por si cambias de móvil o borras la app.</p>
      <div class="btn-col">
        <button class="btn ghost block" data-act="export">⬇️ Exportar copia de seguridad</button>
        <button class="btn ghost block" data-act="import">⬆️ Importar copia de seguridad</button>
        <button class="btn ghost block" data-act="import">📊 Importar análisis del banco</button>
        <button class="btn text danger block" data-act="reset">Borrar todos los datos</button>
      </div>
    </section>
    <p class="footer">Holgura · v1.8</p>`;
}

// ---------- Presupuesto por categorías ----------

// Lo que hay para el día a día en este ciclo: nómina − fijos − objetivo de ahorro
const dayToDayAvailable = () => {
  const c = state.cycle;
  return c ? c.income - c.fixedTotal - (Number(c.savingsGoal) || 0) : 0;
};
const budgetTotal = () => sum(BUDGET_CATEGORIES, c => (state.settings.budgets || {})[c] || 0);

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
    <p class="muted">Reparte por categorías lo que te queda tras los gastos fijos. Holgura lo compara con tus movimientos del banco y te avisa si vas rápido.</p>
    <div class="budget-list">${BUDGET_CATEGORIES.map(cat => `
      <label class="budget-row"><span>${icon(cat)} ${cat}</span>
        <div class="money-input"><input inputmode="decimal" placeholder="—" data-budget="${cat}" value="${numStr(b[cat] || 0)}" aria-label="Tope de ${cat}"><em>€</em></div>
      </label>`).join('')}
    </div>
    <p class="fx-total" id="budget-summary">${budgetSummaryText()}</p>
    <label class="field"><span>Los Bizum que te devuelven se descuentan de…</span>
      <select data-bind="bizumTo" data-kind="text">
        ${BUDGET_CATEGORIES.filter(c => c !== 'Bizum').map(c => `<option value="${c}" ${state.settings.bizumTo === c ? 'selected' : ''}>${icon(c)} ${c}</option>`).join('')}
        <option value="" ${!state.settings.bizumTo ? 'selected' : ''}>Ninguna (los veo aparte)</option>
      </select>
      <small>Si pagas una cena y te devuelven tu parte por Bizum, lo gastado en esa categoría baja.</small>
    </label>
  </section>`;
}

// Gastado en una categoría: si es la elegida para los Bizum, se descuenta lo que te han devuelto
function netSpent(cat, sp) {
  const gross = sp?.byCat[cat] || 0;
  const back = sp && cat === state.settings.bizumTo ? sp.bizumIn || 0 : 0;
  return { gross, back, net: Math.round((gross - back) * 100) / 100 };
}

function budgetStatus(spent, budget, elapsedFrac) {
  if (spent > budget) return 'red';
  if (spent / budget > Math.min(1, elapsedFrac + 0.15)) return 'yellow';
  return 'green';
}

function budgetCard() {
  const b = state.settings.budgets || {};
  const cats = BUDGET_CATEGORIES.filter(c => b[c] > 0);
  if (!cats.length || !state.cycle) return '';
  const info = C.cycleInfo(state.cycle, state.settings);
  const elapsedFrac = info.elapsed / info.totalDays;
  const sp = state.bankSpend?.cycleId === state.cycle.id ? state.bankSpend : null;
  const remainingDays = Math.max(1, info.remaining);
  const totalSpent = sp ? sum(cats, c => netSpent(c, sp).net) : 0;
  const bizumTo = state.settings.bizumTo;
  const bizumAside = sp?.bizumIn && !(bizumTo && cats.includes(bizumTo));

  const rows = cats.map(cat => {
    const budget = b[cat];
    const { gross, back, net: spent } = netSpent(cat, sp);
    const left = budget - spent;
    const st = budgetStatus(Math.max(0, spent), budget, elapsedFrac);
    // Por categoría se entiende mejor por semana que por día (1,50 €/día en bares no dice mucho)
    const pace = left > 0 && remainingDays > 7 ? `(≈ ${money((left / remainingDays) * 7)}/semana)` : '';
    return `<div class="budget-item">
      <div class="budget-top"><span>${icon(cat)} ${cat}</span><strong>${money(Math.max(0, spent))} <small>de ${money(budget)}</small></strong></div>
      <span class="bar budget-${st}"><i style="width:${Math.min(100, Math.max(0, spent / budget) * 100)}%"></i><b style="left:${Math.min(100, elapsedFrac * 100)}%"></b></span>
      ${back ? `<small class="pos">${money(gross)} gastado − ${money(back)} devuelto por Bizum</small>` : ''}
      <small class="${st === 'red' ? 'neg' : ''}">${left >= 0 ? `Te quedan ${money(left)} ${pace}` : `Te has pasado ${money(-left)}`}</small>
    </div>`;
  }).join('');

  return `<section class="card">
    <div class="card-head"><h3>🎯 Presupuesto del ciclo</h3>${B.isReady() ? '<button class="link" data-act="spend-refresh">Actualizar</button>' : ''}</div>
    ${sp ? `<p class="muted">Llevas <b>${money(Math.max(0, totalSpent))}</b> de ${money(budgetTotal())} · día ${info.elapsed} de ${info.totalDays}${bizumAside ? ` · <span class="pos">+${money(sp.bizumIn)} devueltos por Bizum</span>` : ''}</p>`
      : `<p class="muted">${B.isReady() ? 'Pulsa «Actualizar» para leer tus movimientos del banco.' : 'Conecta tu banco en Mi mes para ver cuánto llevas en cada categoría.'}</p>`}
    ${rows}
    ${sp ? `<p class="note">Actualizado ${new Date(sp.at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. La rayita marca hasta dónde «tocaría» llevar gastado hoy.</p>` : ''}
  </section>`;
}

// Lee los movimientos del ciclo, guarda el gasto por categoría y avisa de lo que va rápido
async function refreshSpend({ silent = false, list = null } = {}) {
  const c = state.cycle;
  if (!c || !B.isReady()) return;
  try {
    const txs = list || (await B.transactions(c.start)).transactions.map(t => ({ ...t, ...categorize(t, state.rules) }));
    state.bankSpend = { cycleId: c.id, at: new Date().toISOString(), ...spendByCategory(txs) };
    persist();
    const b = state.settings.budgets || {};
    const info = C.cycleInfo(c, state.settings);
    const alerts = BUDGET_CATEGORIES.filter(cat => b[cat] > 0)
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
    body = `<p class="muted">Opcional: conecta tu cuenta para traer el saldo y ver tus movimientos sin escribirlos. Es <b>solo lectura</b>: nadie puede mover dinero. Siempre podrás seguir escribiendo el saldo a mano.</p>
      <label class="field"><span>Contraseña del servidor</span>
        <input type="password" id="bk-pass" autocomplete="current-password" placeholder="La que pusiste en Vercel"></label>
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

async function openTransactions() {
  const c = state.cycle;
  openSheet('Movimientos', '<p class="muted center">Leyendo tus movimientos del banco…</p>');
  try {
    const { transactions } = await B.transactions(c.start);
    const list = transactions.map(t => ({ ...t, ...categorize(t, state.rules) }));
    refreshSpend({ list }); // de paso, actualiza el presupuesto
    const income = sum(list.filter(t => t.amount > 0), t => t.amount);
    const spent = -sum(list.filter(t => t.amount < 0), t => t.amount);
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
          <span>${icon(cat)} ${cat}</span><strong>${money(v)}</strong>
          <span class="bar"><i style="width:${(v / max) * 100}%"></i></span>
        </div>`).join('')}` : ''}
      ${list.length ? days.map(d => `
        <h3>${d ? dayFmt(d) : 'Sin fecha'}</h3>
        <div class="list">${list.filter(t => t.date === d).map(t => `
          <div class="list-row static">
            <span class="mv ${t.amount >= 0 ? 'in' : 'out'}">${icon(t.category)}</span>
            <span class="grow tx-desc">${esc(t.description)}<small>${esc(t.label || t.category)}${t.pending ? ' · pendiente' : ''}</small></span>
            <strong class="${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '− ' : '+ '}${money(Math.abs(t.amount))}</strong>
          </div>`).join('')}</div>`).join('') : '<p class="muted center">No hay movimientos en este ciclo.</p>'}`);
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
    closeSheet(); tab = el.dataset.tab; render(); window.scrollTo(0, 0);
    if (tab === 'mimes') loadBankStatus();
  },
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

  'fixed-add': () => {
    const id = S.uid();
    state.settings.fixedItems.push({ id, name: '', amount: 0, day: null, category: 'Otros' });
    syncCycle();
    commit();
    document.querySelector(`[data-item="${id}"][data-field="name"]`)?.focus();
  },
  'fixed-del': el => {
    state.settings.fixedItems = state.settings.fixedItems.filter(i => i.id !== el.dataset.id);
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
      $('#ck-balance').value = String(Math.round(b.amount * 100) / 100).replace('.', ',');
      const at = new Date(b.at);
      const note = $('#bk-note');
      if (note) note.textContent = `Saldo disponible según tu banco${isNaN(at) ? '' : ` (${at.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`}. Puedes corregirlo antes de guardar.`;
      toast('Saldo traído del banco');
    } catch (err) {
      bankError(err);
    } finally {
      el.disabled = false;
      el.textContent = '🏦 Traer saldo del banco';
    }
  },
  'bank-tx': openTransactions,
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
    if (kind === 'int') v = Math.max(1, parseInt(v, 10) || 1);
    if (kind === 'bool') v = el.checked;
    if (el.dataset.bind === 'payDay') v = Math.min(31, v);
    const prevSalary = state.settings.salary;
    setPath(state.settings, el.dataset.bind, v);
    syncCycle(prevSalary);
    persist();
    if ('rerender' in el.dataset) render();
  } else if (el.dataset.item) {
    const item = state.settings.fixedItems.find(i => i.id === el.dataset.item);
    if (!item) return;
    const f = el.dataset.field;
    if (f === 'name') item.name = el.value.trim();
    if (f === 'category') { item.category = el.value; syncCycle(); persist(); return render(); }
    if (f === 'amount') item.amount = Math.max(0, parseMoney(el.value) || 0);
    if (f === 'day') { const d = parseInt(el.value, 10); item.day = d >= 1 && d <= 31 ? d : null; el.value = item.day ?? ''; }
    syncCycle();
    persist();
    document.querySelectorAll('[data-fixed-total]').forEach(n => { n.textContent = money(C.fixedTotalOf(state.settings)); });
  } else if (el.dataset.cbind) {
    if (el.dataset.cbind === 'start' && el.value) state.cycle.start = el.value;
    if (el.dataset.cbind === 'startBalance') { const v = parseMoney(el.value); if (Number.isFinite(v)) state.cycle.startBalance = v; }
    persist();
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
        const parsed = JSON.parse(text);
        if (parsed?.type === 'holgura-analisis') return applyAnalysis(parsed);
        const data = S.importData(text);
        if (!confirm('Se sustituirán los datos actuales por los de la copia. ¿Continuar?')) return;
        state = data;
        commit();
        toast('Copia de seguridad importada');
      } catch (err) {
        toast(err.message);
      } finally {
        el.value = '';
      }
    });
  }
});

// ---------- Render ----------

function render() {
  if (!state.setup) {
    tabbar.hidden = true;
    view.innerHTML = viewWizard();
    return;
  }
  tabbar.hidden = false;
  view.innerHTML = { inicio: viewInicio, revisar: viewRevisar, huchas: viewHuchas, mimes: viewMiMes }[tab]();
  tabbar.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

// Al volver a la app (puede haber cambiado el día) se recalcula todo
// Al volver del banco también se comprueba si la conexión ya está hecha
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!sheetRoot.innerHTML) render();
  if (tab === 'mimes' || (B.getConfig().password && !B.isReady())) loadBankStatus();
});

render();
if (B.getConfig().password) loadBankStatus();

// Si hay presupuesto y banco conectado, se actualiza solo al abrir la app (como mucho cada 3 horas)
const spendAge = state.bankSpend ? Date.now() - new Date(state.bankSpend.at) : Infinity;
if (state.setup && B.isReady() && Object.keys(state.settings.budgets || {}).length
    && (state.bankSpend?.cycleId !== state.cycle?.id || spendAge > 3 * 3600 * 1000)) {
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
