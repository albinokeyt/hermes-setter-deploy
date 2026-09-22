-- 🧪 Simulador: conversaciones de contactos ficticios («sim:…») que recorren el motor real sin tocar
-- GHL ni cobrar. La columna sirve para esconderlas de los listados, el dashboard y las métricas.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS simulada BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_conv_simulada ON conversations (account_id, id DESC) WHERE simulada;
