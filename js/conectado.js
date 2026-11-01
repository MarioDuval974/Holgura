// Página de vuelta del banco: termina la conexión y enseña las cuentas autorizadas.
// Va en un archivo aparte (no dentro del HTML) para que la política de seguridad pueda prohibir scripts en línea.
import { finish } from './bank.js';

const $ = id => document.getElementById(id);
const show = (title, text) => { $('title').textContent = title; $('text').textContent = text; $('back').hidden = false; $('hint').hidden = false; };
const q = new URLSearchParams(location.search);

if (q.get('error')) {
  show('No se ha conectado', 'Has cancelado la autorización o el banco ha dado un error. Puedes volver a intentarlo desde Holgura → Mi mes.');
} else if (!q.get('code')) {
  show('Nada que conectar', 'Esta página solo se usa al volver del banco.');
} else {
  try {
    const r = await finish(q.get('code'), q.get('state'));
    const until = r.validUntil ? new Date(r.validUntil).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    show('✅ Banco conectado', `Holgura ya puede leer tu saldo y tus movimientos${until ? ` hasta el ${until}` : ''}.`);
    // textContent: el nombre de la cuenta lo manda el banco y no se interpreta como HTML
    for (const a of r.accounts || []) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `🏦 ${a.name} ${a.iban}`;
      $('accounts').append(p);
    }
  } catch (err) {
    show('No se ha conectado', err.message);
  }
  history.replaceState(null, '', location.pathname); // quita el código de la barra de direcciones
}
