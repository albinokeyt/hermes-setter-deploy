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
  { key: 'ajustes', label: 'Ajustes' },
  { key: 'ctas', label: '🎯 CTAs' },
  { key: 'accesos', label: 'Accesos' },
  { key: 'conexion', label: 'Conexión GHL' },
];

const fmtWait = (s) => {
  const n = Number(s) || 0;
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60), r = n % 60;
  return `${m} min${r ? ` ${r} s` : ''}`;
};

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
  const [commentLog, setCommentLog] = useState(null);
  const loadCommentLog = () => api.get(`/api/accounts/${id}/comment-log`).then(setCommentLog).catch(() => setCommentLog([]));

  const loadSetters = () => api.get(`/api/accounts/${id}/setters`).then(setSetters).catch(() => setSetters([]));
  useEffect(() => {
    api.get(`/api/accounts/${id}`).then(setAcc).catch((e) => setError(e.message));
    loadSetters();
  }, [id]);

  useEffect(() => {
    if (tab === 'conexion' && calendars === null) {
      api.get(`/api/accounts/${id}/calendars`).then(setCalendars).catch(() => setCalendars({ calendars: [], source: 'error' }));
    }
  }, [tab, id, calendars]);

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
            <Toggle checked={acc.bot_enabled} onChange={(v) => set({ bot_enabled: v })} label={acc.bot_enabled ? 'Conexión activa' : 'Conexión apagada'} />
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
                <span className="text-right text-xs text-slate-400">
                  <span className="font-semibold text-slate-600">{st.leads}</span> leads · <span className="font-semibold text-emerald-600">{st.agendados}</span> agendas ({st.tasa_agenda}%)
                  {st.gasto > 0 && <span> · ${st.gasto.toFixed(2)}</span>}
                </span>
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
          <div className="border-t border-slate-100 pt-5">
            <Input
              label="🚫 Etiqueta para excluir de las IAs"
              value={acc.exclude_tag || ''}
              onChange={(e) => set({ exclude_tag: e.target.value.trim() })}
              placeholder="sin-ia"
              hint="Lo contrario de «responder solo a»: si un contacto de GHL tiene esta etiqueta, NINGÚN setter de esta conexión le responde. Vacío = sin exclusión (al sacar a alguien desde un chat se usa «sin-ia» por defecto)."
            />
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
          <p className="border-t border-slate-100 pt-4 text-xs text-slate-400">La lectura de imágenes y la transcripción de audios se configuran <b>por setter</b> (pestaña IA de cada setter), porque cada agente puede usar su propio modelo.</p>

          <div className="space-y-2 border-t border-slate-100 pt-5">
            <span className="block text-sm font-bold text-slate-800">💬 Comentarios de Instagram</span>
            <p className="-mt-1 text-xs text-slate-400">
              Para recibir los comentarios de tus publicaciones: en esta subcuenta de GHL crea una automatización que, cuando alguien comente, mande un <b>Custom Webhook (POST)</b> a esta URL con <code>customData</code>: <code>comment</code>, <code>author</code> y <code>post</code>. Aparecerán en <b>Archivo → 💬 Comentarios entrantes</b>.
            </p>
            <CopyField label="Tu webhook de comentarios (cópialo en la automatización de GHL)" value={acc.comment_webhook_url || ''} />
            <p className="text-xs text-slate-400">Con el nodo <b>Webhook</b> de GHL (no el «Custom Webhook» de pago): pon los datos del comentario en los <b>headers</b> — <code>x-comment</code> (el texto), <code>x-author</code> (quién comentó), <code>x-post</code> (opcional). También valen en el body/JSON.</p>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">🧪 Probar: últimos webhooks recibidos</span>
                <Button variant="secondary" className="!py-1 text-xs" onClick={loadCommentLog}>Actualizar</Button>
              </div>
              {commentLog === null ? (
                <p className="text-xs text-slate-400">Pulsa «Actualizar» tras enviar un comentario de prueba desde GHL.</p>
              ) : commentLog.length === 0 ? (
                <p className="text-xs text-slate-400">Aún no ha llegado ningún comentario a este webhook.</p>
              ) : (
                <div className="scroll-thin max-h-52 space-y-1.5 overflow-y-auto">
                  {commentLog.map((l) => (
                    <details key={l.id} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                      <summary className="cursor-pointer text-[11px]">
                        <span className={`font-bold ${l.kind === 'comentario_recibido' ? 'text-emerald-600' : 'text-amber-600'}`}>{l.kind === 'comentario_recibido' ? '✓ recibido' : '⚠ incompleto'}</span>
                        {l.payload?.texto && <span className="ml-2 text-slate-500">{l.payload.texto}</span>}
                      </summary>
                      <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[10px] leading-relaxed text-slate-600">{JSON.stringify(l.payload, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {tab === 'ctas' && (() => {
        const ctas = Array.isArray(acc.ctas) ? acc.ctas : [];
        const setCta = (i, patch) => set({ ctas: ctas.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div className="max-w-2xl space-y-4">
            <Banner tone="info">
              Para anuncios/citas de Instagram: si el <b>primer mensaje</b> del lead <b>contiene</b> una palabra o frase (pueden llevar emojis), el setter <b>espera</b> el tiempo que definas antes de entrar a responder — para no contestar de golpe. Deja la palabra <b>vacía</b> para aplicar la espera a <b>cualquier</b> conversación nueva.
            </Banner>
            <Card className="space-y-3 p-6">
              {ctas.length === 0 && <p className="text-xs text-slate-400">Sin CTAs. El setter responde con su debounce normal.</p>}
              {ctas.map((c, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input label={i === 0 ? 'Palabra o frase clave (vacío = cualquiera)' : ''} value={c.keyword || ''} onChange={(e) => setCta(i, { keyword: e.target.value })} placeholder="ej. quiero info 🔥" />
                  </div>
                  <div className="w-40">
                    <Input label={i === 0 ? 'Espera (segundos)' : ''} type="number" min="0" max="3600" step="5" value={c.wait_seconds ?? 0} onChange={(e) => setCta(i, { wait_seconds: Number(e.target.value) })} hint={`= ${fmtWait(c.wait_seconds)}`} />
                  </div>
                  <button type="button" onClick={() => set({ ctas: ctas.filter((_, j) => j !== i) })} className="mb-2 text-slate-400 hover:text-red-500"><Trash2 size={16} /></button>
                </div>
              ))}
              <Button variant="secondary" onClick={() => set({ ctas: [...ctas, { keyword: '', wait_seconds: 60 }] })}><Plus size={16} /> Añadir CTA</Button>
            </Card>
          </div>
        );
      })()}

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
                ) : isAdmin ? (
                  <Button onClick={connectOauth}><Sparkles size={16} /> Conectar subcuenta de GHL</Button>
                ) : (
                  <Banner tone="warn">Esta conexión aún no está conectada a GHL. Contacta con la agencia.</Banner>
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

          {isAdmin && (
            <Card className="p-6">
              <h3 className="mb-2 text-sm font-bold text-red-600">Zona de peligro</h3>
              <p className="mb-4 text-xs text-slate-500">Elimina la conexión con TODOS sus setters, conversaciones y mensajes. No se puede deshacer.</p>
              <Button variant="danger" onClick={async () => {
                if (window.confirm(`¿Eliminar la conexión "${acc.name}" y todo lo suyo?`)) { await api.del(`/api/accounts/${id}`); navigate('/cuentas'); }
              }}>
                <Trash2 size={15} /> Eliminar conexión
              </Button>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
