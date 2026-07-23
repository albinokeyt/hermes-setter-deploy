import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { CHANNELS, CHANNEL_LABEL } from '../stages.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Textarea, Select, Toggle, Banner, CopyField } from '../components/ui.jsx';
import { PromptArchitect } from '../components/PromptArchitect.jsx';

const TABS = [
  { key: 'prompt', label: 'Prompt' },
  { key: 'ia', label: 'IA' },
  { key: 'comportamiento', label: 'Comportamiento' },
  { key: 'activaciones', label: '⚡ Activaciones' },
  { key: 'seguimientos', label: 'Seguimientos' },
  { key: 'arquitecto', label: '✨ Arquitecto' },
];

export default function SetterEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const tabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const [tab, setTab] = useState('prompt');
  const [s, setS] = useState(null);
  const [providers, setProviders] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [calendars, setCalendars] = useState(null);
  const [versions, setVersions] = useState(null); // null = modal cerrado
  const [restoring, setRestoring] = useState(false);
  const [creatingTag, setCreatingTag] = useState(null); // índice de la etiqueta que se está creando
  const [tagMsg, setTagMsg] = useState(null);
  const [tagLog, setTagLog] = useState(null); // null = aún no consultado
  const [linkModal, setLinkModal] = useState(null); // { i, nombre, url } — i = índice de la etiqueta

  const createTag = async (i, name) => {
    setCreatingTag(i); setTagMsg(null);
    try {
      const r = await api.post(`/api/setters/${id}/create-tag`, { name });
      setTagMsg({ ok: true, text: `✓ Etiqueta «${r.tag}» creada en GHL. Pulsa «Guardar» para que este setter la escuche.` });
    } catch (e) { setTagMsg({ ok: false, text: `✗ ${e.message}` }); }
    finally { setCreatingTag(null); }
  };

  // Solo enlaces http(s) VÁLIDOS (un "javascript:" sería ejecutar código al pulsar). Mismo criterio
  // que el servidor (new URL) para no aceptar en la UI algo que el backend descartaría al guardar.
  const linkOk = (u) => {
    try { const p = new URL(String(u || '').trim()).protocol; return p === 'http:' || p === 'https:'; }
    catch { return false; }
  };

  const loadTagLog = () => api.get(`/api/setters/${id}/tag-log`).then((r) => setTagLog(r.events || [])).catch(() => setTagLog([]));

  const openHistory = () => api.get(`/api/setters/${id}/prompt-versions`).then(setVersions).catch((e) => setError(e.message));
  const restoreVersion = async (v) => {
    if (!window.confirm(`¿Volver a la versión del ${new Date(v.created_at).toLocaleString('es-ES')}? Los 3 bloques del prompt se reemplazarán (lo actual queda guardado en el historial).`)) return;
    setRestoring(true);
    try {
      const updated = await api.post(`/api/setters/${id}/prompt-versions/${v.id}/restore`, {});
      // solo los 3 prompts: no pisar ediciones locales sin guardar de otros campos
      setS((cur) => ({ ...cur, prompt_identity: updated.prompt_identity, prompt_business: updated.prompt_business, prompt_flow: updated.prompt_flow }));
      setVersions(null);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); } finally { setRestoring(false); }
  };

  const load = () => api.get(`/api/setters/${id}`).then((r) => { setS(r); setShowTags((r.required_tags || []).length > 0 || (r.excluded_tags || []).length > 0); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // admin ve todas las APIs; un usuario solo las habilitadas para usuarios (sin claves).
    api.get(isAdmin ? '/api/providers' : '/api/user-providers').then(setProviders).catch(() => {});
  }, [id, isAdmin]);
  // Calendarios de la conexión del setter (para elegir cuáles cuentan como agenda).
  useEffect(() => {
    if (s?.account_id) api.get(`/api/accounts/${s.account_id}/calendars`).then(setCalendars).catch(() => setCalendars({ calendars: [] }));
  }, [s?.account_id]);

  if (!s) return <div className="py-24 text-center text-sm text-slate-400">{error || 'Cargando…'}</div>;

  const set = (patch) => setS({ ...s, ...patch });
  const providersFor = (kind) => providers.filter((p) => !Array.isArray(p.kinds) || p.kinds.includes(kind));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { ...s };
      delete body.provider_name; delete body.conversations_count; delete body.account_id; delete body.is_default; delete body.created_at;
      const updated = await api.put(`/api/setters/${id}`, body);
      setS({ ...s, ...updated });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const followups = Array.isArray(s.followups) ? s.followups : [];

  return (
    <div>
      <Link to={`/cuentas/${s.account_id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Volver a la conexión
      </Link>
      <SectionTitle
        title={<input value={s.name} onChange={(e) => set({ name: e.target.value })} className="rounded-lg border border-transparent bg-transparent text-2xl font-bold tracking-tight text-slate-900 hover:border-slate-200 focus:border-violet-300 focus:outline-none" />}
        subtitle="Prompt, IA, comportamiento y seguimientos de este setter"
        actions={
          <div className="flex items-center gap-3">
            <Toggle checked={s.bot_enabled} onChange={(v) => set({ bot_enabled: v })} label={s.bot_enabled ? 'Setter activo' : 'Setter apagado'} />
            <Button onClick={save} loading={saving}>{saved ? '✓ Guardado' : 'Guardar cambios'}</Button>
          </div>
        }
      />

      {error && <div className="mb-4"><Banner tone="error">{error}</Banner></div>}

      <div className="mb-5 flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 w-fit">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === t.key ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'prompt' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Banner tone="info">El prompt se divide en 3 partes. El agente las combina con la memoria del lead y las reglas de humanización automáticamente.</Banner>
            <Button variant="secondary" className="shrink-0" onClick={openHistory}>🕘 Historial</Button>
          </div>
          <Card className="p-5">
            <Textarea label="1 · Identidad y personalidad" rows={8} value={s.prompt_identity} onChange={(e) => set({ prompt_identity: e.target.value })} placeholder="Eres Sofía, setter del centro..." hint="Quién es el setter: nombre, tono, forma de escribir, qué haría y qué jamás diría." />
          </Card>
          <Card className="p-5">
            <Textarea label="2 · Negocio y oferta" rows={8} value={s.prompt_business} onChange={(e) => set({ prompt_business: e.target.value })} placeholder="El negocio es..." hint="Qué se vende, a quién, precios, beneficios, preguntas frecuentes, enlaces permitidos." />
          </Card>
          <Card className="p-5">
            <Textarea label="3 · Flujo y objetivo" rows={8} value={s.prompt_flow} onChange={(e) => set({ prompt_flow: e.target.value })} placeholder="1. Saluda... 2. Cualifica... 3. Si cumple el filtro, propone..." hint="El paso a paso y el OBJETIVO (agendar una cita, o enviar un enlace de venta / recurso gratis / agenda — la agenda no es obligatoria)." />
          </Card>
        </div>
      )}

      {tab === 'ia' && (
        <div className="max-w-2xl space-y-4">
          {providers.length === 0 && <Banner tone="warn">Aún no tienes APIs. Créalas en <b>APIs de IA</b>.</Banner>}
          <Card className="space-y-5 p-6">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">💬 API de texto (el chat del agente)</div>
            <div>
              <Select label="Modelo de IA (elige una API que ya creaste)" value={s.provider_id || ''} onChange={(e) => set({ provider_id: e.target.value ? Number(e.target.value) : null, model: '' })}>
                <option value="">— Elige una API de texto —</option>
                {providersFor('text').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <p className="mt-1.5 text-xs text-slate-400">Cada API ya trae su modelo (lo configuraste en <b>APIs de IA</b>). Para usar otro modelo, créalo como una API nueva ahí y elígela aquí.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label={`Temperatura: ${s.temperature}`} type="range" min="0" max="1.5" step="0.1" value={s.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} className="!p-0 accent-violet-600" hint="Más alta = más creativo" />
              <Select label="Máximo de mensajes por respuesta" value={s.max_msgs} onChange={(e) => set({ max_msgs: Number(e.target.value) })}>
                <option value={2}>2 mensajes</option>
                <option value={3}>3 mensajes</option>
                <option value={4}>4 mensajes</option>
              </Select>
            </div>
          </Card>
          <Card className="space-y-4 p-6">
            <Toggle checked={s.vision_enabled} onChange={(v) => set({ vision_enabled: v })} label="👁️ API de imagen (leer fotos)" description="Cuando el lead envía una imagen, este setter la lee y la usa en la conversación" />
            {s.vision_enabled && (
              <div className="pl-1">
                <Select label="API de imagen" value={s.vision_provider_id || ''} onChange={(e) => set({ vision_provider_id: e.target.value ? Number(e.target.value) : null, vision_model: '' })}>
                  <option value="">— Elige una API de imagen —</option>
                  {providersFor('image').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <p className="mt-1.5 text-xs text-slate-400">Usa el modelo que configuraste en esa API. Para otro modelo, créalo como una API de imagen nueva en <b>APIs de IA</b>.</p>
              </div>
            )}
          </Card>
          <Card className="space-y-4 p-6">
            <Toggle checked={s.audio_enabled} onChange={(v) => set({ audio_enabled: v })} label="🎤 API de audio (transcribir notas de voz)" description="Convierte las notas de voz del lead en texto para este setter" />
            {s.audio_enabled && (
              <div className="pl-1">
                <Select label="API de audio" value={s.audio_provider_id || ''} onChange={(e) => set({ audio_provider_id: e.target.value ? Number(e.target.value) : null, audio_model: '' })}>
                  <option value="">— Elige una API de audio —</option>
                  {providersFor('audio').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <p className="mt-1.5 text-xs text-slate-400">Usa el modelo que configuraste en esa API. Para otro modelo, créalo como una API de audio nueva en <b>APIs de IA</b>.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'comportamiento' && (
        <Card className="max-w-2xl space-y-6 p-6">
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-700">Canales que atiende este setter</span>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((ch) => {
                const cur = s.channels || [];
                const active = cur.includes(ch);
                const isLast = active && cur.length === 1;
                return (
                  <button key={ch} type="button" disabled={isLast}
                    onClick={() => set({ channels: active ? cur.filter((c) => c !== ch) : [...cur, ch] })}
                    title={isLast ? 'Debe atender al menos un canal' : ''}
                    className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${active ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'} ${isLast ? 'cursor-not-allowed opacity-70' : ''}`}>
                    {CHANNEL_LABEL[ch]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-slate-400">Este setter SOLO responde en los canales marcados (debe tener al menos uno; los mensajes de otros canales se archivan igual). Cada setter tiene los suyos. Para apagarlo del todo, usa el interruptor del setter.</p>
          </div>

          <Input label="Espera antes de responder (debounce, segundos)" type="number" min="5" max="3600" step="5" value={s.debounce_seconds} onChange={(e) => set({ debounce_seconds: Math.min(3600, Math.max(5, Number(e.target.value) || 5)) })} className="!w-48" hint="El bot espera este silencio tras el último mensaje del lead y responde a todo junto, como una persona. Puedes poner desde 5 s hasta 1 h (3600 s). El bot siempre lee la conversación completa antes de responder." />

          <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <span className="block text-sm font-bold text-slate-800">⏳ Tiempo de inserción</span>
            <p className="-mt-1 text-xs text-slate-500">Cuando un lead <b>entra por primera vez</b>, el setter espera estos segundos <b>antes de procesar</b> su primer mensaje. El mensaje entra al sistema pero aún no se responde: pasado ese tiempo se validan <b>todas las reglas</b> (etiquetas incluidas). Sirve para dar margen a que una automatización de GHL que pone una etiqueta (p. ej. para que el setter NO responda) se asigne antes de que el setter decida. La <b>activación por etiqueta</b> se salta esta espera.</p>
            <div className="flex flex-wrap gap-4">
              <Input label="Segundos de espera" type="number" min="0" max="3600" step="5" value={s.insertion_wait_seconds ?? 0} onChange={(e) => set({ insertion_wait_seconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })} className="!w-44" hint="0 = procesa de inmediato (con su debounce)." />
              <Input label="Reaplicar tras inactividad (horas)" type="number" min="0" max="720" step="1" value={s.insertion_idle_hours ?? 0} onChange={(e) => set({ insertion_idle_hours: Math.min(720, Math.max(0, Number(e.target.value) || 0)) })} className="!w-56" hint="Si el lead vuelve tras estas horas sin actividad, se aplica de nuevo. 0 = solo la 1ª vez." />
            </div>
            <p className="text-[11px] text-slate-400">Si lo dejas en 0, se usa el tiempo de inserción de la conexión (Ajustes). El del setter, si es mayor que 0, manda.</p>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <span className="mb-1 block text-sm font-medium text-slate-700">📅 Calendarios que cuentan como «agenda» de este setter</span>
            <p className="mb-2 text-xs text-slate-400">Si el objetivo de este setter es <b>agendar</b>, marca SUS calendarios: solo esas reservas cuentan como agenda para él. Si su objetivo es otro (enviar un link, etc.), déjalo <b>vacío</b> → este setter no mide agendas. La agenda la reclama el setter que atendió la conversación, solo si la reserva cae en un calendario suyo.</p>
            {(() => {
              const selected = Array.isArray(s.calendar_ids) ? s.calendar_ids : [];
              const list = calendars?.calendars || [];
              const toggleCal = (cid) => set({ calendar_ids: selected.includes(cid) ? selected.filter((x) => x !== cid) : [...selected, cid] });
              return (
                <div className="flex flex-wrap gap-2">
                  {list.length === 0 && <span className="text-xs text-slate-400">{calendars === null ? 'Cargando calendarios…' : 'No hay calendarios que mostrar (conecta la subcuenta y revisa el scope de calendarios).'}</span>}
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
          </div>

          <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <Toggle
              checked={Boolean(s.test_mode)}
              onChange={(v) => set({ test_mode: v })}
              label="🧪 Modo test (solo este setter)"
              description="Este setter SOLO responde a contactos con la etiqueta de prueba de la conexión (los demás setters siguen normal). Para poner TODA la conexión en test, usa el modo test de la conexión."
            />
          </div>

          {isAdmin && (
            <div className="border-t border-slate-100 pt-5">
              <Toggle checked={s.accepts_leads !== false} onChange={(v) => set({ accepts_leads: v })} label="Recibir leads nuevos" description="Si lo apagas, este setter deja de recibir leads nuevos (sigue atendiendo los que ya lleva). Para repartir leads por proporción entre setters, usa un ⚔️ Versus." />
            </div>
          )}

          <div className="border-t border-slate-100 pt-5">
            <button type="button" onClick={() => setShowTags((v) => !v)} className="mb-2 text-sm font-semibold text-violet-700 hover:underline">
              {showTags ? '▾' : '▸'} 🏷️ Función avanzada: filtrar por etiquetas (responder solo / no responder)
            </button>
            {showTags && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">Si añades etiquetas, este setter SOLO atiende a contactos de GHL que las tengan (así diriges cada lead al setter correcto). Vacío = atiende a cualquiera que no tenga otro setter específico.</p>
                {(s.required_tags || []).length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Debe tener</span>
                    <Select value={s.required_tags_mode || 'any'} onChange={(e) => set({ required_tags_mode: e.target.value })} className="!w-56 !py-1.5 text-xs">
                      <option value="any">cualquiera de estas etiquetas (O)</option>
                      <option value="all">todas estas etiquetas (Y)</option>
                    </Select>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {(s.required_tags || []).map((tg) => (
                    <span key={tg} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">
                      {tg}
                      <button type="button" onClick={() => set({ required_tags: s.required_tags.filter((x) => x !== tg) })} className="text-violet-400 hover:text-violet-700">×</button>
                    </span>
                  ))}
                  <input placeholder="escribe una etiqueta y Enter"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const v = e.target.value.trim();
                        const cur = s.required_tags || [];
                        if (v && !cur.includes(v)) set({ required_tags: [...cur, v] });
                        e.target.value = '';
                      }
                    }}
                    className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-violet-400" />
                </div>

                <div className="border-t border-slate-100 pt-3">
                  <p className="mb-2 text-xs text-slate-400">🚫 <b>NO</b> responder a leads con estas etiquetas (este setter los ignora aunque casen por lo de arriba):</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {(s.excluded_tags || []).map((tg) => (
                      <span key={tg} className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600">
                        {tg}
                        <button type="button" onClick={() => set({ excluded_tags: s.excluded_tags.filter((x) => x !== tg) })} className="text-red-400 hover:text-red-700">×</button>
                      </span>
                    ))}
                    <input placeholder="etiqueta a excluir y Enter"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const v = e.target.value.trim();
                          const cur = s.excluded_tags || [];
                          if (v && !cur.includes(v)) set({ excluded_tags: [...cur, v] });
                          e.target.value = '';
                        }
                      }}
                      className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-red-400" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === 'activaciones' && (
        <div className="max-w-2xl">
          <div className="space-y-3 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
            <Toggle
              checked={Boolean(s.activation_enabled)}
              onChange={(v) => set({ activation_enabled: v })}
              label="⚡ Activación externa por etiqueta"
              description="Cuando en GHL se le añade una etiqueta al contacto, este setter lee el historial de su conversación y le escribe él solo. Cada etiqueta es un punto de entrada distinto con SU propio contexto: la que pongas tras un CTA puede hacer que entre hablando diferente que la que pongas tras un IF."
            />
            {Boolean(s.activation_enabled) && (() => {
              const tagsList = Array.isArray(s.activation_tags) ? s.activation_tags : [];
              const setTag = (i, patch) => set({ activation_tags: tagsList.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
              <div className="space-y-3">
                {tagsList.length === 0 && <p className="text-xs text-slate-400">Aún no hay etiquetas activadoras. Añade una para que un workflow de GHL pueda meter al setter.</p>}

                {tagsList.map((t, i) => (
                  <div key={i} className="space-y-2 rounded-xl border border-violet-200 bg-white p-3">
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Input label="Etiqueta que activa" value={t.tag || ''} onChange={(e) => setTag(i, { tag: e.target.value })} placeholder="ej. activar-tras-cta"
                          hint={!String(t.tag || '').trim() && (String(t.contexto || '').trim() || (Array.isArray(t.links) ? t.links.length : t.link))
                            ? '⚠ Ponle nombre a la etiqueta o se descartará al guardar.'
                            : 'La MISMA que añadirá tu workflow de GHL.'} />
                      </div>
                      <Button variant="secondary" loading={creatingTag === i} disabled={!String(t.tag || '').trim()} onClick={() => createTag(i, t.tag)}>Crear en GHL</Button>
                      <button type="button" onClick={() => set({ activation_tags: tagsList.filter((_, j) => j !== i) })} className="mb-2 text-slate-400 hover:text-red-500" title="Quitar esta etiqueta"><Trash2 size={16} /></button>
                    </div>

                    <Textarea label="🧠 Contexto de esta etiqueta" rows={2} maxLength={1500} value={t.contexto || ''} onChange={(e) => setTag(i, { contexto: e.target.value })}
                      placeholder="ej. Acaba de pedir el precio por el CTA del anuncio y no contestó. Entra retomando eso, sin volver a presentarte."
                      hint={`Qué pasó justo ANTES de que le pusieran esta etiqueta. Es lo que hace que entre hablando distinto según dónde la coloques en el workflow. Vacío = entra con su flujo normal. (${String(t.contexto || '').length}/1500)`} />

                    <div className="flex items-end gap-2">
                      <div className="w-48">
                        <Input label="⏳ Espera (segundos)" type="number" min="0" max="3600" step="5" value={t.espera ?? 0} onChange={(e) => setTag(i, { espera: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })} hint="Antes de escribir (máx. 1 h)." />
                      </div>
                      {(() => {
                        const links = Array.isArray(t.links) ? t.links : (t.link ? [{ url: t.link, name: '' }] : []);
                        return (
                          <div className="mb-2 flex items-center gap-2">
                            <Button variant="secondary" className="!py-1.5 text-xs" onClick={() => setLinkModal({ i, nombre: '', url: '' })}>
                              {links.length ? `🔗 ${links.length} CTA${links.length > 1 ? 's' : ''}` : '🔗 Vincular CTAs'}
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}

                <Button variant="secondary" onClick={() => set({ activation_tags: [...tagsList, { tag: '', contexto: '', espera: 0, link: '' }] })}><Plus size={16} /> Añadir etiqueta activadora</Button>
                {tagMsg && <p className={`text-xs font-medium ${tagMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{tagMsg.text}</p>}

                {/* URL DEDICADA para el evento ContactTagUpdate (aparte del webhook de mensajes) */}
                <div className="rounded-xl border border-violet-200 bg-white p-3">
                  <span className="block text-sm font-bold text-slate-800">🔗 Webhook de la etiqueta (ContactTagUpdate)</span>
                  <p className="mt-1 text-xs text-slate-400">
                    En <b>marketplace.gohighlevel.com → tu app → Advanced Settings → Webhooks</b>, busca la fila <b>ContactTagUpdate</b>, actívala y pega esta URL en su campo <b>«Custom webhook URL»</b> (así va por una URL <b>aparte</b> de tus mensajes y no se mezcla). Es la <b>misma URL para todas las subcuentas</b>: el sistema detecta a quién pertenece por el <code>locationId</code> del evento.
                  </p>
                  <div className="mt-2"><CopyField label="Custom webhook URL para la fila ContactTagUpdate" value={s.tag_webhook_url || ''} /></div>
                  <p className="mt-2 text-[11px] text-slate-400">En tu workflow de GHL solo añade la acción <b>«Añadir etiqueta»</b> con la etiqueta de arriba. Ojo IG/WhatsApp: el contacto debe tener chat previo (ventana de 24 h) para poder escribirle.</p>
                </div>

                {/* 🧪 Probar recepción del webhook de etiqueta (igual que el de comentarios) */}
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600">🧪 Probar: últimas etiquetas recibidas</span>
                    <Button variant="secondary" className="!py-1 text-xs" onClick={loadTagLog}>Actualizar</Button>
                  </div>
                  {tagLog === null ? (
                    <p className="text-xs text-slate-400">Guarda primero (interruptor + etiqueta), añade la etiqueta a un contacto de prueba en GHL y pulsa «Actualizar».</p>
                  ) : tagLog.length === 0 ? (
                    <p className="text-xs text-slate-400">Aún no ha llegado ningún evento de etiqueta a este webhook. Revisa que ContactTagUpdate esté activado y la URL pegada.</p>
                  ) : (
                    <div className="scroll-thin max-h-52 space-y-1.5 overflow-y-auto">
                      {tagLog.map((ev) => {
                        const activado = ev.kind === 'activador_etiqueta' || (ev.payload?.evaluados || []).some((x) => x.estado === 'activado');
                        return (
                          <details key={ev.id} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                            <summary className="cursor-pointer text-[11px]">
                              <span className={`font-bold ${activado ? 'text-emerald-600' : 'text-slate-500'}`}>{activado ? '✓ activó' : '• recibido'}</span>
                              <span className="ml-2 text-slate-500">{(ev.payload?.tags || []).join(', ') || (ev.payload?.etiqueta ?? '—')}</span>
                              <span className="ml-2 text-slate-400">{new Date(ev.created_at).toLocaleTimeString('es-ES')}</span>
                            </summary>
                            <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded bg-white p-2 text-[10px] leading-relaxed text-slate-600">{JSON.stringify(ev.payload, null, 2)}</pre>
                          </details>
                        );
                      })}
                    </div>
                  )}
                </div>

                <details className="text-xs text-slate-400">
                  <summary className="cursor-pointer">Alternativa avanzada: webhook por-setter (nodo Webhook en el workflow)</summary>
                  <div className="mt-2"><CopyField label="Webhook del activador (nodo Webhook de GHL)" value={s.activation_webhook_url || ''} /></div>
                  <p className="mt-1">Úsalo solo si prefieres un nodo «Webhook» dentro del workflow en vez del evento ContactTagUpdate. Esta URL sí es única por setter.</p>
                </details>
              </div>
              );
            })()}
          </div>
        </div>
      )}

      {tab === 'seguimientos' && (
        <div className="max-w-2xl space-y-4">
          <Banner tone="info">Si el lead deja de responder, el setter retoma la conversación solo. Cada paso se cancela si el lead contesta. Instagram/WhatsApp solo permiten responder dentro de las 24 h del último mensaje del lead.</Banner>
          <Card className="p-5">
            <Toggle
              checked={s.followup_ai_check !== false}
              onChange={(v) => set({ followup_ai_check: v })}
              label="🧠 Revisar con IA antes de cada seguimiento"
              description="Lee los últimos mensajes y decide si aún conviene: no persigue a quien ya agendó, ya compró, dijo que no le interesa o se despidió. (Los que ya agendaron o se descartaron se saltan siempre, sin coste.)"
            />
          </Card>
          {followups.map((f, i) => (
            <Card key={i} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-bold text-slate-800">Seguimiento #{i + 1}</span>
                <button onClick={() => set({ followups: followups.filter((_, j) => j !== i) })} className="text-slate-400 hover:text-red-500"><Trash2 size={16} /></button>
              </div>
              <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                <Input label="Horas de espera" type="number" min="1" max="23" step="0.5" value={f.hours} onChange={(e) => set({ followups: followups.map((x, j) => (j === i ? { ...x, hours: Number(e.target.value) } : x)) })} hint="máx. 23 h" />
                <Textarea label="Instrucción para la IA" rows={2} value={f.instruction || ''} onChange={(e) => set({ followups: followups.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)) })} placeholder="Ej.: Retoma con algo del último tema, pregunta ligera, cero presión." />
              </div>
            </Card>
          ))}
          <Button variant="secondary" onClick={() => set({ followups: [...followups, { hours: 4, instruction: '' }] })} disabled={followups.length >= 5}>
            <Plus size={16} /> Añadir seguimiento
          </Button>
        </div>
      )}

      {tab === 'arquitecto' && (
        <div className="max-w-3xl space-y-4">
          <Banner tone="info">Habla con la IA arquitecta y arma los 3 bloques del prompt. Cuando te proponga la versión final, pulsa «Aplicar» y se guarda en ESTE setter.</Banner>
          <Card className="overflow-hidden p-0">
            <PromptArchitect targetPath={`/api/setters/${id}`} mode="architect" onApplied={load} />
          </Card>
        </div>
      )}

      {/* 🔗 Vincular CTA: guarda la URL de la automatización (ManyChat/GHL/…) que pone esta etiqueta */}
      {linkModal !== null && (() => {
        const lista = Array.isArray(s.activation_tags) ? s.activation_tags : [];
        const entry = lista[linkModal.i] || {};
        // compat: si la etiqueta traía el campo antiguo `link` (una sola URL), lo tratamos como lista
        const links = Array.isArray(entry.links) ? entry.links : (entry.link ? [{ url: entry.link, name: '' }] : []);
        const cerrar = () => setLinkModal(null);
        const setLinks = (next) => set({ activation_tags: lista.map((x, j) => (j === linkModal.i ? { ...x, links: next, link: '' } : x)) });
        const addLink = () => {
          const url = (linkModal.url || '').trim();
          if (!linkOk(url) || links.length >= 10) return; // tope 10, igual que el servidor
          setLinks([...links, { url, name: (linkModal.nombre || '').trim() }]);
          setLinkModal({ ...linkModal, nombre: '', url: '' });
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={cerrar}>
            <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-sm font-bold text-slate-800">🔗 CTAs de «{entry.tag || 'esta etiqueta'}»</h3>
                <button onClick={cerrar} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">✕</button>
              </div>
              <div className="space-y-3 p-5">
                <p className="text-xs text-slate-400">Enlaces de las automatizaciones relacionadas con esta etiqueta (workflow de GHL, automatización de ManyChat, el anuncio…). Solo referencia para volver a ellas de un clic; no cambian el comportamiento del setter.</p>

                {links.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-3 text-center text-xs text-slate-400">Aún no hay CTAs vinculados.</p>
                ) : (
                  <div className="space-y-1.5">
                    {links.map((l, k) => (
                      <div key={k} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold text-slate-700">{l.name || l.url}</div>
                          {l.name && <div className="truncate text-[11px] text-slate-400">{l.url}</div>}
                        </div>
                        {linkOk(l.url) && <a href={l.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-semibold text-violet-600 hover:underline">Abrir ↗</a>}
                        <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== k))} className="shrink-0 text-slate-400 hover:text-red-500" title="Quitar"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}

                {links.length >= 10 ? (
                  <p className="rounded-xl border border-slate-200 p-3 text-center text-xs text-slate-400">Máximo 10 CTAs por etiqueta. Quita alguno para añadir otro.</p>
                ) : (
                  <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                    <span className="text-xs font-semibold text-slate-600">Añadir un CTA</span>
                    <Input placeholder="Nombre (opcional) — ej. Automatización ManyChat" value={linkModal.nombre || ''} onChange={(e) => setLinkModal({ ...linkModal, nombre: e.target.value })} />
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Input placeholder="https://app.gohighlevel.com/… o https://app.manychat.com/…" value={linkModal.url || ''} onChange={(e) => setLinkModal({ ...linkModal, url: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') addLink(); }}
                          hint={(linkModal.url || '').trim() && !linkOk(linkModal.url) ? '⚠ Enlace no válido — debe ser una URL http:// o https:// completa' : 'Debe ser una URL http:// o https:// completa'} />
                      </div>
                      <Button className="mb-2" onClick={addLink} disabled={!linkOk(linkModal.url || '')}>Añadir</Button>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-slate-400">Recuerda <b>Guardar</b> el setter para que quede registrado.</p>
                  <Button variant="secondary" onClick={cerrar}>Cerrar</Button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {versions !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setVersions(null)}>
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-800">🕘 Historial de versiones del prompt</h3>
              <button onClick={() => setVersions(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">✕</button>
            </div>
            <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-4">
              {versions.length === 0 && <p className="py-8 text-center text-sm text-slate-400">Todavía no hay versiones guardadas. Se crean solas cada vez que el prompt cambia (a mano, por el arquitecto o por el corrector).</p>}
              {versions.map((v) => (
                <details key={v.id} className="rounded-xl border border-slate-200 p-3">
                  <summary className="flex cursor-pointer items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-700">
                      {new Date(v.created_at).toLocaleString('es-ES')}
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                        {{ manual: '✍️ manual', corrector: '🪄 corrector', arquitecto: '✨ arquitecto', previo_restauracion: '↩️ antes de restaurar' }[v.source] || v.source}
                      </span>
                    </span>
                    <Button variant="secondary" className="!py-1 text-xs" loading={restoring} onClick={(e) => { e.preventDefault(); restoreVersion(v); }}>↩️ Restaurar</Button>
                  </summary>
                  <div className="mt-2 space-y-2">
                    {[['1 · Identidad', v.prompt_identity], ['2 · Negocio', v.prompt_business], ['3 · Flujo', v.prompt_flow]].map(([lbl, txt]) => (
                      <div key={lbl}>
                        <div className="text-[10px] font-bold uppercase text-slate-400">{lbl}</div>
                        <pre className="scroll-thin max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">{txt || '(vacío)'}</pre>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
