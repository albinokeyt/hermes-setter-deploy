-- Antes de enviar un seguimiento, revisar con IA (leyendo los últimos mensajes) si conviene.
-- Evita perseguir a quien ya agendó, ya compró, dijo que no le interesa o se despidió.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS followup_ai_check BOOLEAN NOT NULL DEFAULT true;
