ALTER TABLE accounts ADD COLUMN IF NOT EXISTS portal_key TEXT;
UPDATE accounts SET portal_key = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE portal_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_portal_key ON accounts (portal_key);
