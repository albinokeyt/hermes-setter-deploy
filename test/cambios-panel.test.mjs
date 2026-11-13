// Panel · «Guardar» de la ficha de una conexión manda SOLO lo que cambia (web/src/cambios.js, repaso del Club: hallazgo
// A5). Antes mandaba la ficha entera y, con la ficha abierta, un impago del Club que apagaba la IA se deshacía al guardar
// cualquier otra cosa (p. ej. el «Correo del Club»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camposCambiados, camposDelFormulario, SOLO_LECTURA } from '../web/src/cambios.js';

const ficha = {
  id: 7, name: 'Cliente', ai_enabled: true, bot_enabled: true, club_email: null, club_estado_at: null,
  ctas: [{ keyword: 'GUIA', wait_seconds: 60 }], lead_magnets: [], active_hours: { always: true, start: '09:00', end: '21:00' },
  webhook_url: 'https://x/api/webhooks/workflow/tok', webhook_token: 'tok', oauth_connected: true, provider_name: 'OR',
  es_club: true, club_pendientes: [{ email: 'a@b.com', activo: false }], ghl_location_email: 'a@b.com', ghl_location_email_at: '2026-11-13T10:00:00.000Z',
};

test('A5 · escribir el correo del Club manda SOLO club_email (ni el ai_enabled ni el club_estado_at de cuando se abrió)', () => {
  const actual = { ...ficha, club_email: 'compra@x.com' };
  assert.deepEqual(camposCambiados(ficha, actual), { club_email: 'compra@x.com' });
});

test('sin cambios no se manda nada; los campos de solo lectura y los del formulario («_…») nunca', () => {
  assert.deepEqual(camposCambiados(ficha, { ...ficha }), {});
  const actual = { ...ficha, webhook_url: 'otra', es_club: false, club_pendientes: [], club_estado_at: '2026-11-13T11:00:00.000Z', ghl_location_email: 'pirata@x.com', _lmImport: '[{"name":"x"}]' };
  assert.deepEqual(camposCambiados(ficha, actual), {});
  for (const k of ['webhook_url', 'webhook_token', 'oauth_connected', 'provider_name', 'es_club', 'club_pendientes', 'club_estado_at']) assert.ok(SOLO_LECTURA.includes(k), k);
  assert.deepEqual(camposDelFormulario(actual), { _lmImport: '[{"name":"x"}]' });
});

test('listas y objetos se comparan por contenido: un CTA nuevo o un horario cambiado se mandan enteros', () => {
  const actual = { ...ficha, ctas: [...ficha.ctas, { keyword: '', wait_seconds: 30 }], active_hours: { ...ficha.active_hours, always: false } };
  assert.deepEqual(camposCambiados(ficha, actual), { ctas: actual.ctas, active_hours: actual.active_hours });
  assert.deepEqual(camposCambiados(ficha, { ...ficha, ctas: [{ keyword: 'GUIA', wait_seconds: 60 }] }), {}, 'misma lista (otra copia): no cambia');
});

test('un cambio de verdad del admin sí se manda (incluido encender o apagar la IA)', () => {
  assert.deepEqual(camposCambiados(ficha, { ...ficha, ai_enabled: false, name: 'Otro' }), { ai_enabled: false, name: 'Otro' });
  // vaciar un campo también es un cambio; null y «no está» son lo mismo
  assert.deepEqual(camposCambiados({ ...ficha, club_email: 'a@b.com' }, { ...ficha, club_email: '' }), { club_email: '' });
  assert.deepEqual(camposCambiados({ x: null }, { x: undefined }), {});
  // sin ficha original (no debería pasar) se manda todo lo editable, como antes
  assert.equal(camposCambiados(null, { name: 'A', webhook_url: 'u' }).name, 'A');
});

test('la ficha del panel usa el helper y ya no manda la ficha entera', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/src/pages/AccountEdit.jsx', import.meta.url), 'utf8');
  assert.match(src, /camposCambiados\(original, acc\)/);
  assert.doesNotMatch(src, /const body = \{ \.\.\.acc \}/);
});
