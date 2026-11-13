-- 🏛️ CLUB DE SISTEMAS · conexiones nuevas seguras, interruptor del Club y tope de gasto (13-nov-2026)
--
-- 1) TOPE DE GASTO MENSUAL por conexión (USD, precio al cliente). NULL = sin tope (lo de siempre). Solo lo edita el
--    admin. Si el consumo del mes natural (zona horaria de la conexión) llega al tope, la puerta de atender no llama a
--    la IA (igual que sin saldo) y deja el evento «tope_mensual_alcanzado».
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tope_mensual_usd NUMERIC(10,2);

-- 2) INTERRUPTOR DEL CLUB (POST /api/club/estado): registro DURABLE de cada llamada (el registro de eventos del panel
--    se poda a ~2000 filas) y estado pendiente para la subcuenta o el correo que aún no tiene conexión en Hermes.
CREATE TABLE IF NOT EXISTS club_eventos (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  location_id TEXT,
  email TEXT,
  activo BOOLEAN,
  motivo TEXT NOT NULL DEFAULT '',
  resultado TEXT NOT NULL,                      -- aplicado | sin_cambios | pendiente | ambiguo | protegida | pendiente_aplicado
  cuentas JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ids de conexión tocadas (o candidatas, si ambiguo)
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_club_eventos_loc ON club_eventos (location_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_club_eventos_email ON club_eventos (email, id DESC);

-- Cuándo se decidió el último estado del Club que tiene la conexión (NULL = nunca). Un estado PENDIENTE solo se aplica
-- si es posterior: así un alta vieja que esperaba por correo no reenciende una conexión apagada después por impago.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS club_estado_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS club_estado_pendiente (
  clave TEXT PRIMARY KEY,                       -- 'loc:<locationId>' o 'email:<correo>'
  activo BOOLEAN NOT NULL,
  motivo TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Corte de «conexión nueva»: la vía por CORREO del interruptor solo puede tocar conexiones creadas desde aquí. Así un
-- cliente de antes (DEP, Rodrigo, Jonathan…) nunca se apaga porque su correo coincida con el de una compra del Club.
INSERT INTO settings (key, value, updated_at)
VALUES ('club_desde', jsonb_build_object('desde', now()), now())
ON CONFLICT (key) DO NOTHING;

-- 3) PLANTILLA DE CONEXIONES NUEVAS: se copia al «Setter principal» de cada conexión que se cree sola (instalación
--    OAuth, enlace de agencia o SSO de la Custom Page). Las conexiones nuevas nacen además en 🧪 MODO PRUEBA con la
--    etiqueta «test-setter» (el código lo fuerza; esto solo pone la etiqueta por defecto).
--    Proveedor/modelo: el que usan los setters EN PRODUCCIÓN con deepseek-v4-pro por OpenRouter (Clara, Sofía…). Se
--    resuelve aquí leyendo la base: si no hay ninguno que cumpla el criterio, queda vacío (provider_id null).
--    El prompt de partida lleva marcadores [[RELLENAR: …]]: mientras quede alguno, el setter NO atiende fuera del modo
--    prueba ni entra por activaciones (services/club.js · promptSinRellenar).
WITH cand AS (
  SELECT COALESCE(s.provider_id, a.provider_id) AS pid,
         COALESCE(NULLIF(s.model, ''), NULLIF(a.model, ''), p.default_model) AS modelo
    FROM setters s
    JOIN accounts a ON a.id = s.account_id
    JOIN providers p ON p.id = COALESCE(s.provider_id, a.provider_id)
   WHERE s.bot_enabled AND a.ai_enabled AND NOT a.test_mode AND NOT s.test_mode
     AND p.base_url ILIKE '%openrouter%'
), elegido AS (
  SELECT pid, modelo, count(*) AS n FROM cand
   WHERE modelo ILIKE '%deepseek-v4-pro%'
   GROUP BY pid, modelo
   ORDER BY n DESC, pid ASC
   LIMIT 1
)
INSERT INTO settings (key, value, updated_at)
SELECT 'plantilla_conexion', jsonb_build_object(
  'provider_id', (SELECT pid FROM elegido),
  'model', COALESCE((SELECT modelo FROM elegido), ''),
  'test_tag', 'test-setter',
  'origen', CASE WHEN EXISTS (SELECT 1 FROM elegido)
                 THEN 'migración 059: proveedor/modelo más usado por los setters en producción con deepseek-v4-pro por OpenRouter'
                 ELSE 'migración 059: ningún setter en producción usa deepseek-v4-pro por OpenRouter → proveedor vacío (asignarlo en Configuración)' END,
  'prompt_partida', jsonb_build_object(
    'identity', $identity$Eres [[RELLENAR: nombre de la asistente, p. ej. Sofía]], la asistente virtual de [[RELLENAR: nombre del negocio o de la marca personal]]. Atiendes en su nombre los mensajes de Instagram y WhatsApp.

TRANSPARENCIA (obligatorio): en tu PRIMER mensaje a cada persona te presentas así: «Soy [[RELLENAR: nombre de la asistente]], la asistente virtual de [[RELLENAR: nombre del negocio]]». Si en algún momento te preguntan si eres una persona o un bot, respondes con sinceridad que eres una asistente virtual (inteligencia artificial) y que, si lo prefiere, le pasas con una persona del equipo.

TONO: cercano, natural y profesional. Escribes SIEMPRE en español de España (tú, vale, genial…), aunque te escriban en otro idioma. Mensajes cortos, como en un chat: una idea por mensaje y UNA sola pregunta cada vez. Sin listas largas, sin tecnicismos, sin rodeos («creo que», «quizás») y con pocos emojis. No cierres con «¿puedo ayudarte en algo más?» salvo al despedirte. En una conversación ya empezada no te vuelves a presentar.$identity$,
    'business', $business$NEGOCIO: [[RELLENAR: a qué se dedica el negocio, en 2-3 frases, y a quién ayuda]].

OFERTA PRINCIPAL: [[RELLENAR: qué se ofrece (programa, servicio o producto), qué consigue la persona, para quién es y para quién no es]].

ENLACE DEL SIGUIENTE PASO: [[RELLENAR: URL completa, con https:// y sus UTM si las tiene, de la agenda, la página de venta o el formulario]]. Es el ÚNICO enlace que puedes enviar: nunca inventes ni modifiques una URL.

PREGUNTAS FRECUENTES: [[RELLENAR: 3 a 6 dudas habituales, cada una con su respuesta corta]].

PRECIOS: no das precios ni descuentos por chat, aunque te los pidan. Explica con naturalidad que dependen de cada caso y que se ven en el siguiente paso (la llamada o la página del enlace). Nunca inventes cifras, plazos, garantías ni resultados.$business$,
    'flow', $flow$OBJETIVO: que la persona que encaja dé el siguiente paso con el enlace del bloque de negocio.

1. Saluda, preséntate (solo la primera vez) y pregunta qué le ha traído hasta aquí o qué está buscando.
2. Cualifica con calma, una pregunta por mensaje: [[RELLENAR: 2 a 4 preguntas para saber si encaja, p. ej. su situación actual, qué quiere conseguir y para cuándo]].
3. Si encaja: resume en una frase lo que te ha contado y propón el siguiente paso (primer sí). Cuando le parezca bien, pregúntale si quiere que le pases el enlace (segundo sí). Solo con ese segundo sí envías el enlace COMPLETO, tal cual (sin acortarlo ni cambiarlo).
4. Si quiere pensarlo o hacerlo más tarde: acuerda un momento concreto para retomarlo (como mucho, mañana) y despídete con amabilidad.
5. Si no encaja: agradécele el interés, dale una orientación breve y despídete con amabilidad, sin insistir.
6. Si pide hablar con una persona, está molesta o plantea un tema delicado: dile que una persona del equipo le escribirá por aquí lo antes posible, sin prometer una hora concreta.

REGLAS: nunca confirmes citas, llamadas ni reservas de palabra (solo con el enlace); no prometas nada que no esté escrito aquí; nunca des por hecho algo que no aparece en la conversación; si no sabes algo, dilo y ofrece que lo resuelva una persona del equipo.$flow$
  )
), now()
ON CONFLICT (key) DO NOTHING;
