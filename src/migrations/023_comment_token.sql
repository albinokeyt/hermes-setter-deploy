-- Token PROPIO para el webhook de comentarios (distinto del webhook_token de mensajes),
-- para que el usuario pueda copiar el de comentarios sin exponer el de inyección de mensajes.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS comment_token TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text);
-- token distinto por conexión existente (el DEFAULT podría haber puesto el mismo a todas).
UPDATE accounts SET comment_token = md5(random()::text || id::text || clock_timestamp()::text);
CREATE INDEX IF NOT EXISTS idx_accounts_comment_token ON accounts (comment_token);
