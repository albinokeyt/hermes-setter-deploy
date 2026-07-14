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
  // ¿ya hay sesión? entonces no hace falta SSO
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.ok) return 'skip';
  } catch {}
  const encrypted = await requestGhlUserData();
  if (!encrypted) return 'fail';
  try {
    const res = await fetch('/api/portal/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ encrypted }),
    });
    return res.ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}
