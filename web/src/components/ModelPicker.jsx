import { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Loader2 } from 'lucide-react';
import { api } from '../api.js';

// caché por tipo, compartida entre todos los pickers
const cache = {};
function loadModels(kind) {
  if (!cache[kind]) {
    cache[kind] = api.get(`/api/providers/models?kind=${kind}`).then((r) => r.models || []).catch(() => []);
  }
  return cache[kind];
}

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 placeholder:text-slate-400';

// Buscador de modelos: si el proveedor es OpenRouter, muestra un desplegable
// con búsqueda; si no, un campo de texto normal.
export function ModelPicker({ label, value, onChange, isOpenRouter, kind = 'text', placeholder, hint, onPick }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (open && isOpenRouter && !models.length) {
      setLoading(true);
      loadModels(kind).then((m) => { setModels(m); setLoading(false); });
    }
  }, [open, isOpenRouter, kind]); // eslint-disable-line

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
    return wrap(
      <input className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = (q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models).slice(0, 60);

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
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search size={15} className="text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar modelo…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
            />
          </div>
          <div className="scroll-thin max-h-64 overflow-y-auto">
            {loading && <div className="flex items-center gap-2 px-3 py-4 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Cargando modelos…</div>}
            {!loading && filtered.map((m) => (
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
            {!loading && !filtered.length && <div className="px-3 py-4 text-xs text-slate-400">Sin resultados</div>}
          </div>
        </div>
      )}
    </div>
  );
}
