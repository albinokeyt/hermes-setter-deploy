// Lo que manda «Guardar» en la ficha de una conexión: SOLO los campos que han cambiado desde que se cargó o se guardó por
// última vez (repaso del Club, hallazgo A5). Mandar la ficha entera reescribía valores viejos: con la ficha abierta, un
// impago apagaba la IA (ai_enabled) y al pulsar Guardar por otra cosa (p. ej. el «Correo del Club») se volvía a encender
// con el valor de cuando se abrió. Sin JSX ni React: se prueba desde node (test/cambios-panel.test.mjs).

// campos que la ficha recibe del servidor pero no se guardan desde ella (los calcula o los guarda otra ruta)
export const SOLO_LECTURA = [
  'id', 'webhook_url', 'webhook_token', 'oauth_connected', 'provider_name', 'portal_url', 'comment_webhook_url',
  'es_club', 'club_pendientes', 'club_estado_at', 'ghl_location_email', 'ghl_location_email_at', 'created_at', 'updated_at',
];

const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * @param {object|null} original  la ficha tal como está guardada
 * @param {object} actual         la ficha con lo que ha tocado el usuario
 * @returns {object} solo los campos que cambian (los que empiezan por «_» son del formulario y nunca se mandan)
 */
export function camposCambiados(original, actual, soloLectura = SOLO_LECTURA) {
  const salida = {};
  for (const k of Object.keys(actual || {})) {
    if (k.startsWith('_') || soloLectura.includes(k)) continue;
    if (!igual(original ? original[k] : undefined, actual[k])) salida[k] = actual[k];
  }
  return salida;
}

/** Los campos del formulario (empiezan por «_», p. ej. el JSON a medio pegar) para no perderlos al recargar la ficha. */
export function camposDelFormulario(actual) {
  return Object.fromEntries(Object.entries(actual || {}).filter(([k]) => k.startsWith('_')));
}
