-- Bandera OPCIONAL: cuando un paso de la cadencia de seguimientos no cabe en la ventana de
-- mensajeria de Meta, adelantarlo al ultimo hueco util en vez de dejarlo morir.
-- Hoy los pasos se miden desde el ENVIO anterior del bot y se acumulan: con 10 h + 23 h, el segundo
-- cae a 33 h del ultimo mensaje del LEAD, processFollowup lo marca 'ventana_cerrada' y no se
-- reprograma. Medido en Albatros: 627 primeros toques y CERO segundos, mientras el setter externo
-- da segundo toque al 62 % de sus cadenas.
-- Por defecto NULL/false = comportamiento de siempre: encenderlo es decision de cada cuenta.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS followup_fit_window BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE setters  ADD COLUMN IF NOT EXISTS followup_fit_window BOOLEAN NOT NULL DEFAULT false;
