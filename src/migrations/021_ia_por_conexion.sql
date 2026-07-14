-- Interruptor maestro de IA por conexión (modelo SaaS): al instalar desde GHL, la IA
-- arranca APAGADA. Con la IA apagada, la conexión solo RECOGE mensajes (los clientes
-- ven entrantes/salientes) pero los setters NO responden y su configuración de IA queda
-- oculta para el cliente. El admin (y en el futuro la suscripción) la activa por conexión.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false;

-- Las conexiones que YA existen (en uso) se dejan con la IA activada para no cortarles el bot.
UPDATE accounts SET ai_enabled = true WHERE created_at < now();
