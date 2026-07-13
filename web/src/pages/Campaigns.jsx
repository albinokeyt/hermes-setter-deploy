import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Swords, Trophy } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Select, EmptyState } from '../components/ui.jsx';

const STATUS = { active: { label: 'Activa', cls: 'bg-emerald-50 text-emerald-600' }, paused: { label: 'Pausada', cls: 'bg-amber-50 text-amber-600' }, finished: { label: 'Finalizada', cls: 'bg-slate-100 text-slate-500' } };

export default function Campaigns() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.get('/api/campaigns').then(setRows).catch(() => {});
  useEffect(() => { load(); api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const ca = await api.post('/api/campaigns', form);
      navigate(`/competencias/${ca.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <SectionTitle
        title="Competencias"
        subtitle="Pon varios agentes a competir por los mismos leads y mide quién convierte mejor"
        actions={<Button onClick={() => setForm({ account_id: accounts[0]?.id || '', name: '', win_metric: 'agendas' })}><Plus size={16} /> Nueva competencia</Button>}
      />

      {form && (
        <Card className="mb-6 p-6">
          <form onSubmit={create} className="space-y-4">
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Setter A vs B — julio" required />
              <Select label="Cuenta (subcuenta GHL)" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: Number(e.target.value) })}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <Select label="Ganador por" value={form.win_metric} onChange={(e) => setForm({ ...form, win_metric: e.target.value })}>
                <option value="agendas">Tasa de agenda</option>
                <option value="conversion">Tasa de conversión</option>
                <option value="calificacion">Tasa de calificación</option>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="submit">Crear y añadir agentes</Button>
              <Button variant="ghost" type="button" onClick={() => setForm(null)}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {rows.length === 0 && !form ? (
        <EmptyState
          icon={Swords}
          title="Sin competencias todavía"
          subtitle="Crea una competencia, mete 2 o más agentes con prompts o modelos distintos, y los leads se repartirán entre ellos automáticamente para ver cuál gana."
          action={<Button onClick={() => setForm({ account_id: accounts[0]?.id || '', name: '', win_metric: 'agendas' })}><Plus size={16} /> Crear la primera</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((c) => (
            <Link key={c.id} to={`/competencias/${c.id}`}>
              <Card className="fade-up h-full p-5 transition hover:border-violet-300 hover:shadow-md">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Swords size={18} /></div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS[c.status]?.cls || ''}`}>{STATUS[c.status]?.label || c.status}</span>
                </div>
                <h3 className="mt-3 text-base font-bold text-slate-900">{c.name}</h3>
                <p className="text-xs text-slate-400">{c.account_name}</p>
                <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <span className="font-bold text-slate-800">{c.variants_count}</span> agentes ·{' '}
                  <span className="font-bold text-slate-800">{c.leads_count}</span> leads repartidos
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
