-- Lista blanca de correos por setter: solo entran al panel los correos autorizados.
-- El "responsable" (owner_email) es quien puede gestionar la lista.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_email TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS authorized_emails JSONB NOT NULL DEFAULT '[]';

-- Backfill idempotente: los setters existentes conservan a quienes YA entraron
-- (portal_users), para que nadie pierda acceso al activar la restricción.
UPDATE accounts a SET authorized_emails = sub.emails
FROM (
  SELECT account_id, jsonb_agg(DISTINCT lower(email)) AS emails
  FROM portal_users
  WHERE email <> ''
  GROUP BY account_id
) sub
WHERE a.id = sub.account_id
  AND (a.authorized_emails IS NULL OR a.authorized_emails = '[]'::jsonb);

-- El portal_user más antiguo de cada setter queda como responsable (gestor de accesos).
UPDATE accounts a SET owner_email = sub.email
FROM (
  SELECT DISTINCT ON (account_id) account_id, lower(email) AS email
  FROM portal_users
  WHERE email <> ''
  ORDER BY account_id, created_at ASC, id ASC
) sub
WHERE a.id = sub.account_id
  AND (a.owner_email IS NULL OR a.owner_email = '');
