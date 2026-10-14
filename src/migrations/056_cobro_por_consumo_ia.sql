-- 💰 COBRO POR CONSUMO DE IA. Hasta ahora se cobraba 0,25 USD por conversación y día; desde aquí cada cliente paga
-- su consumo real de IA × multiplicador (ajuste «facturacion», por defecto ×2), agrupado en LOTES: una llamada cuesta
-- milésimas de dólar y el marketplace cobra como mínimo 0,01 USD.
--  · llm_usage.md_charge_id: el lote (marketplace_charges.id) en el que se cobró esa llamada. NULL = aún sin cobrar.
--    Se marca en la MISMA transacción que crea el lote: una llamada nunca entra en dos lotes.
--  · marketplace_charges.tipo: 'conversacion' (filas antiguas, por conversación y día) o 'consumo_ia' (lotes).
--  · Solo se cobra lo registrado DESPUÉS de esta migración: el consumo anterior ya estaba cubierto (prueba gratuita).
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS md_charge_id INT;   -- 0 = no se cobra (integración apagada / sin location_id); -1 = fuera de rango
-- ¿Tenía el cliente el uso INCLUIDO (prueba o plan) cuando se hizo la llamada? Lo consumido así no se cobra NUNCA, aunque el
-- lote se cierre después de quitarle la prueba.
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS incluido BOOLEAN NOT NULL DEFAULT false;
-- Borrar una conexión ya no borra su consumo (es nuestro coste y lo que se cobra): queda sin cuenta.
ALTER TABLE llm_usage DROP CONSTRAINT IF EXISTS llm_usage_account_id_fkey;
ALTER TABLE llm_usage ADD CONSTRAINT llm_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_usage_sin_cobrar ON llm_usage (account_id, id) WHERE md_charge_id IS NULL;

ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'conversacion';
ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);           -- nuestro coste de IA del lote
ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS importe_calculado NUMERIC(12,6);  -- precio al cliente exacto (sin redondear a céntimos)
ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS usage_desde INT;
ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS usage_hasta INT;
ALTER TABLE marketplace_charges ADD COLUMN IF NOT EXISTS llamadas INT;
CREATE INDEX IF NOT EXISTS idx_md_charges_tipo ON marketplace_charges (tipo, created_at DESC);

-- 'sin_saldo': el lote se cobra SOLO del saldo que el cliente recargó en el marketplace y no le alcanza. No es un
-- error: espera a que recargue y se reenvía con el MISMO event_id.
ALTER TABLE marketplace_charges DROP CONSTRAINT IF EXISTS marketplace_charges_estado_check;
ALTER TABLE marketplace_charges ADD CONSTRAINT marketplace_charges_estado_check
  CHECK (estado IN ('pendiente','cobrado','incluido','sin_confirmar','error','cortado','sin_saldo'));

INSERT INTO settings (key, value, updated_at)
VALUES ('cobro_ia_desde_usage_id', to_jsonb((SELECT COALESCE(MAX(id), 0) FROM llm_usage)), now())
ON CONFLICT (key) DO NOTHING;
