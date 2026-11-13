-- 🏛️ CLUB DE SISTEMAS · el CORREO DEL CLUB de cada conexión (fase C, 13-nov-2026)
--
-- Los workflows de 4ttZ solo mandan el correo del comprador (no conocen la subcuenta del cliente). Hasta ahora Hermes solo
-- lo reconocía si era el RESPONSABLE (owner_email = el primer usuario que abre Hermes por SSO). Si soporte abría Hermes
-- antes que el cliente, el alta quedaba pendiente, la baja no apagaba nada y las devoluciones iban todas a revisión.
-- Ahora una conexión del Club se reconoce por correo con (services/club.js · correoDelClubSQL):
--   · club_email (lo pone SOLO el admin en la ficha de la conexión o por la API de admin). Si está puesto, MANDA: el
--     responsable y el correo de la subcuenta ya no cuentan para esa conexión.
--   · si no hay club_email: el responsable (owner_email) o el correo de la subcuenta en GHL (ghl_location_email).
-- Los «correos autorizados» siguen sin contar (los edita el propio cliente). Todo en minúsculas.
-- Solo se usan en conexiones del Club (creadas desde el corte club_desde de la 059); las anteriores no se tocan.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS club_email TEXT;
-- correo de la subcuenta tal como lo tiene GHL (GET /locations/{id}), leído al crear o reconectar la conexión. Se guarda
-- la PRIMERA vez y no se pisa solo (si el cliente lo cambia luego en GHL, no se sigue: se anota en el registro).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ghl_location_email TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ghl_location_email_at TIMESTAMPTZ;

ALTER TABLE accounts ADD CONSTRAINT accounts_club_email_minusculas
  CHECK (club_email IS NULL OR (club_email = lower(btrim(club_email)) AND club_email <> ''));
ALTER TABLE accounts ADD CONSTRAINT accounts_ghl_location_email_minusculas
  CHECK (ghl_location_email IS NULL OR (ghl_location_email = lower(btrim(ghl_location_email)) AND ghl_location_email <> ''));

-- un mismo correo del Club en dos conexiones haría ambiguo el interruptor y las devoluciones: la base no lo admite
CREATE UNIQUE INDEX IF NOT EXISTS accounts_club_email_unico ON accounts (club_email) WHERE club_email IS NOT NULL;
