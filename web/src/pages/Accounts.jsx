import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Building2, Link2, Link2Off } from 'lucide-react';
import { api } from '../api.js';
import { CHANNEL_LABEL } from '../stages.js';
import { Card, SectionTitle, Button, Input, EmptyState } from '../components/ui.jsx';

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const acc = await api.post('/api/accounts', { name: name.trim() });
      navigate(`/cuentas/${acc.id}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <SectionTitle
        title="Cuentas"
        subtitle="Cada cuenta es una subcuenta de GHL con su propio setter: su prompt, su IA y sus seguimientos"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} /> Nueva cuenta</Button>}
      />

      {creating && (
        <Card className="mb-5 p-5">
          <form onSubmit={create} className="flex items-end gap-3">
            <div className="flex-1">
              <Input label="Nombre de la cuenta (cliente)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Albatros · Valoraciones" autoFocus />
            </div>
            <Button type="submit" loading={loading}>Crear</Button>
            <Button variant="ghost" type="button" onClick={() => setCreating(false)}>Cancelar</Button>
          </form>
        </Card>
      )}

      {accounts.length === 0 && !creating ? (
        <EmptyState
          icon={Building2}
          title="Aún no tienes cuentas"
          subtitle="Crea una cuenta por cada cliente (subcuenta de GHL) y configura su setter en minutos."
          action={<Button onClick={() => setCreating(true)}><Plus size={16} /> Crear la primera</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((a) => {
            const connected = a.mode === 'pit' ? Boolean(a.pit_token) : a.oauth_connected;
            return (
              <Link key={a.id} to={`/cuentas/${a.id}`}>
                <Card className="fade-up h-full p-5 transition hover:border-violet-300 hover:shadow-md">
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                      <Building2 size={19} />
                    </div>
                    <span className="flex items-center gap-1.5">
                      {a.test_mode && (
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-600">🧪 TEST</span>
                      )}
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        a.bot_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${a.bot_enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        {a.bot_enabled ? 'Bot activo' : 'Apagado'}
                      </span>
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-bold text-slate-900">{a.name}</h3>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                    {connected ? <Link2 size={13} className="text-emerald-500" /> : <Link2Off size={13} className="text-amber-500" />}
                    {connected ? 'GHL conectado' : 'Sin conectar a GHL'}
                    {a.provider_name && <span>· {a.provider_name}</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(a.channels || []).map((ch) => (
                      <span key={ch} className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                        {CHANNEL_LABEL[ch] || ch}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                    <span className="font-bold text-slate-800">{a.conversations_count}</span> conversaciones ·{' '}
                    <span className="font-bold text-slate-800">{a.active_24h}</span> activas hoy
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
