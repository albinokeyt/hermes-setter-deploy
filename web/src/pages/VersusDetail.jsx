import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Trophy, Swords } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Select, Banner } from '../components/ui.jsx';

export default function VersusDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [v, setV] = useState(null);
  const [avail, setAvail] = useState([]);
  const [add, setAdd] = useState({ setter_id: '', weight: 50 });
  const [saved, setSaved] = useState(false);

  const load = () => api.get(`/api/versus/${id}`).then(setV).catch(() => {});
  useEffect(() => { load(); api.get('/api/versus/available-setters').then(setAvail).catch(() => {}); }, [id]);
  if (!v) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const save = async (patch) => {
    const body = { name: v.name, status: v.status, win_metric: v.win_metric, audience: v.audience, audience_tag: v.audience_tag, ...patch };
    await api.put(`/api/versus/${id}`, body);
    setSaved(true); setTimeout(() => setSaved(false), 1500);
    load();
  };
  const addSetter = async () => {
    if (!add.setter_id) return;
    await api.post(`/api/versus/${id}/setters`, { setter_id: Number(add.setter_id), weight: Number(add.weight) || 50 });
    setAdd({ setter_id: '', weight: 50 });
    load();
  };
  const setWeight = async (linkId, weight) => { await api.put(`/api/versus/setters/${linkId}`, { weight: Number(weight) || 50 }); load(); };
  const removeSetter = async (linkId) => { await api.del(`/api/versus/setters/${linkId}`); load(); };

  const usedIds = new Set(v.setters.map((s) => s.setter_id));
  const metricLabel = { agendas: 'tasa_agenda', conversion: 'tasa_conversion', calificacion: 'tasa_calificacion' }[v.win_metric] || 'tasa_agenda';
  const maxRate = Math.max(1, ...v.results.map((r) => r[metricLabel] || 0));

  return (
    <div>
      <Link to="/versus" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"><ArrowLeft size={15} /> Versus</Link>
      <SectionTitle
        title={<span className="inline-flex items-center gap-2"><Swords size={20} className="text-violet-600" /> {v.name}</span>}
        subtitle="Los setters compiten sobre la misma audiencia. Al estar ACTIVO, ignora las etiquetas de cada setter y reparte los leads por peso."
        actions={<span className="text-xs text-slate-400">{saved ? '✓ Guardado' : ''}</span>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Configuración */}
        <Card className="space-y-4 p-6">
          <h3 className="text-sm font-bold text-slate-800">Configuración</h3>
          <Select label="Estado" value={v.status} onChange={(e) => save({ status: e.target.value })}>
            <option value="active">Activo (gobierna el reparto)</option>
            <option value="paused">Pausado</option>
            <option value="finished">Finalizado</option>
          </Select>
          <Select label="Métrica ganadora" value={v.win_metric} onChange={(e) => save({ win_metric: e.target.value })}>
            <option value="agendas">Tasa de agenda</option>
            <option value="conversion">Tasa de conversión</option>
            <option value="calificacion">Tasa de calificación</option>
          </Select>
          <Select label="¿Qué leads compiten?" value={v.audience} onChange={(e) => save({ audience: e.target.value })}>
            <option value="all">Todos los leads entrantes</option>
            <option value="tag">Solo los que tengan una etiqueta</option>
          </Select>
          {v.audience === 'tag' && (
            <Input label="Etiqueta de GHL" defaultValue={v.audience_tag} onBlur={(e) => save({ audience_tag: e.target.value })} placeholder="ej. promo-julio" />
          )}
          <Button variant="danger" onClick={async () => { if (window.confirm('¿Eliminar este versus?')) { await api.del(`/api/versus/${id}`); navigate('/versus'); } }}>
            <Trash2 size={15} /> Eliminar versus
          </Button>
        </Card>

        {/* Competidores + resultados */}
        <div className="space-y-4 lg:col-span-2">
          <Banner tone="info">Un setter puede estar en varios versus. En cada conexión, el versus <b>activo más reciente</b> gobierna el reparto de su audiencia. Fuera de la audiencia, cada setter sigue su enrutado normal por etiquetas.</Banner>

          <Card className="p-6">
            <h3 className="mb-3 text-sm font-bold text-slate-800">Setters que compiten</h3>
            {v.results.length === 0 ? (
              <p className="text-xs text-slate-400">Añade setters abajo para que compitan.</p>
            ) : (
              <div className="space-y-3">
                {v.results.map((r) => {
                  const link = v.setters.find((s) => s.setter_id === r.id);
                  const isWin = r.id === v.winner_id;
                  return (
                    <div key={r.id} className={`rounded-xl border p-3.5 ${isWin ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200'}`}>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                          {isWin && <Trophy size={15} className="text-amber-500" />} {r.setter_name}
                          <span className="text-[11px] font-normal text-slate-400">· {r.account_name}</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-slate-400">peso</span>
                          <input type="number" min="0" max="1000" defaultValue={r.weight}
                            onBlur={(e) => link && setWeight(link.link_id, e.target.value)}
                            className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-violet-400" />
                          {link && <button onClick={() => removeSetter(link.link_id)} className="text-slate-300 hover:text-red-500"><Trash2 size={15} /></button>}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span><b className="text-slate-700">{r.leads}</b> leads</span>
                        <span><b className="text-emerald-600">{r.agendados}</b> agendas ({r.tasa_agenda}%)</span>
                        <span><b className="text-slate-700">{r.calificados}</b> calif.</span>
                        <span><b className="text-slate-700">{r.descartados}</b> descartados</span>
                        {r.gasto > 0 && <span>${r.gasto.toFixed(2)}</span>}
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full rounded-full ${isWin ? 'bg-amber-400' : 'bg-violet-400'}`} style={{ width: `${Math.round(((r[metricLabel] || 0) / maxRate) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 flex items-end gap-2 border-t border-slate-100 pt-4">
              <div className="flex-1">
                <Select label="Añadir setter al versus" value={add.setter_id} onChange={(e) => setAdd({ ...add, setter_id: e.target.value })}>
                  <option value="">— Elige un setter —</option>
                  {avail.filter((s) => !usedIds.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.account_name}</option>)}
                </Select>
              </div>
              <div className="w-24"><Input label="Peso" type="number" min="0" max="1000" value={add.weight} onChange={(e) => setAdd({ ...add, weight: e.target.value })} /></div>
              <Button onClick={addSetter}><Plus size={16} /> Añadir</Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
