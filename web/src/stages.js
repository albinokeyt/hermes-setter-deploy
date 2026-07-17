export const STAGES = [
  { key: 'nuevo', label: 'Nuevo', dot: 'bg-slate-400', pill: 'bg-slate-100 text-slate-600 ring-slate-200', hex: '#94a3b8', desc: 'El lead acaba de escribir; todavía no hay conversación real.' },
  { key: 'en_conversacion', label: 'En conversación', dot: 'bg-blue-500', pill: 'bg-blue-50 text-blue-700 ring-blue-200', hex: '#3b82f6', desc: 'Diálogo activo: el setter está conociendo y cualificando al lead.' },
  { key: 'en_seguimiento', label: 'En seguimiento', dot: 'bg-amber-500', pill: 'bg-amber-50 text-amber-700 ring-amber-200', hex: '#f59e0b', desc: 'El lead dejó de responder y el setter lo está retomando con mensajes de seguimiento.' },
  { key: 'calificado', label: 'Calificado', dot: 'bg-violet-500', pill: 'bg-violet-50 text-violet-700 ring-violet-200', hex: '#8b5cf6', desc: 'Cumple el filtro y mostró interés real; listo para llevarlo al objetivo (cita o enlace).' },
  { key: 'seguimiento_calificado', label: 'Seguimiento calificado', dot: 'bg-fuchsia-500', pill: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200', hex: '#d946ef', desc: 'Estaba calificado pero aún no dio el paso final (agendar o el enlace); el setter le hace seguimiento.' },
  { key: 'en_conversion', label: 'En conversión', dot: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200', hex: '#10b981', desc: 'Dio el paso clave hacia el objetivo: aceptó la propuesta, pidió/recibió el enlace (venta, recurso o agenda) o está reservando.' },
  { key: 'agendado', label: 'Agendado', dot: 'bg-teal-500', pill: 'bg-teal-50 text-teal-700 ring-teal-200', hex: '#14b8a6', desc: 'Reservó una cita en el calendario de GHL. Solo aplica si el objetivo del setter es agendar; lo detecta el sistema.' },
  { key: 'agenda_cancelada', label: 'Agenda cancelada', dot: 'bg-rose-400', pill: 'bg-rose-50 text-rose-600 ring-rose-200', hex: '#fb7185', desc: 'Su cita fue cancelada en el calendario de GHL.' },
  { key: 'descartado', label: 'Descartado', dot: 'bg-red-400', pill: 'bg-red-50 text-red-600 ring-red-200', hex: '#f87171', desc: 'No cumple el filtro, no le interesa o es spam; el setter deja de perseguirlo.' },
  { key: 'atencion_humana', label: 'Requiere atención humana', dot: 'bg-orange-500', pill: 'bg-orange-100 text-orange-700 ring-orange-300', hex: '#f97316', desc: 'La IA detectó que necesita a una persona. Mientras tenga esta etiqueta el bot NO responde; un humano lo atiende y luego lo mueve a otra etiqueta para reactivar.' },
];

export const stageByKey = (key) => STAGES.find((s) => s.key === key) || STAGES[0];

export const CHANNELS = ['IG', 'WhatsApp', 'FB', 'SMS', 'Live_Chat'];

export const CHANNEL_LABEL = { IG: 'Instagram', WhatsApp: 'WhatsApp', FB: 'Facebook', SMS: 'SMS', Live_Chat: 'Chat web' };
