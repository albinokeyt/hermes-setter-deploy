import { useEffect, useState } from 'react';
import { Plus, Trash2, KeyRound, ShieldCheck } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Select, Banner } from '../components/ui.jsx';

function MyProfile() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [current, setCurrent] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/api/auth/me').then((u) => setUsername(u.username || '')).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (password && password !== password2) return setMsg({ tone: 'error', text: 'Las contraseñas nuevas no coinciden' });
    setSaving(true);
    try {
      await api.put('/api/auth/me', { current_password: current, username, password: password || undefined });
      setMsg({ tone: 'ok', text: 'Datos actualizados' });
      setPassword(''); setPassword2(''); setCurrent('');
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <h3 className="mb-4 text-sm font-bold text-slate-800">Mi acceso</h3>
      <form onSubmit={save} className="space-y-4">
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        <Input label="Nombre de usuario" value={username} onChange={(e) => setUsername(e.target.value)} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Nueva contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="vacío = no cambiar" />
          <Input label="Repetir contraseña" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
        </div>
        <Input label="Contraseña actual (para confirmar)" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Button type="submit" loading={saving}>Guardar</Button>
      </form>
    </Card>
  );
}

export default function UsersPage() {
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    if (!isAdmin) return;
    api.get('/api/users').then(setData).catch(() => {});
    api.get('/api/accounts').then(setAccounts).catch(() => {});
  };
  useEffect(load, [isAdmin]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/users', form);
      setForm(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const resetPassword = async (u) => {
    const pwd = window.prompt(`Nueva contraseña para ${u.username}:`);
    if (!pwd) return;
    await api.put(`/api/users/${u.id}`, { password: pwd });
    window.alert('Contraseña actualizada');
  };

  const updateUser = async (u, patch) => {
    try {
      await api.put(`/api/users/${u.id}`, patch);
      load();
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div>
      <SectionTitle
        tour="page:usuarios"
        title="Usuarios"
        subtitle={isAdmin ? 'Tu acceso, el equipo del panel y los accesos desde GHL' : 'Tu acceso al panel'}
        actions={isAdmin && <Button onClick={() => setForm({ username: '', password: '', role: 'user', account_id: '', can_manage_agents: true })}><Plus size={16} /> Nuevo usuario</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <MyProfile />

          {isAdmin && form && (
            <Card className="p-6">
              <h3 className="mb-4 text-sm font-bold text-slate-800">Nuevo usuario del panel</h3>
              <form onSubmit={create} className="space-y-4">
                {error && <Banner tone="error">{error}</Banner>}
                <div className="grid grid-cols-2 gap-4">
                  <Input label="Usuario" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
                  <Input label="Contraseña" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Select label="Rol" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    <option value="user">Usuario (solo su agente)</option>
                    <option value="admin">Administrador</option>
                  </Select>
                  {form.role === 'user' && (
                    <Select label="Cuenta a la que pertenece" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">— Todas (solo lectura global) —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  )}
                </div>
                {form.role === 'user' && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                    <input type="checkbox" className="mt-0.5 accent-violet-600" checked={form.can_manage_agents !== false} onChange={(e) => setForm({ ...form, can_manage_agents: e.target.checked })} />
                    <span><b>Puede gestionar su agente</b> (editar prompt, IA, seguimientos, probar). Si lo <b>desmarcas</b>, el usuario <b>solo verá los mensajes</b> (conversaciones y etiquetas), sin tocar la configuración.</span>
                  </label>
                )}
                <div className="flex gap-2">
                  <Button type="submit">Crear</Button>
                  <Button variant="ghost" type="button" onClick={() => setForm(null)}>Cancelar</Button>
                </div>
              </form>
            </Card>
          )}
        </div>

        {isAdmin && (
          <div className="space-y-4">
            <Card className="overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-3.5"><h3 className="text-sm font-bold text-slate-800">Usuarios del panel</h3></div>
              <div className="divide-y divide-slate-50">
                {(data?.panel || []).map((u) => (
                  <div key={u.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        {u.username}
                        {u.role === 'admin' && <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-600"><ShieldCheck size={11} /> ADMIN</span>}
                      </div>
                      <div className="text-xs text-slate-400">{u.account_name ? `Cuenta: ${u.account_name}` : u.role === 'admin' ? 'Acceso total' : 'Sin cuenta asignada'}</div>
                    </div>
                    {u.role === 'user' && (
                      <button
                        onClick={() => updateUser(u, { can_manage_agents: u.can_manage_agents === false })}
                        title="Alternar entre gestionar el agente o solo ver mensajes"
                        className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${u.can_manage_agents === false ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}
                      >
                        {u.can_manage_agents === false ? '💬 Solo mensajes' : '🤖 Gestiona agente'}
                      </button>
                    )}
                    {u.role === 'user' && (
                      <select
                        value={u.account_id || ''}
                        onChange={(e) => updateUser(u, { account_id: e.target.value ? Number(e.target.value) : null })}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                      >
                        <option value="">Todas</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    )}
                    <button title="Restablecer contraseña" onClick={() => resetPassword(u)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><KeyRound size={15} /></button>
                    <button
                      title="Eliminar"
                      onClick={async () => { if (window.confirm(`¿Eliminar a ${u.username}?`)) { await api.del(`/api/users/${u.id}`).catch((e) => window.alert(e.message)); load(); } }}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-sm font-bold text-slate-800">Accesos desde GHL (portal)</h3>
                <p className="mt-0.5 text-xs text-slate-400">Entran con el enlace del menú de GHL; su vista es la de su subcuenta.</p>
              </div>
              {(data?.portal || []).length === 0 ? (
                <p className="px-5 py-6 text-center text-xs text-slate-400">Nadie ha entrado aún por el enlace del portal.</p>
              ) : (
                <div className="divide-y divide-slate-50">
                  {(data?.portal || []).map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800">{p.name || p.email}</div>
                        <div className="truncate text-xs text-slate-400">{p.email} · {p.account_name} · visto {timeAgo(p.last_seen_at)}</div>
                      </div>
                      <button
                        onClick={async () => { if (window.confirm(`¿Quitar el acceso de ${p.email}?`)) { await api.del(`/api/users/portal/${p.id}`); load(); } }}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <TourProgressCard />
          </div>
        )}
      </div>
    </div>
  );
}

// 🧭 Quién ha hecho el tutorial guiado y hasta dónde llegó (el progreso lo reporta el propio tour).
function TourProgressCard() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.get('/api/tour/progress').then((r) => setRows(r.progreso || [])).catch(() => setRows([]));
  }, []);
  return (
    <Card className="overflow-hidden" data-tour="users-tour">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <h3 className="text-sm font-bold text-slate-800">🧭 Progreso del tutorial</h3>
        <p className="mt-0.5 text-xs text-slate-400">Qué usuarios han hecho el recorrido guiado y hasta dónde llegaron.</p>
      </div>
      {rows === null && <p className="px-5 py-6 text-center text-xs text-slate-400">Cargando…</p>}
      {rows?.length === 0 && <p className="px-5 py-6 text-center text-xs text-slate-400">Nadie ha empezado el tutorial todavía.</p>}
      {rows?.length > 0 && (
        <div className="divide-y divide-slate-50">
          {rows.map((r) => (
            <div key={r.user_key} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <span className="truncate">{r.label || r.user_key}</span>
                  {r.role === 'admin' && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-600">ADMIN</span>}
                </div>
                <div className="truncate text-xs text-slate-400">
                  {r.account_name ? `${r.account_name} · ` : ''}última vez {timeAgo(r.updated_at)}
                </div>
              </div>
              <div className="w-32">
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${r.pct >= 100 ? 'bg-emerald-500' : 'bg-violet-500'}`}
                    style={{ width: `${Math.max(3, r.pct)}%` }}
                  />
                </div>
              </div>
              <span className={`w-12 text-right text-xs font-bold ${r.pct >= 100 ? 'text-emerald-600' : 'text-slate-600'}`}>
                {r.pct >= 100 ? '✅ 100%' : `${r.pct}%`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
