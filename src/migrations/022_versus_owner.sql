-- Dueño de un versus (la conexión del creador), para aislar los versus vacíos entre clientes.
-- null = creado por admin (visible solo para admin hasta que tenga setters).
ALTER TABLE versus ADD COLUMN IF NOT EXISTS owner_account_id INT REFERENCES accounts(id) ON DELETE SET NULL;
