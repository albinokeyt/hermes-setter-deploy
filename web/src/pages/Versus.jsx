import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Swords } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Select, EmptyState } from '../components/ui.jsx';

const STATUS = { active: { t: 'Activo', c: 'bg-emerald-50 text-emerald-600' }, paused: { t: 'Pausado', c: 'bg-amber-50 text-amber-600' }, finished: { t: 'Finalizado', c: 'bg-slate-100 text-slate-500' } };

export default function Versus() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', win_metric: 'agendas', audience: 'all', audience_tag: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.get('/api/versus').then(setList).catch(() => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setLoading(true);
    try {
      const v = await api.post('/api/versus', form);
      navigate(`/versus/${v.id}`);
    } finally { setLoading(false); }
  };

  return (
    <div>
      <SectionTitle
        title="⚔️ Versus"
        subtitle="Enfrenta setters (de cualquier conexión) sobre la misma audiencia y mira cuál rinde mejor"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} /> Nuevo versus</Button>}
      />

      {creating && (
        <Card className="mb-5 space-y-4 p-6">
          <form onSubmit={create} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Nombre del versus" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Sofía vs. Lucía" autoFocus />
              <Select label="Métrica ganadora" value={form.win_metric} onChange={(e) => setForm({ ...form, win_metric: e.target.value })}>
                <option value="agendas">Tasa de agenda</option>
                <option value="conversion">Tasa de conversión</option>
                <option value="calificacion">Tasa de calificación</option>
              </Select>
              <Select label="¿Qué leads compiten?" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
                <option value="all">Todos los leads entrantes</option>
                <option value="tag">Solo los que tengan una etiqueta</option>
              </Select>
              {form.audience === 'tag' && (
                <Input label="Etiqueta de GHL" value={form.audience_tag} onChange={(e) => setForm({ ...form, audience_tag: e.target.value })} placeholder="ej. promo-julio" />
              )}
            </div>
            <div className="flex gap-2">
              <Button type="submit" loading={loading}>Crear y elegir setters</Button>
              <Button variant="ghost" type="button" onClick={() => setCreating(false)}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {list.length === 0 && !creating ? (
        <EmptyState icon={Swords} title="Aún no hay versus" subtitle="Crea uno, elige los setters que compiten y compara su rendimiento con la misma audiencia." action={<Button onClick={() => setCreating(true)}><Plus size={16} /> Crear el primero</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((v) => (
            <Link key={v.id} to={`/versus/${v.id}`}>
              <Card className="fade-up h-full p-5 transition hover:border-violet-300 hover:shadow-md">
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Swords size={18} /></span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS[v.status]?.c || ''}`}>{STATUS[v.status]?.t || v.status}</span>
                </div>
                <h3 className="mt-3 text-base font-bold text-slate-900">{v.name}</h3>
                <div className="mt-1 text-xs text-slate-400">{v.audience === 'tag' ? `Leads con «${v.audience_tag}»` : 'Todos los leads entrantes'}</div>
                <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <span className="font-bold text-slate-800">{v.setters_count}</span> setters · <span className="font-bold text-slate-800">{v.leads_count}</span> leads
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
