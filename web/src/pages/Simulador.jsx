import { useEffect, useMemo, useRef, useState } from 'react';
import { Beaker, Plus, Send, Tag, Trash2, Zap, Clock, RefreshCw, Play, Copy, X } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Select, StagePill, Banner, EmptyState, Toggle } from '../components/ui.jsx';

// 🧪 SIMULADOR · dos laboratorios sobre el motor REAL (nada sale a GHL; lo que usa IA se cobra como una conversación real):
//  1) Etiquetas y seguimientos: lead ficticio → etiquetas → activación → respuesta → seguimientos, con la traza
//     de cada decisión (contexto guardado, espera, ventana de Meta, descartes).
//  2) Preguntas sobre lead magnets: tanda de preguntas con/sin etiqueta de CTA y comprobaciones automáticas.

const hora = (d) => (d ? new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const seg = (s) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

// Texto humano de cada evento del motor (webhook_log) para la traza del laboratorio.
function textoEvento(e) {
  const p = e.payload || {};
  const m = {
    sim_creada: () => `Lead simulado creado (${p.canal}, ventana de Meta: ${p.ventana === 'nunca' ? 'nunca escribió por DM' : p.ventana})`,
    sim_etiquetas: () => `Etiquetas del lead ahora: ${(p.tags || []).map((t) => `«${t}»`).join(', ') || '(ninguna)'}`,
    etiqueta_recibida: () => `Webhook de etiquetas evaluado: ${(p.evaluados || []).map((x) => `${x.etiqueta} → ${x.estado}`).join(' · ') || (p.sin_match ? 'ninguna etiqueta activadora coincide' : 'sin activadoras')}`,
    contexto_lead_magnet: () => `📌 Contexto guardado: pidió «${p.nombre}» (etiqueta «${p.etiqueta}»${p.recien_puesta ? ', recién puesta' : ''})`,
    activador_etiqueta: () => `⚡ La etiqueta «${p.etiqueta}» activa al setter${p.con_contexto ? ' con instrucciones de entrada' : ''}${p.recien_puesta ? ' (recién puesta)' : ''}`,
    activador_externo: () => `Activación programada: el setter entrará tras ${seg(Number(p.espera_s) || 0)} (canal ${p.canal})`,
    sim_espera_acelerada: () => '⏩ Espera acelerada por el simulador: entra en unos segundos (la espera real queda en Activaciones)',
    activacion_descartada: () => `✖ Activación descartada: ${p.motivo}`,
    activador_bloqueado: () => `✖ Activación bloqueada: ${p.motivo}`,
    activador_apagado: () => '✖ La IA o el setter están apagados: la activación no entra',
    activador_reanuda: () => `La etiqueta reanuda al setter (estaba en pausa: ${p.pausa_anterior})`,
    activacion_aplazada_por_horario: () => `Activación aplazada por horario (${p.minutos} min)`,
    activacion_ventana_cerrada_al_enviar: () => '✖ La activación murió al enviar: ventana de Meta cerrada',
    respuesta_omitida_por_etiqueta: () => `✖ No responde: filtro de etiquetas (modo test: ${p.test_mode ? 'sí' : 'no'}, requeridas: ${(p.required_tags || []).join(', ') || '—'})`,
    insercion_espera: () => `Espera de inserción de ${seg(p.segundos)} antes de responder${p.reaplicada ? ' (vuelve tras inactividad)' : ''}`,
    cta_espera: () => `El mensaje casa con un CTA de la conexión: espera de ${seg(p.segundos)}`,
    sim_horario_ignorado: () => `⏰ Fuera del horario activo (${p.minutos} min hasta abrir): en producción esperaría; aquí sigue`,
    envio_descartado: () => `✖ Envío descartado (${p.source}): ${p.motivo}`,
    sim_mensaje_enviado: () => null, // ya es una burbuja
    seguimiento_reprogramado_acuerdo: () => `Seguimiento reprogramado por acuerdo con el lead: ${p.horas_acordadas} h pedidas → ${p.horas_efectivas} h`,
    seguimiento_acuerdo_fuera_ventana: () => `El acuerdo de ${p.horas_acordadas} h no cabe en la ventana de Meta (quedan ${p.ventana_restante_h} h)`,
    seguimiento_acuerdo_sin_paso: () => `El setter prometió escribir en ${p.horas_acordadas} h pero no hay paso de seguimiento configurado`,
    seguimiento_adelantado_a_ventana: () => `Seguimiento adelantado a la ventana: ${p.horas_pedidas} h → ${p.horas_efectivas} h`,
    seguimiento_no_cabe_en_ventana: () => `✖ El seguimiento #${(p.paso || 0) + 1} no cabe en la ventana de Meta (quedan ${p.ventana_restante_h} h)`,
    seguimiento_ventana_cerrada: () => '✖ Seguimiento no enviado: ventana de Meta cerrada',
    followup_omitido_ia: () => `Seguimiento omitido por el chequeo IA: ${p.motivo || 'sin motivo'}`,
    followup_check_error: () => `Error en el chequeo IA del seguimiento: ${p.error}`,
    sim_seguimiento_forzado: () => (p.ok ? `⏩ Seguimiento #${p.paso} forzado (configurado a ${p.horas_configuradas} h)` : `✖ No se puede forzar el seguimiento: ${p.motivo}`),
    sim_ventana: () => `Ventana de Meta cambiada a: ${p.estado}`,
    handoff_ia: () => `🙋 La IA pidió atención humana: ${p.motivo}`,
    lead_asignado_setter: () => `Lead asignado al setter «${p.nombre}»`,
    lead_sin_respuesta_conexion_apagada: () => '✖ Nadie responde: la conexión tiene IA/bot apagados',
    lead_sin_respuesta_setter_apagado: () => '✖ Nadie responde: el setter está apagado',
    error_llm: () => `✖ Error del modelo: ${p.error}`,
    error_llm_reintentando: () => `Error del modelo (intento ${p.intento}), se reintenta: ${p.error}`,
    error_config: () => `✖ ${p.msg}`,
    respuesta_repetida_filtrada: () => `Se filtraron ${p.filtradas} burbujas repetidas`,
    error_contexto_cta: () => `Error guardando el contexto del CTA: ${p.error}`,
    sim_sin_saldo_marketplace: () => `✖ Sin saldo en el marketplace: ${p.nota || 'la simulación no puede usar la IA (recarga y repite)'}`,
    sim_respuesta_no_generada: () => `✖ Ciclo terminado sin respuesta: ${p.nota || ''}`,
    sim_seguimiento_omitido: () => `✖ Seguimiento cortado por el motor: ${p.nota || ''}`,
    error_llm_followup_reintentando: () => `Error del modelo en el seguimiento (intento ${p.intento}), se reintenta: ${p.error}`,
    error_llm_followup: () => `✖ Error del modelo en el seguimiento (agotados los reintentos): ${p.error}`,
    seguimiento_agenda_cancelada: () => 'Seguimientos cortados: el lead ya agendó',
  };
  const f = m[e.kind];
  if (f) return f();
  return `${e.kind}${Object.keys(p).length ? ' · ' + JSON.stringify(p).slice(0, 140) : ''}`;
}

// «En cola» de verdad = algo va a pasar en segundos; un seguimiento programado para dentro de horas no lo es.
function enColaPronto(p) {
  if (!p) return false;
  return Boolean(p.activacion || (p.respuesta && (p.respuesta_en == null || p.respuesta_en <= 90)) || (p.seguimiento && (p.seguimiento_en == null || p.seguimiento_en <= 90)));
}
function ventanaMeta(conv) {
  if (!conv?.last_inbound_at) return { txt: 'nunca escribió por DM → cerrada', ok: false };
  const h = (Date.now() - new Date(conv.last_inbound_at).getTime()) / 3_600_000;
  return h < 23.5 ? { txt: `abierta (escribió hace ${h < 1 ? Math.round(h * 60) + ' min' : h.toFixed(1) + ' h'})`, ok: true } : { txt: `cerrada (escribió hace ${h.toFixed(1)} h)`, ok: false };
}

export default function Simulador() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [opciones, setOpciones] = useState(null);
  const [setterId, setSetterId] = useState('');
  const [tab, setTab] = useState('etiquetas');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/accounts').then((a) => { setAccounts(a); if (a[0]) setAccountId(String(a[0].id)); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!accountId) return;
    setOpciones(null); setSetterId('');
    api.get(`/api/simulador/opciones?account_id=${accountId}`)
      .then((o) => { setOpciones(o); const def = o.setters.find((s) => s.is_default) || o.setters[0]; if (def) setSetterId(String(def.id)); })
      .catch((e) => setError(e.message));
  }, [accountId]);

  const setter = useMemo(() => opciones?.setters?.find((s) => String(s.id) === String(setterId)) || null, [opciones, setterId]);

  if (accounts.length === 0) {
    return (
      <div>
        <SectionTitle title="Simulador" subtitle="Laboratorio del setter sobre el motor real" />
        <EmptyState icon={Beaker} title="Primero crea una cuenta" subtitle="Necesitas una conexión con un setter y proveedor de IA." />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle
        title="Simulador"
        subtitle="Leads ficticios que recorren el motor REAL (etiquetas, activación, ventana de Meta, seguimientos). Nada sale a GHL; lo que usa IA se cobra como una conversación real (una por día)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {accounts.length > 1 && (
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="!w-44" title="Conexión">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.name}</option>)}
              </Select>
            )}
            {opciones?.setters?.length > 0 && (
              <Select value={setterId} onChange={(e) => setSetterId(e.target.value)} className="!w-52" title="Setter">
                {opciones.setters.map((s) => <option key={s.id} value={s.id}>🤖 {s.name}</option>)}
              </Select>
            )}
          </div>
        }
      />
      <div className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1 text-xs font-semibold dark:bg-slate-800">
        {[['etiquetas', '🏷️ Etiquetas y seguimientos'], ['preguntas', '📚 Preguntas sobre lead magnets']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`flex-1 rounded-lg px-3 py-2 ${tab === k ? 'bg-white text-violet-700 shadow-sm dark:bg-slate-900 dark:text-violet-300' : 'text-slate-500 hover:text-slate-700'}`}>{l}</button>
        ))}
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {opciones && setter && (tab === 'etiquetas'
        ? <LabEtiquetas accountId={Number(accountId)} opciones={opciones} setter={setter} />
        : <LabPreguntas accountId={Number(accountId)} opciones={opciones} setter={setter} />)}
      {opciones && !opciones.setters.length && <Banner tone="warn">Esta conexión no tiene setters.</Banner>}
    </div>
  );
}

// ─── Laboratorio 1: etiquetas y seguimientos ─────────────────────────────────────────────────
function LabEtiquetas({ accountId, opciones, setter }) {
  const [sims, setSims] = useState([]);
  const [simId, setSimId] = useState(null);
  const [estado, setEstado] = useState(null);
  const [nombre, setNombre] = useState('Lead de prueba');
  const [ventana, setVentana] = useState('abierta');
  const [acelerar, setAcelerar] = useState(true);
  const [text, setText] = useState('');
  const [tagNueva, setTagNueva] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [verCtx, setVerCtx] = useState(false);
  const [avisos, setAvisos] = useState({ id: null, lista: [] });
  const bottomRef = useRef(null);
  const pollRef = useRef(null);
  const simIdRef = useRef(null);
  simIdRef.current = simId; // la selección vigente: respuestas tardías de otra simulación se ignoran
  const hastaRef = useRef(0); // seguir refrescando hasta esta hora (ms) aunque no haya pendientes

  const cargarLista = () => api.get(`/api/simulador?account_id=${accountId}`).then(setSims).catch(() => setSims([]));
  const cargarEstado = async (id) => {
    if (!id) return;
    try { const e = await api.get(`/api/simulador/${id}`); if (simIdRef.current !== id) return; setEstado(e); return e; } catch (err) { if (simIdRef.current === id) setError(err.message); }
  };
  useEffect(() => { cargarLista(); setSimId(null); setEstado(null); setAvisos({ id: null, lista: [] }); }, [accountId]);
  useEffect(() => { setEstado(null); if (simId) cargarEstado(simId); }, [simId]);
  // refresco: cada 2,5 s mientras haya algo en cola (o durante 40 s tras una acción)
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!simId) return;
    pollRef.current = setInterval(async () => {
      if (enColaPronto(estado?.pendientes) || Date.now() < hastaRef.current) await cargarEstado(simId);
    }, 2500);
    return () => clearInterval(pollRef.current);
  }, [simId, estado?.pendientes?.activacion, estado?.pendientes?.respuesta, estado?.pendientes?.seguimiento, estado?.pendientes?.respuesta_en, estado?.pendientes?.seguimiento_en]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [estado?.messages?.length, estado?.eventos?.length]);

  const accion = async (clave, fn) => {
    setBusy(clave); setError('');
    try { await fn(); hastaRef.current = Date.now() + 40_000; await cargarEstado(simId); await cargarLista(); } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  const crear = async () => {
    setBusy('crear'); setError('');
    try {
      const c = await api.post('/api/simulador', { account_id: accountId, setter_id: setter.id, nombre, canal: setter.channels[0] || 'IG', ventana });
      setAvisos({ id: c.id, lista: Array.isArray(c.avisos) ? c.avisos : [] });
      await cargarLista(); setSimId(c.id); hastaRef.current = Date.now() + 10_000;
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  const borrar = async (id) => {
    if (!window.confirm('¿Borrar esta simulación (mensajes, activaciones y etiquetas ficticias)?')) return;
    try { await api.del(`/api/simulador/${id}`); if (id === simId) { setSimId(null); setEstado(null); } await cargarLista(); } catch (err) { setError(err.message); }
  };
  const tagsActuales = estado?.tags || [];
  const opTags = (ops) => accion('tags', () => api.post(`/api/simulador/${simId}/etiquetas`, { ...ops, acelerar })); // add/remove: el servidor fusiona
  const enviar = (e) => { e.preventDefault(); if (!text.trim() || !simId) return; const t = text.trim(); setText(''); accion('msg', () => api.post(`/api/simulador/${simId}/mensaje`, { text: t, acelerar })); };

  // catálogo de etiquetas para el desplegable: activadoras del setter + las del catálogo de lead magnets
  const sugeridas = useMemo(() => {
    const out = [];
    for (const a of setter.activation_tags) out.push({ tag: a.tag, tipo: `activadora · espera ${seg(a.espera)}` });
    for (const l of opciones.lead_magnets) for (const t of l.tags) if (!out.some((x) => x.tag.toLowerCase() === t.toLowerCase())) out.push({ tag: t, tipo: `lead magnet · ${l.name}` });
    if (opciones.account.exclude_tag) out.push({ tag: opciones.account.exclude_tag, tipo: 'exclusión (sin-ia)' });
    if (setter.test_mode || setter.test_by_setter) out.push({ tag: setter.test_tag, tipo: 'etiqueta de test' });
    return out;
  }, [setter, opciones]);

  // línea de tiempo: mensajes + eventos + activaciones + etapas
  const timeline = useMemo(() => {
    if (!estado) return [];
    const items = [];
    for (const m of estado.messages) items.push({ t: m.created_at, id: `m${m.id}`, tipo: 'msg', m });
    for (const e of estado.eventos) { const txt = textoEvento(e); if (txt) items.push({ t: e.created_at, id: `e${e.id}`, tipo: 'ev', txt, mal: /^✖/.test(txt), bien: /^(📌|⚡|⏩)/.test(txt) }); }
    for (const a of estado.activaciones) items.push({ t: a.created_at, id: `a${a.id}`, tipo: 'act', a });
    for (const s of estado.etapas || []) items.push({ t: s.created_at, id: `s${s.created_at}${s.to_stage}`, tipo: 'ev', txt: `Etiqueta de estado: ${s.from_stage || '—'} → ${s.to_stage}${s.reason ? ` (${s.reason})` : ''}` });
    return items.sort((x, y) => new Date(x.t) - new Date(y.t) || String(x.id).localeCompare(String(y.id)));
  }, [estado]);

  const vm = ventanaMeta(estado?.conv);
  const p = estado?.pendientes || {};

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {/* lista + nuevo */}
      <Card className="flex h-[72vh] flex-col overflow-hidden">
        <div className="space-y-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del lead ficticio" className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-900" />
          <Select value={ventana} onChange={(e) => setVentana(e.target.value)} className="!w-full text-xs" title="Ventana de Meta al empezar">
            <option value="abierta">Ya escribió por DM (ventana abierta)</option>
            <option value="nunca">Solo comentó, nunca escribió por DM (ventana cerrada)</option>
            <option value="cerrada">Escribió hace más de 24 h (ventana cerrada)</option>
          </Select>
          <Button className="w-full !py-1.5 text-xs" loading={busy === 'crear'} onClick={crear}><Plus size={14} /> Nuevo lead simulado</Button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {sims.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-slate-400">Aún no hay simulaciones en esta conexión.</p>}
          {sims.map((s) => (
            <div key={s.id} className={`group flex items-center gap-1 border-b border-slate-50 px-2.5 py-2 text-[11px] dark:border-slate-800 ${s.id === simId ? 'bg-violet-50 dark:bg-violet-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}>
              <button onClick={() => setSimId(s.id)} className="min-w-0 flex-1 text-left">
                <span className={`block truncate font-medium ${s.id === simId ? 'text-violet-700 dark:text-violet-300' : 'text-slate-700 dark:text-slate-200'}`}>{s.lead_name} <span className="text-slate-400">· {s.setter_name || 'sin setter'}</span></span>
                <span className="text-[10px] text-slate-400">{new Date(s.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })} · {s.n} msg · {s.stage}{s.cta_tag ? ` · 📌 ${s.cta_tag}` : ''}</span>
              </button>
              <button onClick={() => borrar(s.id)} title="Borrar simulación" aria-label="Borrar simulación" className="shrink-0 text-slate-300 opacity-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </Card>

      {/* traza + chat */}
      <Card className="flex h-[72vh] flex-col lg:col-span-2">
        <div className="scroll-thin flex-1 space-y-1.5 overflow-y-auto bg-slate-50/50 px-4 py-3 dark:bg-slate-900/40">
          {!simId && <p className="py-16 text-center text-sm text-slate-400">Crea un lead simulado o elige uno de la lista.<br />Luego ponle la etiqueta del CTA, la de «lm abierto» / «no abrió», escribe como el lead y fuerza los seguimientos.</p>}
          {simId && !estado && <p className="py-16 text-center text-sm text-slate-400">Cargando…</p>}
          {timeline.map((it) => {
            if (it.tipo === 'msg') {
              const bot = it.m.direction === 'outbound';
              return (
                <div key={it.id} className={`flex ${bot ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${bot ? (it.m.source === 'seguimiento' ? 'rounded-br-md bg-amber-500 text-white' : 'rounded-br-md bg-violet-600 text-white') : 'rounded-bl-md border border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'}`}>
                    {bot && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">{it.m.source === 'seguimiento' ? `seguimiento` : 'setter'} · {hora(it.t)}</div>}
                    {!bot && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">lead · {hora(it.t)}</div>}
                    {it.m.body}
                  </div>
                </div>
              );
            }
            if (it.tipo === 'act') {
              const a = it.a;
              const txt = a.status === 'esperando' ? `⚡ Activación por «${a.tag}»: esperando (espera ${seg(a.wait_seconds)}${a.respond_at ? `, hasta las ${hora(a.respond_at)}` : ''})` : a.status === 'respondido' ? `⚡ Activación por «${a.tag}» → respondió` : `✖ Activación por «${a.tag}» descartada: ${a.motivo}`;
              return <div key={it.id} className={`mx-auto max-w-[92%] rounded-lg px-3 py-1 text-center text-[11px] ${a.status === 'descartado' ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'}`}>{hora(it.t)} · {txt}</div>;
            }
            return <div key={it.id} className={`mx-auto max-w-[92%] rounded-lg px-3 py-1 text-center text-[11px] ${it.mal ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : it.bien ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'text-slate-500'}`}>{hora(it.t)} · {it.txt}</div>;
          })}
          {enColaPronto(p) && (
            <div className="flex justify-end">
              <div className="flex items-center gap-1.5 rounded-2xl rounded-br-md bg-violet-100 px-3 py-2 text-[11px] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" /><span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" /><span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                {p.seguimiento && !p.respuesta && !p.activacion ? 'seguimiento en cola' : p.activacion ? 'activación en cola' : 'respuesta en cola'}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {simId && (
          <div className="space-y-2 border-t border-slate-100 px-3 py-2.5 dark:border-slate-800">
            {/* etiquetas */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag size={13} className="text-slate-400" />
              {tagsActuales.length === 0 && <span className="text-[11px] text-slate-400">sin etiquetas</span>}
              {tagsActuales.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                  {t}<button onClick={() => opTags({ remove: [t] })} title="Quitar (como si el workflow la quitara)" aria-label={`Quitar etiqueta ${t}`} className="hover:text-red-600"><X size={11} /></button>
                </span>
              ))}
              <input list="sim-tags" value={tagNueva} onChange={(e) => setTagNueva(e.target.value)} placeholder="Poner etiqueta…" className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-900"
                onKeyDown={(e) => { if (e.key === 'Enter' && tagNueva.trim()) { e.preventDefault(); const t = tagNueva.trim(); setTagNueva(''); opTags({ add: [t] }); } }} />
              <datalist id="sim-tags">{sugeridas.map((s) => <option key={s.tag} value={s.tag}>{s.tipo}</option>)}</datalist>
              <Button variant="secondary" className="!px-2.5 !py-1 text-[11px]" loading={busy === 'tags'} disabled={!tagNueva.trim()} onClick={() => { const t = tagNueva.trim(); setTagNueva(''); opTags({ add: [t] }); }}>Poner</Button>
            </div>
            {/* mensaje del lead */}
            <form onSubmit={enviar} className="flex items-center gap-2">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe como el lead…" className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100 dark:border-slate-700 dark:bg-slate-900" />
              <Button type="submit" className="!px-3" loading={busy === 'msg'} aria-label="Enviar mensaje del lead"><Send size={15} /></Button>
            </form>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" className="!px-2.5 !py-1 text-[11px]" loading={busy === 'fu'} onClick={() => accion('fu', () => api.post(`/api/simulador/${simId}/seguimiento`, {}))} title="Dispara ahora el siguiente paso de seguimiento (con todos los cortes reales)"><Zap size={12} /> Forzar seguimiento ahora</Button>
              <Select value="" onChange={(e) => { const v = e.target.value; if (v) accion('ventana', () => api.post(`/api/simulador/${simId}/ventana`, { estado: v })); }} className="!w-auto !py-1 text-[11px]" title="Mover la ventana de Meta">
                <option value="">Ventana de Meta…</option>
                <option value="abierta">Abierta (escribió hace 5 min)</option>
                <option value="cerrada">Cerrada (escribió hace 25 h)</option>
                <option value="nunca">Nunca escribió por DM</option>
              </Select>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500"><input type="checkbox" checked={acelerar} onChange={(e) => setAcelerar(e.target.checked)} /> Acelerar esperas (recomendado)</label>
              <button onClick={() => cargarEstado(simId)} className="ml-auto text-slate-400 hover:text-violet-600" title="Refrescar"><RefreshCw size={13} /></button>
            </div>
          </div>
        )}
      </Card>

      {/* estado */}
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        {avisos.id === simId && avisos.lista.map((a, i) => <Banner key={i} tone="warn">{a}</Banner>)}
        {estado && (
          <>
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Estado del lead</h3>
              <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex items-center justify-between"><span>Setter</span><b>{estado.setter?.name || '—'}</b></div>
                <div className="flex items-center justify-between"><span>Estado</span><StagePill stage={estado.conv.stage || 'nuevo'} /></div>
                <div className="flex items-center justify-between"><span>Ventana de Meta</span><b className={vm.ok ? 'text-emerald-600' : 'text-red-600'}>{vm.txt}</b></div>
                <div className="flex items-center justify-between"><span>Seguimientos</span><b>{estado.conv.followup_state} (paso {estado.conv.followup_step}/{estado.setter?.followups?.length || 0})</b></div>
                <div className="flex items-center justify-between"><span>Bot</span><b>{estado.conv.bot_paused ? `en pausa (${estado.conv.paused_by || 'auto'})` : 'activo'}</b></div>
                <div className="flex items-center justify-between"><span>En cola</span><b>{[p.activacion && 'activación', p.respuesta && `respuesta${p.respuesta_en > 90 ? ' (programada en ' + seg(p.respuesta_en) + ')' : ''}`, p.seguimiento && `seguimiento${p.seguimiento_en > 90 ? ' (programado en ' + seg(p.seguimiento_en) + ')' : ''}`].filter(Boolean).join(', ') || 'nada'}</b></div>
              </div>
            </Card>
            <Card className="p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">📌 Lo que pidió (contexto del CTA)</h3>
              {estado.conv.cta_tag ? (
                <div className="text-xs">
                  <div className="mb-1"><code className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">{estado.conv.cta_tag}</code> <span className="text-slate-400">{hora(estado.conv.cta_at)}</span></div>
                  <p className={`text-slate-600 dark:text-slate-300 ${verCtx ? '' : 'line-clamp-3'}`}>{estado.conv.cta_context || '(sin texto)'}</p>
                  <button onClick={() => setVerCtx((v) => !v)} className="mt-1 text-[11px] font-semibold text-violet-600">{verCtx ? 'ver menos' : 'ver todo'}</button>
                </div>
              ) : (
                <p className="text-xs text-slate-400">Ninguno todavía{estado.cta_pendiente ? ' (hay uno pendiente en Redis para cuando nazca la conversación)' : ''}. Se guarda al poner la etiqueta de un CTA o de un lead magnet.</p>
              )}
            </Card>
            {estado.setter && (
              <Card className="p-4 text-[11px] text-slate-500 dark:text-slate-400">
                <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Cómo está configurado</h3>
                <p>Activador: <b>{estado.setter.activation_enabled ? 'encendido' : 'APAGADO'}</b> · {estado.setter.activation_tags.length} etiquetas activadoras</p>
                <p>Seguimientos: {estado.setter.followups.length ? estado.setter.followups.map((f, i) => `#${i + 1} a las ${f.hours} h`).join(' · ') : 'ninguno'}{estado.setter.followup_ai_check ? ' · con chequeo IA' : ''}</p>
                {(estado.setter.test_mode || estado.setter.test_by_setter) && <p>Modo test: responde solo con «{estado.setter.test_tag}»</p>}
                {estado.setter.required_tags.length > 0 && <p>Requiere: {estado.setter.required_tags.join(', ')}</p>}
                {estado.setter.excluded_tags.length > 0 && <p>Excluye: {estado.setter.excluded_tags.join(', ')}</p>}
                {(!estado.cuenta.ai_enabled || !estado.cuenta.bot_enabled) && <p className="mt-1 font-semibold text-red-600">La conexión tiene IA/bot apagados: no responderá.</p>}
              </Card>
            )}
            {Object.keys(estado.conv.memory || {}).length > 0 && (
              <Card className="p-4">
                <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Memoria</h3>
                <dl className="space-y-1">{Object.entries(estado.conv.memory).map(([k, v]) => <div key={k} className="text-[11px]"><dt className="font-semibold capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt><dd className="text-slate-700 dark:text-slate-300">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>)}</dl>
              </Card>
            )}
          </>
        )}
        {!estado && (
          <Card className="p-4 text-xs text-slate-500 dark:text-slate-400">
            <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Cómo probar un CTA entero</h3>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Crea el lead con «solo comentó» (así verás la ventana de Meta cerrada, que es lo que pasa de verdad) o con «ya escribió».</li>
              <li>Ponle la etiqueta del CTA (p. ej. <code>cta filtro</code>): debe guardarse «lo que pidió».</li>
              <li>Ponle <code>#702-hermes"lm abierto"</code> o <code>#701-hermes"no lm"</code>: se activa con su espera (acelerada) y escribe con ese contexto.</li>
              <li>Escribe como el lead y mira si sigue sabiendo qué pidió.</li>
              <li>Fuerza los seguimientos: deben salir con el contexto y respetar la ventana.</li>
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Laboratorio 2: preguntas sobre lead magnets ─────────────────────────────────────────────
function LabPreguntas({ accountId, opciones, setter }) {
  const [preguntas, setPreguntas] = useState([]);
  const [resultados, setResultados] = useState([]);
  const [running, setRunning] = useState(false);
  const [progreso, setProgreso] = useState('');
  const [error, setError] = useState('');
  const [max, setMax] = useState(6);
  const stopRef = useRef(false);

  // una opción por etiqueta; si dos fichas comparten etiqueta gana la última (misma regla que el motor)
  const tagsCatalogo = useMemo(() => Array.from(new Map(opciones.lead_magnets.flatMap((l) => l.tags.map((t) => [t, { tag: t, name: l.name }]))).values()), [opciones]);

  const sugerir = async () => {
    setError('');
    try { const s = await api.get(`/api/simulador/preguntas/sugeridas?account_id=${accountId}&setter_id=${setter.id}&max=${max}`); setPreguntas(s.map((p) => ({ ...p, on: true }))); setResultados([]); } catch (err) { setError(err.message); }
  };
  const ejecutar = async () => {
    const lista = preguntas.filter((p) => p.on && p.texto.trim());
    if (!lista.length) return;
    setRunning(true); setResultados([]); setError(''); stopRef.current = false;
    const out = [];
    for (let i = 0; i < lista.length && !stopRef.current; i += 3) {
      const lote = lista.slice(i, i + 3);
      setProgreso(`${i}/${lista.length}`);
      try {
        const r = await api.post('/api/simulador/preguntas', { account_id: accountId, setter_id: setter.id, preguntas: lote.map(({ texto, cta_tag, ficha }) => ({ texto, cta_tag, ficha })) });
        out.push(...r); setResultados([...out]);
      } catch (err) { setError(err.message); break; }
    }
    setProgreso(''); setRunning(false);
  };
  const informe = () => {
    const lines = resultados.map((r, i) => `${i + 1}. [${r.cta_tag ? 'CTA ' + r.cta_tag : 'sin CTA'}] «${r.texto}»\n   → ${r.error ? 'ERROR: ' + r.error : (r.mensajes || []).join(' | ')}\n   checks: ${r.checks ? Object.entries(r.checks).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') || '-' : v}`).join(', ') : '-'}`);
    const txt = `Laboratorio de preguntas · ${opciones.account.name} · ${setter.name} · ${new Date().toLocaleString('es-ES')}\n\n${lines.join('\n\n')}`;
    navigator.clipboard?.writeText(txt).catch(() => {});
  };
  const resumen = useMemo(() => {
    const mal = resultados.filter((r) => r.error || (r.checks && (r.checks.pregunta_cual || (r.checks.menciona_otros || []).length > 0))).length;
    return { ok: resultados.length - mal, mal };
  }, [resultados]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="flex h-[72vh] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <Select value={max} onChange={(e) => setMax(Number(e.target.value))} className="!w-24 text-xs" title="Materiales a cubrir">{[3, 6, 10, 15, 20].map((n) => <option key={n} value={n}>{n} LM</option>)}</Select>
          <Button variant="secondary" className="flex-1 !py-1.5 text-xs" onClick={sugerir}>Generar tanda sugerida</Button>
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => setPreguntas((l) => [...l, { texto: '', cta_tag: '', ficha: '', tipo: 'manual', on: true }])} title="Añadir pregunta"><Plus size={14} /></Button>
        </div>
        <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
          {preguntas.length === 0 && <p className="py-8 text-center text-[11px] text-slate-400">Genera la tanda sugerida (con y sin etiqueta de CTA, por cada lead magnet del catálogo) o añade preguntas a mano.</p>}
          {preguntas.map((p, i) => (
            <div key={i} className={`rounded-xl border p-2 text-[11px] ${p.on ? 'border-slate-200 dark:border-slate-700' : 'border-dashed border-slate-200 opacity-50 dark:border-slate-800'}`}>
              <div className="mb-1 flex items-center gap-1.5">
                <input type="checkbox" checked={p.on} onChange={(e) => setPreguntas((l) => l.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <input value={p.texto} onChange={(e) => setPreguntas((l) => l.map((x, j) => (j === i ? { ...x, texto: e.target.value } : x)))} placeholder="Pregunta del lead" className="flex-1 rounded-md border border-slate-200 px-2 py-1 outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-900" />
                <button onClick={() => setPreguntas((l) => l.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500"><Trash2 size={12} /></button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">CTA:</span>
                <select value={p.cta_tag || ''} onChange={(e) => setPreguntas((l) => l.map((x, j) => (j === i ? { ...x, cta_tag: e.target.value, ficha: tagsCatalogo.find((t) => t.tag === e.target.value)?.name || x.ficha } : x)))} className="flex-1 rounded-md border border-slate-200 bg-transparent px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-900">
                  <option value="">sin etiqueta (no sabe qué pidió)</option>
                  {tagsCatalogo.map((t) => <option key={t.tag} value={t.tag}>{t.tag} → {t.name}</option>)}
                </select>
              </div>
              {p.espera && <p className="mt-1 text-slate-400">Esperado: {p.espera}</p>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-slate-100 p-3 dark:border-slate-800">
          <Button className="flex-1 !py-1.5 text-xs" loading={running} disabled={!preguntas.some((p) => p.on && p.texto.trim())} onClick={ejecutar}><Play size={14} /> Ejecutar {preguntas.filter((p) => p.on && p.texto.trim()).length} preguntas {progreso && `(${progreso})`}</Button>
          {running && <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => { stopRef.current = true; }}>Parar</Button>}
        </div>
      </Card>

      <Card className="flex h-[72vh] flex-col lg:col-span-2">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Resultados {resultados.length > 0 && <span className="ml-2 text-[11px] font-normal text-slate-400">{resumen.ok} bien · {resumen.mal} con avisos</span>}</h3>
          {resultados.length > 0 && <Button variant="secondary" className="!px-2.5 !py-1 text-[11px]" onClick={informe}><Copy size={12} /> Copiar informe</Button>}
        </div>
        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
          {error && <Banner tone="error">{error}</Banner>}
          {resultados.length === 0 && !running && <p className="py-12 text-center text-sm text-slate-400">Aquí verás cada respuesta con sus comprobaciones: si menciona el material correcto, si pregunta «¿cuál?», si da enlace o si confunde con otro.</p>}
          {resultados.map((r, i) => {
            const c = r.checks || {};
            const malo = r.error || c.pregunta_cual || (c.menciona_otros || []).length > 0;
            const aviso = !malo && c.menciona_material === false;
            return (
              <div key={i} className={`rounded-xl border p-3 ${malo ? 'border-red-200 bg-red-50/40 dark:border-red-900/60 dark:bg-red-950/20' : aviso ? 'border-amber-200 bg-amber-50/30 dark:border-amber-900/60 dark:bg-amber-950/20' : 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-900/60 dark:bg-emerald-950/20'}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-semibold text-slate-500">#{i + 1}</span>
                  <span className={`rounded-full px-2 py-0.5 ${r.cta_tag ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{r.cta_tag ? `CTA ${r.cta_tag}` : 'sin CTA'}</span>
                  {r.ficha && <span className="text-slate-400">material: {r.ficha}</span>}
                  {r.etiqueta && <StagePill stage={r.etiqueta} className="ml-auto" />}
                </div>
                <p className="mb-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">Lead: «{r.texto}»</p>
                {r.error ? <p className="text-xs text-red-600">Error: {r.error}</p> : (r.mensajes || []).map((m, j) => <p key={j} className="mb-1 rounded-lg bg-white px-2.5 py-1.5 text-xs text-slate-800 shadow-sm dark:bg-slate-800 dark:text-slate-100">{m}</p>)}
                {r.checks && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                    {c.menciona_material !== null && <span className={c.menciona_material ? 'text-emerald-700' : 'text-amber-700'}>{c.menciona_material ? '✓ nombra el material' : '⚠ no lo nombra (lee la respuesta: puede describirlo sin nombrarlo)'}</span>}
                    {c.pregunta_cual && <span className="text-red-600">✗ pregunta «¿cuál?»</span>}
                    {(c.menciona_otros || []).length > 0 && <span className="text-amber-700">⚠ menciona otros: {c.menciona_otros.join(', ')}</span>}
                    {c.da_enlace && <span className="text-slate-500">🔗 da enlace</span>}
                    {c.pide_nombre && <span className="text-slate-500">pide el nombre</span>}
                    {r.handoff && <span className="text-amber-700">🙋 pide humano</span>}
                    {r.motivo && <span className="text-slate-400">· {r.motivo}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {running && <p className="text-center text-xs text-slate-400">Ejecutando… {progreso}</p>}
        </div>
      </Card>
    </div>
  );
}
