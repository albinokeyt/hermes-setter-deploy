// Pausas humanas: cada mensaje tarda en "escribirse" según su longitud, con algo de azar.
export function typingDelayMs(text, index) {
  const base = index === 0 ? 1200 : 2000;
  const perChar = 32;
  const raw = base + String(text || '').length * perChar;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(Math.max(Math.round(raw * jitter), 1200), 9000);
}

// Ventana de actividad: 0 si estamos dentro; si no, ms hasta la próxima apertura.
export function delayToActiveWindow(account) {
  const ah = account.active_hours || {};
  if (ah.always !== false) return 0;
  const tz = account.timezone || 'Europe/Madrid';
  let nowMinutes;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const [h, m] = parts.split(':').map(Number);
    nowMinutes = h * 60 + m;
  } catch {
    return 0;
  }
  const toMin = (s, fb) => {
    const [h, m] = String(s || fb).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = toMin(ah.start, '09:00');
  const end = toMin(ah.end, '21:00');
  if (start === end) return 0;
  const inside = start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
  if (inside) return 0;
  let diff = start - nowMinutes;
  if (diff <= 0) diff += 1440;
  return diff * 60_000 + Math.floor(Math.random() * 8 * 60_000);
}

// Ventana de mensajería de Meta: solo se puede responder si el lead escribió hace < 24h.
export function metaWindowOpen(conversation) {
  if (!conversation.last_inbound_at) return false;
  const hours = (Date.now() - new Date(conversation.last_inbound_at).getTime()) / 3_600_000;
  return hours < 23.5; // margen de seguridad de 30 min
}
