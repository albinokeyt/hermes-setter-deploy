-- 🏛️ CLUB DE SISTEMAS · el CORREO DEL CLUB de cada conexión (fase C, 13-nov-2026)
--
-- Los workflows de 4ttZ solo mandan el correo del comprador (no conocen la subcuenta del cliente). Hasta ahora Hermes solo
-- lo reconocía si era el RESPONSABLE (owner_email = el primer usuario que abre Hermes por SSO). Si soporte abría Hermes
-- antes que el cliente, el alta quedaba pendiente, la baja no apagaba nada y las devoluciones iban todas a revisión.
-- Ahora (services/club.js · correoDelClubSQL) una conexión del Club se reconoce por correo SOLO con:
--   · club_email: el correo de la compra, CONFIRMADO por soporte en la ficha de la conexión (Conexión GHL → «Club de
--     Sistemas») o por la API de admin al instalar Hermes. Al confirmarlo se aplica el último estado que esperaba por él.
-- El responsable (owner_email), el correo de la subcuenta en GHL (ghl_location_email, abajo) y los «correos autorizados»
-- NO enlazan: el responsable suele ser soporte y los otros dos los edita el cliente (con ellos podía quedarse con el alta
-- o la baja de otro comprador). Solo son pistas que la ficha enseña a soporte. Todo en minúsculas.
-- Solo se usan en conexiones del Club (creadas desde el corte club_desde de la 059); las anteriores no se tocan.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS club_email TEXT;
-- correo de la subcuenta tal como lo tiene GHL (GET /locations/{id}), leído al crear la conexión y al reconectarla por
-- OAuth. Es solo una PISTA para soporte. Se guarda la PRIMERA vez y no se pisa sola: si en una reconexión GHL tiene otro,
-- se anota «club_correo_subcuenta_distinto» en el registro de eventos.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ghl_location_email TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ghl_location_email_at TIMESTAMPTZ;

ALTER TABLE accounts ADD CONSTRAINT accounts_club_email_minusculas
  CHECK (club_email IS NULL OR (club_email = lower(btrim(club_email)) AND club_email <> ''));
ALTER TABLE accounts ADD CONSTRAINT accounts_ghl_location_email_minusculas
  CHECK (ghl_location_email IS NULL OR (ghl_location_email = lower(btrim(ghl_location_email)) AND ghl_location_email <> ''));

-- un mismo correo del Club en dos conexiones haría ambiguo el interruptor y las devoluciones: la base no lo admite
CREATE UNIQUE INDEX IF NOT EXISTS accounts_club_email_unico ON accounts (club_email) WHERE club_email IS NOT NULL;
