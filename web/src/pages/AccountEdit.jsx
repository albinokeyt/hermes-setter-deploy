import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Sparkles, ChevronRight, Bot } from 'lucide-react';
import { api } from '../api.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Select, Toggle, Banner, CopyField } from '../components/ui.jsx';
import { AccessManager } from '../components/AccessManager.jsx';

const TABS = [
  { key: 'setters', label: '🤖 Setters' },
  { key: 'ajustes', label: 'Ajustes' },
  { key: 'ctas', label: '🎯 CTAs' },
  { key: 'accesos', label: 'Accesos' },
  { key: 'conexion', label: 'Conexión GHL', adminOnly: true },
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
  const [tab, setTab] = useState(searchParams.get('conectada') !== null && isAdmin ? 'conexion' : 'setters');
  const [acc, setAcc] = useState(null);
  const [setters, setSetters] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [calendars, setCalendars] = useState(null);
  const [newSetter, setNewSetter] = useState('');
  const [commentLog, setCommentLog] = useState(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [recuperando, setRecuperando] = useState(false);
  const [recupResultado, setRecupResultado] = useState(null); // resultado de «Recuperar nombres»
  const loadCommentLog = () => api.get(`/api/accounts/${id}/comment-log`).then(setCommentLog).catch(() => setCommentLog({ received: [], issues: [] }));

  const loadSetters = () => api.get(`/api/accounts/${id}/setters`).then(setSetters).catch(() => setSetters([]));
  useEffect(() => {
    api.get(`/api/accounts/${id}`).then((a) => { setAcc(a); setAliasDraft(a.alias || ''); }).catch((e) => setError(e.message));
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

  // Alias (nombre visible), con doble confirmación antes de aplicarlo.
  const saveAlias = async () => {
    const v = aliasDraft.trim();
    const label = v || acc.name;
    if (!window.confirm(`¿Poner «${label}» como nombre visible de esta conexión?`)) return;
    if (!window.confirm(`Confírmalo de nuevo: se mostrará «${label}» en tu panel.`)) return;
    setError('');
    try {
      const updated = await api.put(`/api/accounts/${id}/alias`, { alias: v });
      setAcc({ ...acc, ...updated });
      setAliasDraft(updated.alias || '');
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err.message); }
  };

  // 🪪 rellena los «Lead sin nombre» de esta conexión desde la API de GHL (repara rachas de token muerto)
  const recuperarNombres = async () => {
    setRecuperando(true); setRecupResultado(null);
    try {
      const r = await api.post(`/api/accounts/${id}/recuperar-nombres`, {});
      const partes = [`✓ ${r.actualizados} nombre${r.actualizados === 1 ? '' : 's'} recuperado${r.actualizados === 1 ? '' : 's'} de ${r.total} conversaciones sin nombre`];
      if (r.sin_nombre_en_ghl) partes.push(`${r.sin_nombre_en_ghl} tampoco tienen nombre en GHL`);
      if (r.fallos) partes.push(`${r.fallos} fallos`);
      setRecupResultado({ tone: 'ok', text: partes.join(' · ') });
    } catch (err) {
      const d = err.data || {};
      const extra = d.actualizados != null ? ` (antes del corte: ${d.actualizados} recuperados${d.pendientes ? `, ${d.pendientes} pendientes` : ''})` : '';
      setRecupResultado({ tone: 'error', text: err.message + extra });
    } finally { setRecuperando(false); }
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
        title={isAdmin ? (acc.alias || acc.name) : `Mi panel · ${acc.alias || acc.name}`}
        subtitle={acc.location_id ? `Subcuenta GHL: ${acc.location_id}` : 'Todavía sin subcuenta de GHL conectada'}
        actions={
          <div data-tour="conexion-estado" className="flex items-center gap-3">
            <Toggle checked={acc.bot_enabled} onChange={(v) => set({ bot_enabled: v })} label={acc.bot_enabled ? 'Conexión activa' : 'Conexión apagada'} />
            <Button onClick={save} loading={saving}>{saved ? '✓ Guardado' : 'Guardar'}</Button>
          </div>
        }
      />

      {error && <div className="mb-4"><Banner tone="error">{error}</Banner></div>}
      {searchParams.get('error') && <div className="mb-4"><Banner tone="error">{searchParams.get('error')}</Banner></div>}
      {searchParams.get('conectada') !== null && searchParams.get('conectada') && <div className="mb-4"><Banner tone="ok">Subcuenta conectada por OAuth correctamente 🎉</Banner></div>}
      {acc.test_mode && <div className="mb-4"><Banner tone="warn">🧪 <b>Modo test activo</b>: los setters solo responden a contactos con la etiqueta <b>{acc.test_tag || 'hermes-test'}</b>.</Banner></div>}

      <div data-tour="conexion-tabs" className="mb-5 flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 w-fit">
        {tabs.map((t) => (
          <button key={t.key} data-tour={`conexion-tab-${t.key}`} onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === t.key ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'setters' && (
        <div data-tour="conexion-setters" className="max-w-2xl space-y-3">
          <Banner tone="info">Los setters de esta conexión se reparten los leads por etiqueta (función avanzada dentro de cada setter). El «principal» atiende a quien no case con ninguno específico.</Banner>
          {!setters ? (
            <div className="py-6 text-center text-sm text-slate-400">Cargando…</div>
          ) : (
            setters.map((st) => (
              <Link key={st.id} to={`/setters/${st.id}`} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-violet-300">
                <span className={`h-2 w-2 rounded-full ${st.bot_enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <span className="flex-1">
                  <span className="text-sm font-semibold text-slate-800">{st.name}{st.is_default && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">principal</span>}{st.test_mode && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-600" title="Este setter está en modo test: solo responde a contactos con la etiqueta de prueba">🧪 test</span>}</span>
                  <span className="ml-2 text-xs text-slate-400">{st.provider_name || 'sin IA'}{(st.required_tags || []).length ? ` · 🏷️ ${st.required_tags.join(', ')}` : ''}</span>
                </span>
                <span className="text-right text-xs text-slate-400">
                  <span className="font-semibold text-slate-600">{st.leads}</span> leads · <span className="font-semibold text-emerald-600">{st.agendados}</span> agendas ({st.tasa_agenda}%)
                  {(isAdmin ? st.gasto : st.facturado) > 0 && <span> · ${(isAdmin ? st.gasto : st.facturado).toFixed(2)}</span>}
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
        <Card data-tour="conexion-ajustes" className="max-w-2xl space-y-6 p-6">
          {isAdmin && (
            <Input label="Nombre de la conexión (técnico)" value={acc.name} onChange={(e) => set({ name: e.target.value })} hint="Nombre base. Si pones un alias abajo, se muestra el alias en todo el panel." />
          )}
          <div className="space-y-2">
            <span className="block text-sm font-medium text-slate-700">🏷️ Nombre visible (alias)</span>
            <p className="-mt-1 text-xs text-slate-400">Es el nombre que se ve en tu panel. Ponle uno que reconozcas (por ejemplo el nombre real de la subcuenta). Déjalo vacío para usar el nombre técnico.</p>
            <div className="flex items-end gap-2">
              <div className="flex-1"><Input value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)} placeholder={acc.name} /></div>
              <Button variant="secondary" onClick={saveAlias} disabled={aliasDraft.trim() === (acc.alias || '')}>Guardar alias</Button>
            </div>
          </div>
          <p className="text-xs text-slate-400">📡 <b>Canales de atención</b>: se eligen <b>por setter</b> (cada setter marca los suyos en su pestaña <b>Comportamiento</b>). Los mensajes de todos los canales se archivan igual; el canal solo decide qué setter responde dónde.</p>
          <div data-tour="conexion-horario" className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle checked={!(activeHours.always !== false)} onChange={(v) => set({ active_hours: { ...activeHours, always: !v } })} label="Limitar horario de respuesta" description="Fuera del horario, el bot espera a la próxima apertura" />
            {activeHours.always === false && (
              <div className="grid grid-cols-3 gap-3">
                <Input label="Desde" type="time" value={activeHours.start || '09:00'} onChange={(e) => set({ active_hours: { ...activeHours, start: e.target.value } })} />
                <Input label="Hasta" type="time" value={activeHours.end || '21:00'} onChange={(e) => set({ active_hours: { ...activeHours, end: e.target.value } })} />
                <Input label="Zona horaria" value={acc.timezone} onChange={(e) => set({ timezone: e.target.value })} hint="Ej.: Europe/Madrid" />
              </div>
            )}
          </div>
          <div data-tour="conexion-insercion" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <span className="block text-sm font-bold text-slate-800">⏳ Tiempo de inserción (toda la conexión)</span>
            <p className="-mt-1 text-xs text-slate-500">Cuando un lead <b>entra por primera vez</b>, los setters de esta conexión esperan estos segundos <b>antes de procesar</b> su primer mensaje. Así, si una automatización de GHL le pone una etiqueta (p. ej. para que el bot NO responda), da tiempo a que se asigne antes de que el setter valide las reglas. La <b>activación por etiqueta</b> se salta esta espera. Cada setter puede fijar el suyo propio (si es mayor, manda).</p>
            <div className="flex flex-wrap gap-4">
              <Input label="Segundos de espera" type="number" min="0" max="3600" step="5" value={acc.insertion_wait_seconds ?? 0} onChange={(e) => set({ insertion_wait_seconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })} className="!w-44" hint="0 = procesa de inmediato." />
              <Input label="Reaplicar tras inactividad (horas)" type="number" min="0" max="720" step="1" value={acc.insertion_idle_hours ?? 0} onChange={(e) => set({ insertion_idle_hours: Math.min(720, Math.max(0, Number(e.target.value) || 0)) })} className="!w-56" hint="Si el lead vuelve tras estas horas, se aplica otra vez. 0 = solo la 1ª vez." />
            </div>
          </div>
          <div data-tour="conexion-test" className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <Toggle checked={acc.test_mode} onChange={(v) => set({ test_mode: v })} label="🧪 Modo test" description="Los setters SOLO responden a contactos con la etiqueta de prueba" />
            {acc.test_mode && (
              <Input label="Etiqueta de prueba (tag de GHL)" value={acc.test_tag || ''} onChange={(e) => set({ test_tag: e.target.value })} placeholder="hermes-test" hint="Añade este tag a tu contacto en GHL y chatéale: solo los contactos con el tag reciben respuesta." />
            )}
          </div>
          <div data-tour="conexion-exclusion" className="border-t border-slate-100 pt-5">
            <Input
              label="🚫 Etiqueta para excluir de las IAs"
              value={acc.exclude_tag || ''}
              onChange={(e) => set({ exclude_tag: e.target.value.trim() })}
              placeholder="sin-ia"
              hint="Lo contrario de «responder solo a»: si un contacto de GHL tiene esta etiqueta, NINGÚN setter de esta conexión le responde. Vacío = sin exclusión (al sacar a alguien desde un chat se usa «sin-ia» por defecto)."
            />
          </div>
          <div data-tour="conexion-pausa-humano" className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle checked={acc.auto_handoff} onChange={(v) => set({ auto_handoff: v })} label="Pausar bot si un humano interviene" description="Si alguien responde manual desde GHL, el bot se aparta en ese chat" />
            {acc.auto_handoff && (
              <div className="pl-1">
                <Input label="Reactivar el bot tras (minutos sin mensaje humano)" type="number" min="0" max="10080" step="5" value={acc.auto_handoff_minutes ?? 0} onChange={(e) => set({ auto_handoff_minutes: Number(e.target.value) })} className="!w-48" hint="0 = queda pausado hasta reactivarlo a mano." />
              </div>
            )}
            <Toggle checked={acc.sync_tags} onChange={(v) => set({ sync_tags: v })} label="Sincronizar etiquetas con GHL" description='Añade tags "setter-calificado", etc. al contacto en GHL' />
          </div>
          <p className="border-t border-slate-100 pt-4 text-xs text-slate-400">La lectura de imágenes y la transcripción de audios se configuran <b>por setter</b> (pestaña IA de cada setter), porque cada agente puede usar su propio modelo.</p>

          <div data-tour="conexion-comentarios" className="space-y-2 border-t border-slate-100 pt-5">
            <span className="block text-sm font-bold text-slate-800">💬 Comentarios de Instagram</span>
            <p className="-mt-1 text-xs text-slate-400">
              En esta subcuenta de GHL crea una automatización con el <b>trigger de comentario de Instagram</b> y un nodo <b>Webhook (POST)</b> a esta URL (no el «Custom Webhook» de pago). <b>No tienes que configurar campos</b>: GHL ya manda el comentario, el autor y el post, y el sistema detecta la subcuenta solo. Es la <b>misma URL para todas las conexiones</b>. Aparecen en <b>Archivo → 💬 Comentarios entrantes</b>.
            </p>
            <CopyField label="Tu webhook de comentarios (cópialo en la automatización de GHL)" value={acc.comment_webhook_url || ''} />
            <p className="text-[11px] text-slate-400">Opcional (avanzado): puedes forzar valores con <code>customData</code> o headers <code>x-comment</code>, <code>x-author</code>, <code>x-post</code>.</p>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">🧪 Probar: últimos comentarios recibidos</span>
                <Button variant="secondary" className="!py-1 text-xs" onClick={loadCommentLog}>Actualizar</Button>
              </div>
              {commentLog === null ? (
                <p className="text-xs text-slate-400">Pulsa «Actualizar» tras enviar un comentario de prueba desde GHL.</p>
              ) : (commentLog.received?.length || 0) + (commentLog.issues?.length || 0) === 0 ? (
                <p className="text-xs text-slate-400">Aún no ha llegado ningún comentario a este webhook.</p>
              ) : (
                <div className="scroll-thin max-h-52 space-y-1.5 overflow-y-auto">
                  {(commentLog.received || []).map((c) => (
                    <details key={`r${c.id}`} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                      <summary className="cursor-pointer text-[11px]">
                        <span className="font-bold text-emerald-600">✓ recibido</span>
                        <span className="ml-2 text-slate-500">{c.text}</span>
                        {c.author && <span className="ml-1 text-slate-400">· {c.author}</span>}
                      </summary>
                      <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[10px] leading-relaxed text-slate-600">{JSON.stringify(c.raw ?? { text: c.text, author: c.author, post_ref: c.post_ref, channel: c.channel }, null, 2)}</pre>
                    </details>
                  ))}
                  {(commentLog.issues || []).map((l) => (
                    <details key={`i${l.id}`} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                      <summary className="cursor-pointer text-[11px]">
                        <span className={`font-bold ${l.kind === 'comentario_duplicado' ? 'text-slate-400' : 'text-amber-600'}`}>{l.kind === 'comentario_duplicado' ? '↻ duplicado' : '⚠ sin texto'}</span>
                        {l.payload?.texto && <span className="ml-2 text-slate-500">{l.payload.texto}</span>}
                      </summary>
                      <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[10px] leading-relaxed text-slate-600">{JSON.stringify(l.payload, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-2 border-t border-slate-100 pt-5">
            <span className="block text-sm font-bold text-slate-800">🪪 Nombres de los leads</span>
            <p className="-mt-1 text-xs text-slate-400">Si una racha de desconexión con GHL dejó conversaciones como «Lead sin nombre», esto las repasa y rellena nombre y email desde GHL (hasta 500 por pasada; puedes repetirla). Los mensajes nuevos ya lo hacen solos.</p>
            <Button variant="secondary" loading={recuperando} onClick={recuperarNombres}>🪪 Recuperar nombres</Button>
            {recupResultado && <Banner tone={recupResultado.tone}>{recupResultado.text}</Banner>}
          </div>
        </Card>
      )}

      {tab === 'ctas' && (() => {
        const ctas = Array.isArray(acc.ctas) ? acc.ctas : [];
        const setCta = (i, patch) => set({ ctas: ctas.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div data-tour="conexion-ctas" className="max-w-2xl space-y-4">
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

      {tab === 'accesos' && <div data-tour="conexion-accesos"><AccessManager accountId={id} /></div>}

      {tab === 'conexion' && isAdmin && (
        <div data-tour="conexion-ghl" className="max-w-2xl space-y-4">
          <Card className="space-y-4 p-6">
            <Select label="Modo de conexión" value={acc.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="oauth">App de Marketplace (OAuth) — recomendado</option>
              <option value="pit">Token privado (PIT) + Workflow — sin app</option>
            </Select>

            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs text-slate-400">📅 <b>Calendarios «agenda»</b>: se eligen <b>por setter</b> (cada setter marca los suyos en su pestaña <b>Comportamiento</b>), para medir bien qué setter agenda. Un setter cuyo objetivo no sea agendar los deja vacíos. No hay ajuste de calendario a nivel de conexión.</p>
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
