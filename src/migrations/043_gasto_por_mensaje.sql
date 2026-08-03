-- Gasto de IA estampado en el propio mensaje del bot (tokens y USD de la llamada que lo generó).
-- Se guarda en el PRIMER mensaje de cada tanda (una llamada LLM produce 1-3 mensajes).
-- El admin lo ve por burbuja en el chat para decidir si el modelo elegido le basta.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gasto_prompt_tokens INT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gasto_completion_tokens INT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gasto_usd NUMERIC;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gasto_modelo TEXT;
