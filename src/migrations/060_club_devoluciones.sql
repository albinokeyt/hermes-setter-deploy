-- 🏛️ CLUB DE SISTEMAS · DEVOLUCIONES que se evalúan solas (POST /api/club/devolucion) — 13-nov-2026
--
-- Cada solicitud del formulario de devoluciones (la manda un workflow de GHL) queda aquí con su decisión:
--   aprobada (uso dentro del límite y en plazo) · denegada (con el motivo) · revision (falta un dato o no se puede medir).
-- Idempotente por contacto + producto + día del cobro: repetir la petición devuelve la decisión guardada.
-- El resultado se avisa a GHL (ghl_resultado_url) con reintentos; ghl_estado dice en qué punto está.
CREATE TABLE IF NOT EXISTS club_devoluciones (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clave TEXT NOT NULL,                              -- contact_id de GHL (o 'email:<correo>' si no llegó)
  producto TEXT NOT NULL CHECK (producto IN ('cuenta', 'brain', 'desconocido')),
  fecha_clave TEXT NOT NULL DEFAULT '',             -- día del cobro 'YYYY-MM-DD' (Madrid), '' si no llegó, 'texto:…' si no se entendió
  contact_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  location_id TEXT NOT NULL DEFAULT '',
  fecha_texto TEXT NOT NULL DEFAULT '',             -- la fecha del cobro tal como llegó
  fecha_cobro TIMESTAMPTZ,                          -- interpretada (desde cuándo se mide el uso)
  fecha_dia TEXT NOT NULL DEFAULT '',
  motivo_cliente TEXT NOT NULL DEFAULT '',          -- lo que escribió el cliente en el formulario
  producto_texto TEXT NOT NULL DEFAULT '',          -- el producto tal como llegó
  decision TEXT NOT NULL CHECK (decision IN ('aprobada', 'denegada', 'revision')),
  motivo TEXT NOT NULL DEFAULT '',                  -- por qué (lo que se manda a GHL)
  medida JSONB NOT NULL DEFAULT '{}'::jsonb,        -- días, consumo de IA, tareas del Brain, conexiones, avisos…
  ajustes JSONB NOT NULL DEFAULT '{}'::jsonb,       -- los números con los que se decidió (plazo, límites)
  ghl_estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (ghl_estado IN ('pendiente', 'enviando', 'enviado', 'error', 'sin_url')),
  ghl_intentos INT NOT NULL DEFAULT 0,
  ghl_ultimo_intento_at TIMESTAMPTZ,
  ghl_enviado_at TIMESTAMPTZ,
  ghl_http INT,
  ghl_error TEXT,
  repeticiones INT NOT NULL DEFAULT 0,              -- veces que llegó otra vez la misma solicitud
  ip TEXT,
  CONSTRAINT club_devoluciones_unica UNIQUE (clave, producto, fecha_clave)
);
CREATE INDEX IF NOT EXISTS idx_club_devol_envio ON club_devoluciones (ghl_estado, id)
  WHERE ghl_estado IN ('pendiente', 'enviando', 'error');
CREATE INDEX IF NOT EXISTS idx_club_devol_email ON club_devoluciones (email, id DESC);

-- Ajustes (Configuración → «Devoluciones del Club»). Los números son los de la regla aprobada; las dos URLs se rellenan
-- cuando existan (sin brain_uso_url, el Brain va a revisión; sin ghl_resultado_url, solo se guarda y se responde).
INSERT INTO settings (key, value, updated_at)
VALUES ('devoluciones', jsonb_build_object(
  'plazo_dias', 14, 'max_ia_usd', 5, 'max_brain_tareas', 10, 'brain_uso_url', '', 'ghl_resultado_url', ''
), now())
ON CONFLICT (key) DO NOTHING;
