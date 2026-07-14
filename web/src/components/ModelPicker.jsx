import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Loader2 } from 'lucide-react';
import { api } from '../api.js';

// Categorías que coinciden con las pestañas de OpenRouter.
const CATEGORIES = [
  { key: 'text', label: 'Texto · chat' },
  { key: 'vision', label: 'Imagen · leer (visión)' },
  { key: 'transcription', label: 'Audio · transcripción' },
  { key: 'image', label: 'Imagen · generar' },
  { key: 'speech', label: 'Voz · texto a audio' },
  { key: 'video', label: 'Video' },
];

// El tipo de campo elige la categoría por defecto (pero se puede cambiar).
const DEFAULT_CAT = { text: 'text', image: 'vision', audio: 'transcription' };

// caché por categoría, compartida entre todos los pickers
const cache = {};
function loadModels(cat) {
  if (!cache[cat]) {
    cache[cat] = api.get(`/api/providers/models?category=${cat}`).then((r) => r.models || []).catch(() => []);
  }
  return cache[cat];
}

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 placeholder:text-slate-400';

export function ModelPicker({ label, value, onChange, isOpenRouter, kind = 'text', placeholder, hint, onPick }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(DEFAULT_CAT[kind] || 'text');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open || !isOpenRouter) return;
    setLoading(true);
    loadModels(category).then((m) => { setModels(m); setLoading(false); });
  }, [open, isOpenRouter, category]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const wrap = (children) => (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );

  if (!isOpenRouter) {
    return wrap(<input className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />);
  }

  const q = query.trim().toLowerCase();
  const matched = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
  const shown = matched.slice(0, 150);

  return wrap(
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between text-left ${value ? 'text-slate-800' : 'text-slate-400'}`}
      >
        <span className="truncate">{value || placeholder || 'Elige un modelo…'}</span>
        <ChevronDown size={16} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <div className="mb-2 flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => { setCategory(c.key); setModels([]); }}
                  className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition ${category === c.key ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
              <Search size={15} className="text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar modelo…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
            </div>
          </div>
          <div className="scroll-thin max-h-64 overflow-y-auto">
            {loading && <div className="flex items-center gap-2 px-3 py-4 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Cargando modelos…</div>}
            {!loading && shown.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); onPick?.(m); setOpen(false); setQuery(''); }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-800">{m.id}</span>
                  <span className="block truncate text-[11px] text-slate-400">{m.name}</span>
                </span>
                <span className="shrink-0 text-[11px] font-medium text-slate-500">${m.price_in}/${m.price_out}</span>
              </button>
            ))}
            {!loading && !matched.length && <div className="px-3 py-4 text-xs text-slate-400">Sin resultados en esta categoría</div>}
            {!loading && matched.length > 150 && <div className="px-3 py-2 text-[11px] text-slate-400">Mostrando 150 de {matched.length} — escribe para filtrar</div>}
          </div>
        </div>
      )}
    </div>
  );
}
