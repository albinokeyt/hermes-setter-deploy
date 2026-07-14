import { useEffect, useState } from 'react';
import { X, Plus, ShieldCheck, Crown } from 'lucide-react';
import { api } from '../api.js';
import { Card, Button, Input, Banner } from './ui.jsx';

// Gestor de correos autorizados de un setter.
// El responsable (owner) puede añadir/quitar correos; el resto lo ve en modo lectura.
export function AccessManager({ accountId }) {
  const [data, setData] = useState(null);
  const [nuevo, setNuevo] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.get(`/api/portal/access?account_id=${accountId}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [accountId]);

  if (error && !data) return <Banner tone="error">{error}</Banner>;
  if (!data) return <div className="py-10 text-center text-sm text-slate-400">Cargando…</div>;

  const owner = (data.owner_email || '').toLowerCase();
  const canManage = data.can_manage;

  // A quien no gestiona no se le revela el correo del responsable ni la lista.
  if (!canManage) {
    return (
      <div className="max-w-xl space-y-4">
        <Card className="space-y-3 p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-emerald-600" />
            <h3 className="text-sm font-bold text-slate-800">Correos con acceso al panel</h3>
          </div>
          <p className="text-xs text-slate-500">
            El acceso a este panel está restringido por correo. Estás dentro como <b>{data.my_email || 'tu correo'}</b>.
          </p>
          <p className="text-xs text-slate-400">
            {data.has_owner
              ? 'Solo la persona responsable puede añadir o quitar accesos. Pídeselo a esa persona (o a la agencia).'
              : 'Este setter aún no tiene un responsable asignado. Contacta con la agencia para configurarlo.'}
          </p>
        </Card>
      </div>
    );
  }

  const persist = async (emails) => {
    setSaving(true); setError('');
    try {
      const r = await api.put('/api/portal/access', { account_id: accountId, emails });
      setData({ ...data, emails: r.emails, owner_email: r.owner_email });
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const add = () => {
    const e = nuevo.trim().toLowerCase();
    if (!e.includes('@')) { setError('Escribe un correo válido'); return; }
    if (data.emails.includes(e)) { setNuevo(''); return; }
    setNuevo('');
    persist([...data.emails, e]);
  };
  const remove = (e) => persist(data.emails.filter((x) => x !== e));

  return (
    <div className="max-w-xl space-y-4">
      <Card className="space-y-4 p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-800">Correos con acceso al panel</h3>
        </div>
        <p className="text-xs text-slate-500">
          El enlace de GHL lo pueden abrir todos, pero <b>solo entran los correos de esta lista</b>. El correo con el que se instaló el setter es el <b>responsable</b> y es quien puede añadir o quitar a los demás.
        </p>

        {error && <Banner tone="error">{error}</Banner>}
        {saved && <Banner tone="ok">Guardado</Banner>}

        <div className="space-y-2">
          {data.emails.length === 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Aún sin reclamar: el primer correo que entre por el enlace quedará como responsable.
            </p>
          )}
          {data.emails.map((e) => (
            <div key={e} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-slate-700">
                {e === owner && <Crown size={14} className="text-amber-500" title="Responsable" />}
                {e}
                {e === data.my_email && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">tú</span>}
              </span>
              {canManage && e !== owner && (
                <button onClick={() => remove(e)} disabled={saving} className="text-slate-400 hover:text-red-500 disabled:opacity-40" title="Quitar acceso">
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
        </div>

        {canManage ? (
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="correo@ejemplo.com"
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            />
            <Button onClick={add} loading={saving}><Plus size={16} /> Añadir</Button>
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            Solo el responsable{owner ? ` (${owner})` : ''} puede cambiar quién tiene acceso. Pídeselo a esa persona.
          </p>
        )}
      </Card>
    </div>
  );
}
