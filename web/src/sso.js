// SSO de GHL para Custom Pages: cuando la app se carga EMBEBIDA dentro de GHL,
// pedimos a la ventana padre el contexto de usuario cifrado y lo canjeamos por sesión.
// Si no estamos embebidos (o falla), no hacemos nada y la app sigue su flujo normal.

function isEmbedded() {
  try { return window.self !== window.top; } catch { return true; } // cross-origin → embebidos
}

// Pide a GHL el paquete cifrado del usuario (postMessage). Resuelve el string cifrado o null.
function requestGhlUserData(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      resolve(val || null);
    };
    const onMessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (typeof d === 'string' && d.length > 24) return finish(d);
      if (d.message === 'REQUEST_USER_DATA_RESPONSE') return finish(d.payload || d.data || null);
    };
    window.addEventListener('message', onMessage);
    try { window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*'); } catch {}
    setTimeout(() => finish(null), timeoutMs);
  });
}

// Devuelve 'ok' si dejó sesión iniciada, 'skip' si no aplica, 'fail' si lo intentó y falló.
export async function bootstrapSso() {
  if (!isEmbedded()) return 'skip';
  // Pedimos SIEMPRE la identidad a GHL para ligar la sesión a la subcuenta ACTUAL del iframe.
  // (Una cuenta agency abre varias subcuentas en el MISMO navegador: si reutilizáramos la sesión
  //  existente sin comprobar la subcuenta, se mostrarían los datos de otra subcuenta.)
  const encrypted = await requestGhlUserData();
  if (encrypted) {
    try {
      const res = await fetch('/api/portal/sso', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ encrypted }),
      });
      return res.ok ? 'ok' : 'fail'; // el backend reemite la cookie ligada a esta subcuenta
    } catch {
      return 'fail';
    }
  }
  // GHL no entregó identidad (timeout / no embebido como app): usar sesión existente si la hay.
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.ok) return 'skip';
  } catch {}
  return 'fail';
}
