-- Despierta en Pareja (14-oct-2026): RESERVA DIRECTA. El contexto del CTA de la campaña «SESIÓN» se guardó copiado en cada
-- conversación con la ficha antigua del catálogo, que mandaba cualificar SIEMPRE antes de dar el enlace («entra directo en tu
-- flujo de cualificación… antes de enviarle el enlace»). Se vacía esa copia: el setter sigue sabiendo qué pidió por el catálogo
-- (la ficha nueva casa por la etiqueta) y deja de recibir la orden vieja. Solo toca las conversaciones con el texto viejo.
UPDATE conversations
   SET cta_context = ''
 WHERE account_id IN (SELECT id FROM accounts WHERE location_id = 'VvltQ68Ih2Nw8A1jTl9d')
   AND cta_tag IN ('#703-hermes"sesion"', 'cta: sesion')
   AND cta_context LIKE '%entra directo en tu flujo de cualificaci%';
