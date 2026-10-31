// Conexión opcional con el banco a través del servidor de Holgura (Vercel → Enable Banking).
// La contraseña del servidor y la cuenta elegida se guardan solo en este móvil.

export const API = 'https://holgura-api.vercel.app';
const KEY = 'holgura.bank';

export function getConfig() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveConfig(patch) {
  const cfg = { ...getConfig(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cfg));
  return cfg;
}
export const clearConfig = () => localStorage.removeItem(KEY);
export const isReady = () => { const c = getConfig(); return Boolean(c.password && c.account); };

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${getConfig().password || ''}`;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('No hay conexión con el servidor. Revisa tu internet.'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Error ${res.status}`), { code: data.error, status: res.status });
  return data;
}

export const status = () => call('/api/status');
export const banks = () => call('/api/banks');
export const connect = bank => call('/api/connect', { method: 'POST', body: { bank } });
export const finish = (code, state) => call('/api/callback', { method: 'POST', body: { code, state }, auth: false });
export const disconnect = () => call('/api/disconnect', { method: 'POST' });
export const balance = () => call(`/api/balance?account=${encodeURIComponent(getConfig().account || '')}`);
export const transactions = from =>
  call(`/api/transactions?account=${encodeURIComponent(getConfig().account || '')}&from=${from}`);
