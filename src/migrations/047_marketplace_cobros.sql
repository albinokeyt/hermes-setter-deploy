-- 💳 Integración con Marketplace Disruptivo: Hermes deja de gestionar pagos propios y consume del
-- saldo que el cliente tiene en el marketplace (crédito interno primero, wallet de GHL después).
--
-- Esta tabla es la FUENTE DE VERDAD de nuestros cobros (patrón outbox): la fila se crea ANTES de
-- llamar al marketplace, con el event_id determinista ya calculado. El UNIQUE sobre event_id es lo
-- que garantiza «una conversación por día natural» aunque el pipeline lo intente veinte veces:
-- el segundo INSERT no hace nada y no se encola ningún cobro.
CREATE TABLE IF NOT EXISTS marketplace_charges (
  id SERIAL PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,            -- hermes-{locationId}-{conversationId}-{YYYY-MM-DD}
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  location_id TEXT NOT NULL,
  dia DATE NOT NULL,                        -- día natural (zona MD_ZONA_HORARIA) que factura la fila
  units NUMERIC(12,4) NOT NULL DEFAULT 1,
  price NUMERIC(12,6),                      -- precio por unidad enviado (tarifa dinámica)
  -- pendiente  → registrada, aún sin resolver
  -- cobrado    → el marketplace la aceptó (201, o 200 idempotente/reconciliado)
  -- incluido   → el cliente tiene el uso incluido (access=true): NO se cobra
  -- sin_confirmar → agotados los reintentos; el marketplace la reconcilia solo (NUNCA re-cobrar)
  -- error      → 400/401/403/404: petición o configuración mal; requiere intervención
  -- cortado    → el administrador deshabilitó los cobros de la app
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','cobrado','incluido','sin_confirmar','error','cortado')),
  charge_id INT,                            -- id numérico del cargo: lo ÚNICO que permite reembolsar
  charge_status TEXT NOT NULL DEFAULT '',   -- created | test | pending | failed | unknown | refunded…
  test_mode BOOLEAN NOT NULL DEFAULT false,
  paid_with TEXT NOT NULL DEFAULT '',       -- wallet | credit
  amount NUMERIC(12,6),
  intentos INT NOT NULL DEFAULT 0,
  ultimo_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- el barrido de pendientes busca por estado + antigüedad
CREATE INDEX IF NOT EXISTS idx_md_charges_pendientes ON marketplace_charges (estado, updated_at);
CREATE INDEX IF NOT EXISTS idx_md_charges_cuenta ON marketplace_charges (account_id, dia DESC);

-- Estado del cliente frente al marketplace, para que el panel lo enseñe sin consultar la API:
--   md_acceso: 'incluido' (plan/prueba activa) | 'por_uso' (se le cobra) | '' (aún sin consultar)
--   md_sin_fondos_at: cuándo se detectó que no puede pagar (NULL = puede). Es la «constancia» que
--   pide el contrato para que el administrador avise al cliente.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS md_acceso TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS md_acceso_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS md_sin_fondos_at TIMESTAMPTZ;
