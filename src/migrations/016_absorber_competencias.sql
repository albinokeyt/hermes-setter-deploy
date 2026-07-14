-- Fase 4: absorber Competencias en el modelo Conexión → Setters.
-- Las "variantes" de campañas pasan a ser setters de primera clase de su conexión.

-- Dos interruptores distintos por setter:
--   bot_enabled   = responde a SUS conversaciones (el de la conexión manda a nivel global)
--   accepts_leads = entra al reparto de leads NUEVOS (la "batalla")
ALTER TABLE setters ADD COLUMN IF NOT EXISTS accepts_leads BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE setters ADD COLUMN IF NOT EXISTS legacy_variant_id INT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_setters_legacy_variant ON setters (legacy_variant_id) WHERE legacy_variant_id IS NOT NULL;

-- Convertir cada variante en un setter. Heredan el required_tags de SU CONEXIÓN (el filtro
-- de etiquetas vivía en la cuenta; así el gate no cambia). Quedan SIEMPRE bot_enabled=true
-- (para que las conversaciones que ya llevaban NO se queden mudas), pero solo aceptan leads
-- nuevos si su campaña estaba activa (las de campañas no-activas no vuelven a la batalla).
INSERT INTO setters (account_id, name, is_default, bot_enabled, accepts_leads, weight,
  required_tags, required_tags_mode,
  prompt_identity, prompt_business, prompt_flow, provider_id, model, temperature,
  debounce_seconds, max_msgs, followups, legacy_variant_id)
SELECT ca.account_id, v.name, false, true, (ca.status = 'active'), GREATEST(COALESCE(v.weight, 0), 0),
  a.required_tags, a.required_tags_mode,
  COALESCE(v.prompt_identity, ''), COALESCE(v.prompt_business, ''), COALESCE(v.prompt_flow, ''),
  v.provider_id, COALESCE(v.model, ''), COALESCE(v.temperature, 0.8),
  COALESCE(v.debounce_seconds, 35), COALESCE(v.max_msgs, 3), COALESCE(v.followups, '[]'::jsonb), v.id
FROM campaign_variants v
JOIN campaigns ca ON ca.id = v.campaign_id
JOIN accounts a ON a.id = ca.account_id
WHERE NOT EXISTS (SELECT 1 FROM setters s WHERE s.legacy_variant_id = v.id);

-- El setter individual arranca ENCENDIDO; el interruptor de la conexión es el maestro
-- (evita que un backfill dejara el default apagado y luego el AND con la conexión no lo encienda).
UPDATE setters SET bot_enabled = true WHERE is_default AND NOT bot_enabled;

-- Cuenta con campaña ACTIVA: las variantes tomaban el 100% de los leads nuevos y el cerebro
-- base de la cuenta no se usaba para nuevos. Sacamos el setter principal del reparto de nuevos
-- (sigue respondiendo a sus conversaciones antiguas: bot_enabled queda true).
UPDATE setters SET accepts_leads = false
WHERE is_default AND account_id IN (SELECT account_id FROM campaigns WHERE status = 'active');

-- Cada conversación que llevaba una variante pasa a su setter equivalente (conserva su cerebro).
UPDATE conversations c SET setter_id = s.id
FROM setters s
WHERE c.variant_id IS NOT NULL AND s.legacy_variant_id = c.variant_id AND c.setter_id IS DISTINCT FROM s.id;

-- Histórico de gasto de las variantes → su setter (métricas continuas de la batalla).
UPDATE llm_usage u SET setter_id = s.id
FROM setters s
WHERE u.variant_id IS NOT NULL AND s.legacy_variant_id = u.variant_id AND u.setter_id IS NULL;

-- Se cierra el modelo antiguo: las campañas activas quedan finalizadas.
UPDATE campaigns SET status = 'finished' WHERE status = 'active';
