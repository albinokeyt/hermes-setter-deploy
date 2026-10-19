-- 🧩 SKILLS del setter: acciones que puede ejecutar en el CRM además de conversar (pestaña «Skills»).
-- Objeto { clave: { activo, etiqueta, instrucciones } }; todas apagadas por defecto. La primera:
-- «cambiar_email» (el lead dice que ese no es su correo → el setter lo confirma y Hermes lo cambia en GHL).
ALTER TABLE setters ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '{}';
