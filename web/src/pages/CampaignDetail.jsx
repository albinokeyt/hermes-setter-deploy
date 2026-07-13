import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Trophy, Pencil } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Textarea, Select, Banner } from '../components/ui.jsx';

const fmtUsd = (v) => `$${Number(v || 0).toFixed(2)}`;
const GOLD = '#b58a2e';
const GOLD_SOFT = '#dcbf6f';

function VariantEditor({ campaignId, variant, providers, onDone }) {
  const [v, setV] = useState(variant);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setV({ ...v, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      if (v.id) await api.put(`/api/variants/${v.id}`, v);
      else await api.post(`/api/campaigns/${campaignId}/variants`, v);
      onDone(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <Input label="Nombre del agente" value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ej. Lucía cálida" />
        <Input label="Peso (%)" type="number" min="0" max="100" value={v.weight} onChange={(e) => set({ weight: Number(e.target.value) })} hint="reparto" />
      </div>
      <Textarea label="1 · Identidad" rows={4} value={v.prompt_identity} onChange={(e) => set({ prompt_identity: e.target.value })} />
      <Textarea label="2 · Negocio y oferta" rows={4} value={v.prompt_business} onChange={(e) => set({ prompt_business: e.target.value })} />
      <Textarea label="3 · Flujo y objetivo" rows={4} value={v.prompt_flow} onChange={(e) => set({ prompt_flow: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select label="Proveedor" value={v.provider_id || ''} onChange={(e) => set({ provider_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">— Elige —</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input label="Modelo" value={v.model} onChange={(e) => set({ model: e.target.value })} placeholder="por defecto" />
        <Input label={`Temperatura: ${v.temperature}`} type="range" min="0" max="1.5" step="0.1" value={v.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} className="!p-0 accent-violet-600" />
      </div>
      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>Guardar agente</Button>
        <Button variant="ghost" onClick={() => onDone(false)}>Cancelar</Button>
      </div>
    </Card>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = () => api.get(`/api/campaigns/${id}`).then(setData).catch(() => {});
  useEffect(() => { load(); api.get('/api/providers').then(setProviders).catch(() => {}); }, [id]);

  if (!data) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const patchCampaign = async (patch) => { await api.put(`/api/campaigns/${id}`, { ...data, ...patch }); load(); };
  const totalWeight = (data.variants || []).reduce((s, v) => s + (v.weight || 0), 0);
  const metricLabel = { agendas: 'tasa de agenda', conversion: 'tasa de conversión', calificacion: 'tasa de calificación' }[data.win_metric];
  const chartData = (data.results || []).map((r) => ({ name: r.name, valor: data.win_metric === 'calificacion' ? r.tasa_calificacion : data.win_metric === 'conversion' ? r.tasa_conversion : r.tasa_agenda, id: r.id }));

  return (
    <div>
      <Link to="/competencias" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Competencias
      </Link>
      <SectionTitle
        title={data.name}
        subtitle={`${data.account_name} · ganador por ${metricLabel}`}
        actions={
          <div className="flex items-center gap-2">
            <Select value={data.status} onChange={(e) => patchCampaign({ status: e.target.value })} className="!w-40">
              <option value="active">Activa</option>
              <option value="paused">Pausada</option>
              <option value="finished">Finalizada</option>
            </Select>
            <Button variant="danger" onClick={async () => { if (window.confirm('¿Eliminar la competencia?')) { await api.del(`/api/campaigns/${id}`); navigate('/competencias'); } }}>
              <Trash2 size={15} />
            </Button>
          </div>
        }
      />

      {totalWeight !== 100 && (data.variants || []).length > 0 && (
        <div className="mb-4"><Banner tone="warn">Los pesos suman {totalWeight}% (no 100%). Se reparte igualmente de forma proporcional, pero ajústalos para que sea más claro.</Banner></div>
      )}

      {(data.results || []).length > 0 && (
        <Card className="mb-6 p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Comparativa — {metricLabel} (%)</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} formatter={(v) => `${v}%`} />
                <Bar dataKey="valor" radius={[6, 6, 0, 0]}>
                  {chartData.map((d) => <Cell key={d.id} fill={d.id === data.winner_id ? GOLD : GOLD_SOFT} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5"><h3 className="text-sm font-semibold text-slate-700">Resultados por agente</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                <th className="px-5 py-3 font-medium">Agente</th>
                <th className="px-3 py-3 font-medium">Peso</th>
                <th className="px-3 py-3 font-medium">Leads</th>
                <th className="px-3 py-3 font-medium">Calif.</th>
                <th className="px-3 py-3 font-medium">Conv.</th>
                <th className="px-3 py-3 font-medium">Agendas</th>
                <th className="px-3 py-3 font-medium">T. agenda</th>
                <th className="px-3 py-3 font-medium">Gasto</th>
                <th className="px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {(data.results || []).map((r) => (
                <tr key={r.id} className={`border-t border-slate-50 ${r.id === data.winner_id ? 'bg-violet-50/40' : ''}`}>
                  <td className="px-5 py-3 font-semibold text-slate-800">
                    <span className="inline-flex items-center gap-1.5">
                      {r.id === data.winner_id && <Trophy size={14} className="text-violet-600" />}
                      {r.name}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-500">{r.weight}%</td>
                  <td className="px-3 py-3 font-semibold text-slate-800">{r.leads}</td>
                  <td className="px-3 py-3">{r.calificados}</td>
                  <td className="px-3 py-3">{r.en_conversion}</td>
                  <td className="px-3 py-3 font-semibold text-emerald-600">{r.agendados}</td>
                  <td className="px-3 py-3 font-semibold text-violet-600">{r.tasa_agenda}%</td>
                  <td className="px-3 py-3 text-slate-500">{fmtUsd(r.gasto)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(data.variants.find((v) => v.id === r.id))} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil size={14} /></button>
                      <button onClick={async () => { if (window.confirm(`¿Quitar el agente ${r.name}?`)) { await api.del(`/api/variants/${r.id}`); load(); } }} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {(data.results || []).length === 0 && (
                <tr><td colSpan={9} className="px-5 py-8 text-center text-sm text-slate-400">Añade al menos 2 agentes para empezar la competencia</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {editing ? (
        <VariantEditor campaignId={id} variant={editing} providers={providers} onDone={(saved) => { setEditing(null); if (saved) load(); }} />
      ) : (
        <Button variant="secondary" onClick={() => setEditing({ name: '', weight: 50, prompt_identity: '', prompt_business: '', prompt_flow: '', provider_id: null, model: '', temperature: 0.8, max_msgs: 3, debounce_seconds: 35, followups: [] })}>
          <Plus size={16} /> Añadir agente a la competencia
        </Button>
      )}
    </div>
  );
}
