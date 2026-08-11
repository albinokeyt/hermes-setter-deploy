-- El botón «Guardar» de Configuración → Prompts almacenaba SIEMPRE los textos (arquitecto, corrector
-- y guardarraíl) aunque no se hubieran tocado: eso congelaba una copia del default en la base y las
-- mejoras posteriores del default nunca llegaban (promptEditor.js/agent.js leen el guardado antes que
-- el default). Desde este cambio, guardar el default tal cual almacena '' (que cae al default al
-- leer). Esta migración descongela las copias YA guardadas.
--
-- Solo se descongelan copias EXACTAS (md5 byte a byte, tras trim y sin CR) de un default conocido de
-- CUALQUIER generación — un prompt con una sola letra personalizada no coincide con ningún hash y no
-- se toca. Hashes calculados desde el historial git con scripts/hashes-defaults.mjs:
--   c97555b02207a87ca0fbe0438cb9e6bd  DEFAULT_ARCHITECT  gen. «élite»    (a762df0b)
--   57f1b4d9a658a19eb7b690a9375775bc  DEFAULT_ARCHITECT  gen. «experto»  (65e777a4)
--   57342d09c8a366bbbe337732e88c1d3f  DEFAULT_CORRECTOR  gen. «élite»    (a762df0b)
--   424227373cd33d60d3e23cd3f7a8a174  DEFAULT_CORRECTOR  gen. anterior   (65e777a4)
--   75d7fe14b905d73e1d4c63d62687a978  DEFAULT_GUARDRAIL  única generación
UPDATE settings
   SET value = jsonb_set(value, '{text}', '""'::jsonb), updated_at = now()
 WHERE key IN ('architect_prompt', 'corrector_prompt', 'guardrail')
   AND md5(replace(btrim(value->>'text'), chr(13), '')) IN (
     'c97555b02207a87ca0fbe0438cb9e6bd',
     '57f1b4d9a658a19eb7b690a9375775bc',
     '57342d09c8a366bbbe337732e88c1d3f',
     '424227373cd33d60d3e23cd3f7a8a174',
     '75d7fe14b905d73e1d4c63d62687a978'
   );
