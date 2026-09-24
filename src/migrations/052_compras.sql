-- 🛒 Compras: pedidos de GHL (formulario de pedido de un embudo, tienda, factura) atribuidos al lead de la
-- conversación. Llegan por el webhook OrderStatusUpdate de la app y por la sincronización con la API de
-- pedidos (payments/orders). Es lo que pone el status «comprador», el importe y los productos en el lead,
-- y las «Ventas» del dashboard.
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  setter_id INT REFERENCES setters(id) ON DELETE SET NULL,
  ghl_order_id TEXT NOT NULL,
  ghl_contact_id TEXT NOT NULL DEFAULT '',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',            -- completed | pending | cancelled | refunded | …
  payment_status TEXT NOT NULL DEFAULT '',    -- paid | unpaid | refunded | partially_paid | ''
  items JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, qty, price, product_id}]
  source JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {type, subType, name, id, meta} (solo campos con valor)
  live_mode BOOLEAN NOT NULL DEFAULT true,    -- false = pedido de prueba
  cuenta BOOLEAN NOT NULL DEFAULT false,      -- CUENTA COMO VENTA: real, pagado y no anulado (lo decide el motor; todas las métricas usan esto)
  atribuida BOOLEAN NOT NULL DEFAULT false,   -- el lead ya hablaba con el setter cuando compró → venta del setter en el dashboard
  origen TEXT NOT NULL DEFAULT 'webhook',     -- webhook | sincronizacion
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, ghl_order_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_conv ON purchases (conversation_id);
CREATE INDEX IF NOT EXISTS idx_purchases_ventas ON purchases (account_id, ordered_at DESC) WHERE cuenta;
CREATE INDEX IF NOT EXISTS idx_purchases_contact ON purchases (account_id, ghl_contact_id);
-- la última cita de cada lead se busca por conversación (tarjetas del pipeline)
CREATE INDEX IF NOT EXISTS idx_appt_conv ON appointments (conversation_id);
