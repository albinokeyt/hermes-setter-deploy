-- La IA se apaga SOLO a mano. La migración 021 dejó ai_enabled DEFAULT false y toda conexión
-- nueva nacía con la IA apagada: los leads entraban sin respuesta y las activaciones por etiqueta
-- se descartaban con 'activador_apagado' sin que nadie hubiera apagado nada.
-- Las conexiones existentes NO se tocan (las apagadas a mano siguen apagadas).
ALTER TABLE accounts ALTER COLUMN ai_enabled SET DEFAULT true;
