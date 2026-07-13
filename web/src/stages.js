export const STAGES = [
  { key: 'nuevo', label: 'Nuevo', dot: 'bg-slate-400', pill: 'bg-slate-100 text-slate-600 ring-slate-200', hex: '#94a3b8' },
  { key: 'en_conversacion', label: 'En conversación', dot: 'bg-blue-500', pill: 'bg-blue-50 text-blue-700 ring-blue-200', hex: '#3b82f6' },
  { key: 'en_seguimiento', label: 'En seguimiento', dot: 'bg-amber-500', pill: 'bg-amber-50 text-amber-700 ring-amber-200', hex: '#f59e0b' },
  { key: 'calificado', label: 'Calificado', dot: 'bg-violet-500', pill: 'bg-violet-50 text-violet-700 ring-violet-200', hex: '#8b5cf6' },
  { key: 'en_conversion', label: 'En conversión', dot: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200', hex: '#10b981' },
  { key: 'descartado', label: 'Descartado', dot: 'bg-red-400', pill: 'bg-red-50 text-red-600 ring-red-200', hex: '#f87171' },
];

export const stageByKey = (key) => STAGES.find((s) => s.key === key) || STAGES[0];

export const CHANNELS = ['IG', 'WhatsApp', 'FB', 'SMS', 'Live_Chat'];

export const CHANNEL_LABEL = { IG: 'Instagram', WhatsApp: 'WhatsApp', FB: 'Facebook', SMS: 'SMS', Live_Chat: 'Chat web' };
