-- Corte a partir del cual un mensaje saliente guardado como 'humano' es FIABLE (antes de este código los DMs de
-- workflow y las burbujas importadas también quedaban como 'humano'). Se fija en el PRIMER arranque y no cambia.
INSERT INTO settings (key, value) VALUES ('humano_fiable_desde', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING;
