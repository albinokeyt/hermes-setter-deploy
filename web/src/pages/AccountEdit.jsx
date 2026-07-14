import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Sparkles, ChevronRight, Bot } from 'lucide-react';
import { api } from '../api.js';
import { CHANNELS, CHANNEL_LABEL } from '../stages.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Select, Toggle, Banner, CopyField } from '../components/ui.jsx';
import { AccessManager } from '../components/AccessManager.jsx';

const TABS = [
  { key: 'setters', label: '🤖 Setters' },
  { key: 'ajustes', label: 'Ajustes', adminOnly: true },
  { key: 'accesos', label: 'Accesos' },
  { key: 'conexion', label: 'Conexión GHL', adminOnly: true },
];

export default function AccountEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const tabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('conectada') !== null ? 'conexion' : 'setters');
  const [acc, setAcc] = useState(null);
  const [setters, setSetters] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [calendars, setCalendars] = useState(null);
  const [newSetter, setNewSetter] = useState('');

  const loadSetters = () => api.get(`/api/accounts/${id}/setters`).then(setSetters).catch(() => setSetters([]));
  useEffect(() => { api.get(`/api/accounts/${id}`).then(setAcc).catch((e) => setError(e.message)); loadSetters(); }, [id]);

  useEffect(() => {
    if (tab === 'conexion' && isAdmin && calendars === null) {
      api.get(`/api/accounts/${id}/calendars`).then(setCalendars).catch(() => setCalendars({ calendars: [], source: 'error' }));
    }
  }, [tab, isAdmin, id, calendars]);

  if (!acc) return <div className="py-24 text-center text-sm text-slate-400">{error || 'Cargando…'}</div>;

  const set = (patch) => setAcc({ ...acc, ...patch });

  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = { ...acc };
      delete body.webhook_url; delete body.webhook_token; delete body.oauth_connected; delete body.provider_name;
      const updated = await api.put(`/api/accounts/${id}`, body);
      setAcc({ ...acc, ...updated });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const connectOauth = async () => {
    try { const { url } = await api.get(`/api/oauth/url?account_id=${id}`); window.location.href = url; }
    catch (err) { setError(err.message); }
  };

  const createSetter = async () => {
    const nm = newSetter.trim() || 'Nuevo setter';
    const st = await api.post(`/api/accounts/${id}/setters`, { name: nm });
    navigate(`/setters/${st.id}`);
  };

  const activeHours = acc.active_hours || { always: true, start: '09:00', end: '21:00' };

  return (
    <div>
      {isAdmin && (
        <Link to="/cuentas" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> Conexiones
        </Link>
      )}
      <SectionTitle
        title={isAdmin ? acc.name : `Mi panel · ${acc.name}`}
        subtitle={acc.location_id ? `Subcuenta GHL: ${acc.location_id}` : 'Todavía sin subcuenta de GHL conectada'}
        actions={
          <div className="flex items-center gap-3">
            {isAdmin && <Toggle checked={acc.bot_enabled} onChange={(v) => set({ bot_enabled: v })} label={acc.bot_enabled ? 'Conexión activa' : 'Conexión apagada'} />}
            <Button onClick={save} loading={saving}>{saved ? '✓ Guardado' : 'Guardar'}</Button>
          </div>
        }
      />

      {error && <div className="mb-4"><Banner tone="error">{error}</Banner></div>}
      {searchParams.get('error') && <div className="mb-4"><Banner tone="error">{searchParams.get('error')}</Banner></div>}
      {searchParams.get('conectada') !== null && searchParams.get('conectada') && <div className="mb-4"><Banner tone="ok">Subcuenta conectada por OAuth correctamente 🎉</Banner></div>}
      {acc.test_mode && <div className="mb-4"><Banner tone="warn">🧪 <b>Modo test activo</b>: los setters solo responden a contactos con la etiqueta <b>{acc.test_tag || 'hermes-test'}</b>.</Banner></div>}

      <div className="mb-5 flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 w-fit">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === t.key ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'setters' && (
        <div className="max-w-2xl space-y-3">
          <Banner tone="info">Los setters de esta conexión se reparten los leads por etiqueta (función avanzada dentro de cada setter). El «principal» atiende a quien no case con ninguno específico.</Banner>
          {!setters ? (
            <div className="py-6 text-center text-sm text-slate-400">Cargando…</div>
          ) : (
            setters.map((st) => (
              <Link key={st.id} to={`/setters/${st.id}`} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-violet-300">
                <span className={`h-2 w-2 rounded-full ${st.bot_enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <span className="flex-1">
                  <span className="text-sm font-semibold text-slate-800">{st.name}{st.is_default && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">principal</span>}</span>
                  <span className="ml-2 text-xs text-slate-400">{st.provider_name || 'sin IA'}{(st.required_tags || []).length ? ` · 🏷️ ${st.required_tags.join(', ')}` : ''}</span>
                </span>
                <span className="text-xs text-slate-400">{st.conversations_count} conv.</span>
                <ChevronRight size={15} className="text-slate-300" />
              </Link>
            ))
          )}
          {isAdmin && (
            <div className="flex items-end gap-2 pt-1">
              <div className="flex-1"><Input label="Nuevo setter" value={newSetter} onChange={(e) => setNewSetter(e.target.value)} placeholder="Ej. Ventas high-ticket" /></div>
              <Button onClick={createSetter}><Bot size={16} /> Crear setter</Button>
            </div>
          )}
        </div>
      )}

      {tab === 'ajustes' && (
        <Card className="max-w-2xl space-y-6 p-6">
          <Input label="Nombre de la conexión" value={acc.name} onChange={(e) => set({ name: e.target.value })} />
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-700">Canales activos</span>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((ch) => {
                const active = (acc.channels || []).includes(ch);
                return (
                  <button key={ch} type="button" onClick={() => set({ channels: active ? acc.channels.filter((c) => c !== ch) : [...(acc.channels || []), ch] })}
                    className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${active ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    {CHANNEL_LABEL[ch]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle checked={!(activeHours.always !== false)} onChange={(v) => set({ active_hours: { ...activeHours, always: !v } })} label="Limitar horario de respuesta" description="Fuera del horario, el bot espera a la próxima apertura" />
            {activeHours.always === false && (
              <div className="grid grid-cols-3 gap-3">
                <Input label="Desde" type="time" value={activeHours.start || '09:00'} onChange={(e) => set({ active_hours: { ...activeHours, start: e.target.value } })} />
                <Input label="Hasta" type="time" value={activeHours.end || '21:00'} onChange={(e) => set({ active_hours: { ...activeHours, end: e.target.value } })} />
                <Input label="Zona horaria" value={acc.timezone} onChange={(e) => set({ timezone: e.target.value })} hint="Ej.: Europe/Madrid" />
              </div>
            )}
          </div>
          <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <Toggle checked={acc.test_mode} onChange={(v) => set({ test_mode: v })} label="🧪 Modo test" description="Los setters SOLO responden a contactos con la etiqueta de prueba" />
            {acc.test_mode && (
              <Input label="Etiqueta de prueba (tag de GHL)" value={acc.test_tag || ''} onChange={(e) => set({ test_tag: e.target.value })} placeholder="hermes-test" hint="Añade este tag a tu contacto en GHL y chatéale: solo los contactos con el tag reciben respuesta." />
            )}
          </div>
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle checked={acc.auto_handoff} onChange={(v) => set({ auto_handoff: v })} label="Pausar bot si un humano interviene" description="Si alguien responde manual desde GHL, el bot se aparta en ese chat" />
            {acc.auto_handoff && (
              <div className="pl-1">
                <Input label="Reactivar el bot tras (minutos sin mensaje humano)" type="number" min="0" max="10080" step="5" value={acc.auto_handoff_minutes ?? 0} onChange={(e) => set({ auto_handoff_minutes: Number(e.target.value) })} className="!w-48" hint="0 = queda pausado hasta reactivarlo a mano." />
              </div>
            )}
            <Toggle checked={acc.sync_tags} onChange={(v) => set({ sync_tags: v })} label="Sincronizar etiquetas con GHL" description='Añade tags "setter-calificado", etc. al contacto en GHL' />
          </div>
        </Card>
      )}

      {tab === 'accesos' && <AccessManager accountId={id} />}

      {tab === 'conexion' && (
        <div className="max-w-2xl space-y-4">
          <Card className="space-y-4 p-6">
            <Select label="Modo de conexión" value={acc.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="oauth">App de Marketplace (OAuth) — recomendado</option>
              <option value="pit">Token privado (PIT) + Workflow — sin app</option>
            </Select>

            <div className="border-t border-slate-100 pt-4">
              <span className="mb-2 block text-sm font-medium text-slate-700">📅 Calendarios que cuentan como "agenda"</span>
              {(() => {
                const selected = Array.isArray(acc.calendar_ids) ? acc.calendar_ids : [];
                const list = calendars?.calendars || [];
                const toggleCal = (cid) => set({ calendar_ids: selected.includes(cid) ? selected.filter((x) => x !== cid) : [...selected, cid] });
                return (
                  <div className="flex flex-wrap gap-2">
                    {list.length === 0 && <span className="text-xs text-slate-400">No hay calendarios que mostrar todavía.</span>}
                    {list.map((c) => {
                      const on = selected.includes(c.id);
                      return (
                        <button key={c.id} type="button" onClick={() => toggleCal(c.id)}
                          className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${on ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                          {on ? '✓ ' : ''}{c.name}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              <p className="mt-1.5 text-xs text-slate-400">Cuando alguien reserve (o cancele) en cualquiera de estos calendarios, el lead pasa a <b>Agendado</b> / <b>Agenda cancelada</b>. Si no marcas ninguno, cuenta cualquier cita de la subcuenta.</p>
            </div>

            {acc.mode === 'oauth' ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-500">Instala la app en la subcuenta del cliente (Configuración → Enlace de instalación) y todo queda conectado: recepción y envío.</p>
                {acc.oauth_connected ? (
                  <Banner tone="ok">✓ Subcuenta <b>{acc.location_id}</b> conectada por OAuth.</Banner>
                ) : (
                  <Button onClick={connectOauth}><Sparkles size={16} /> Conectar subcuenta de GHL</Button>
                )}
                <CopyField label="Enlace del portal para el cliente (Custom Menu Link de GHL)" value={acc.portal_url || ''} hint="Único por conexión. El cliente entra a su panel sin contraseña." />
                <CopyField label="Plan B — webhook por workflow (recepción alternativa)" value={acc.webhook_url || ''} hint='Workflow en la subcuenta: Trigger "Customer Replied" → Custom Webhook (POST) a esta URL. Desactívalo si el webhook de la app ya entrega mensajes.' />
              </div>
            ) : (
              <div className="space-y-4">
                <Input label="Location ID de la subcuenta" value={acc.location_id || ''} onChange={(e) => set({ location_id: e.target.value.trim() })} hint="En GHL: Settings → Business Profile de la subcuenta" />
                <Input label="Private Integration Token (PIT)" type="password" value={acc.pit_token || ''} onChange={(e) => set({ pit_token: e.target.value.trim() })} hint="Subcuenta: Settings → Private Integrations (scopes conversations, contacts, locations)" />
                <CopyField label="URL de webhook para el workflow de GHL" value={acc.webhook_url || ''} hint='Workflow: Trigger "Customer Replied" → Custom Webhook (POST) a esta URL.' />
              </div>
            )}
          </Card>

          <Card className="p-6">
            <h3 className="mb-2 text-sm font-bold text-red-600">Zona de peligro</h3>
            <p className="mb-4 text-xs text-slate-500">Elimina la conexión con TODOS sus setters, conversaciones y mensajes. No se puede deshacer.</p>
            <Button variant="danger" onClick={async () => {
              if (window.confirm(`¿Eliminar la conexión "${acc.name}" y todo lo suyo?`)) { await api.del(`/api/accounts/${id}`); navigate('/cuentas'); }
            }}>
              <Trash2 size={15} /> Eliminar conexión
            </Button>
          </Card>
        </div>
      )}
    </div>
  );
}
