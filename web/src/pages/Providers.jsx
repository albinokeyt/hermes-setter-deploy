import { useEffect, useState } from 'react';
import { Plus, Plug, Trash2, FlaskConical } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Select, Banner, EmptyState } from '../components/ui.jsx';

const EMPTY = { name: '', base_url: '', api_key: '', default_model: '', notes: '', price_in: '', price_out: '', kinds: ['text'] };

const KIND_META = [
  { key: 'text', label: 'Texto (chat)', icon: '💬' },
  { key: 'image', label: 'Imagen (visión)', icon: '👁️' },
  { key: 'audio', label: 'Audio (voz)', icon: '🎤' },
];

function KindPicker({ value, onChange }) {
  const kinds = Array.isArray(value) ? value : [];
  const toggle = (k) => onChange(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">¿Para qué sirve esta API?</span>
      <div className="flex flex-wrap gap-2">
        {KIND_META.map((k) => {
          const on = kinds.includes(k.key);
          return (
            <button key={k.key} type="button" onClick={() => toggle(k.key)}
              className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${on ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
              {k.icon} {k.label}
            </button>
          );
        })}
      </div>
      <span className="mt-1 block text-xs text-slate-400">Marca todo lo que soporte. OpenRouter suele valer para las tres.</span>
    </div>
  );
}

export default function Providers() {
  const [providers, setProviders] = useState([]);
  const [presets, setPresets] = useState([]);
  const [form, setForm] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/api/providers').then(setProviders).catch(() => {});
  useEffect(() => { load(); api.get('/api/providers/presets').then(setPresets).catch(() => {}); }, []);

  const applyPreset = (name) => {
    const p = presets.find((x) => x.name === name);
    if (p) setForm({ ...form, name: p.name === 'Personalizado' ? '' : p.name, base_url: p.base_url, default_model: p.default_model, notes: p.notes, kinds: p.kinds || ['text'] });
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) await api.put(`/api/providers/${editingId}`, form);
      else await api.post('/api/providers', form);
      setForm(null);
      setEditingId(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async (id) => {
    setTestResult((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const r = await api.post(`/api/providers/${id}/test`, {});
      setTestResult((prev) => ({ ...prev, [id]: { ok: true, msg: r.respuesta } }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, msg: err.message } }));
    }
  };

  return (
    <div>
      <SectionTitle
        title="APIs de IA"
        subtitle="Conecta los proveedores que quieras — cualquiera compatible con /chat/completions — y elige cuál usa cada cuenta"
        actions={<Button onClick={() => { setForm({ ...EMPTY }); setEditingId(null); }}><Plus size={16} /> Añadir API</Button>}
      />

      {form && (
        <Card className="mb-6 p-6">
          <form onSubmit={save} className="space-y-4">
            {error && <Banner tone="error">{error}</Banner>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Plantilla rápida" defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
                <option value="" disabled>Elige un proveedor…</option>
                {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </Select>
              <Input label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. OpenRouter" required />
            </div>
            <Input label="URL base" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://openrouter.ai/api/v1" required />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="API key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={editingId ? '(dejar vacío para no cambiarla)' : 'sk-…'} required={!editingId} />
              <Input label="Modelo por defecto" value={form.default_model} onChange={(e) => setForm({ ...form, default_model: e.target.value })} placeholder="google/gemini-2.5-flash-lite" />
            </div>
            <KindPicker value={form.kinds} onChange={(kinds) => setForm({ ...form, kinds })} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Precio entrada ($ por 1M tokens)" type="number" step="0.001" min="0" value={form.price_in} onChange={(e) => setForm({ ...form, price_in: e.target.value })} hint="Opcional: para estimar el gasto. OpenRouter reporta el coste real solo." />
              <Input label="Precio salida ($ por 1M tokens)" type="number" step="0.001" min="0" value={form.price_out} onChange={(e) => setForm({ ...form, price_out: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>{editingId ? 'Guardar cambios' : 'Añadir'}</Button>
              <Button variant="ghost" type="button" onClick={() => { setForm(null); setEditingId(null); }}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {providers.length === 0 && !form ? (
        <EmptyState
          icon={Plug}
          title="Sin proveedores de IA"
          subtitle="Añade OpenRouter, Google Gemini, Groq o cualquier API compatible. Cada cuenta podrá usar el proveedor y modelo que quieras."
          action={<Button onClick={() => setForm({ ...EMPTY })}><Plus size={16} /> Añadir la primera</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {providers.map((p) => (
            <Card key={p.id} className="fade-up p-5">
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Plug size={18} /></div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => { setEditingId(p.id); setForm({ name: p.name, base_url: p.base_url, api_key: '', default_model: p.default_model, notes: p.notes, price_in: p.price_in || '', price_out: p.price_out || '', kinds: p.kinds || ['text'] }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    Editar
                  </Button>
                  <button
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                    onClick={async () => { if (window.confirm(`¿Eliminar ${p.name}?`)) { await api.del(`/api/providers/${p.id}`); load(); } }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <h3 className="mt-3 font-bold text-slate-900">{p.name}</h3>
              <p className="truncate text-xs text-slate-400">{p.base_url}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(p.kinds || []).map((k) => {
                  const m = KIND_META.find((x) => x.key === k);
                  return m ? <span key={k} className="rounded-md bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{m.icon} {m.label.split(' ')[0]}</span> : null;
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                {p.default_model && <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-500">{p.default_model}</span>}
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-slate-400">{p.api_key_masked}</span>
                <span className="rounded-md bg-violet-50 px-2 py-0.5 font-semibold text-violet-600">{p.accounts_count} cuenta{p.accounts_count === 1 ? '' : 's'}</span>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
                <Button variant="secondary" className="!py-1.5 text-xs" onClick={() => test(p.id)} loading={testResult[p.id]?.loading}>
                  <FlaskConical size={14} /> Probar conexión
                </Button>
                {testResult[p.id] && !testResult[p.id].loading && (
                  <span className={`truncate text-xs font-medium ${testResult[p.id].ok ? 'text-emerald-600' : 'text-red-500'}`}>
                    {testResult[p.id].ok ? `✓ Responde: "${testResult[p.id].msg}"` : `✗ ${testResult[p.id].msg}`}
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
