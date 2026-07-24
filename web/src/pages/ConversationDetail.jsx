import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Bot, User, Clock, ExternalLink, Ban, X, Trash2 } from 'lucide-react';
import { api, timeAgo, ghlContactUrl } from '../api.js';
import { STAGES, CHANNEL_LABEL, stageByKey } from '../stages.js';
import { Card, Button, StagePill, Toggle, Select, Banner } from '../components/ui.jsx';

function Bubble({ m }) {
  const mine = m.direction === 'outbound';
  const human = m.source === 'humano';
  const auto = m.source === 'automatizacion'; // workflow de GHL: ni el setter ni una persona
  const sourceLabel = { bot: '🤖 Setter IA', humano: '👤 Humano', automatizacion: '⚙️ Automatización', seguimiento: '🤖 Seguimiento IA', lead: '' }[m.source] || '';
  const bubble = !mine
    ? 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
    : human
      ? 'bg-blue-600 text-white rounded-br-md'   // humano al mando
      : auto
        ? 'bg-sky-700 text-white rounded-br-md'  // automatización de GHL
        : 'bg-violet-600 text-white rounded-br-md'; // agente IA
  const meta = !mine ? 'text-slate-400' : human ? 'text-blue-200' : auto ? 'text-sky-200' : 'text-violet-200';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${bubble}`}>
        {m.body}
        <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${meta}`}>
          {sourceLabel && <span>{sourceLabel} ·</span>}
          <span>{new Date(m.created_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    </div>
  );
}

export default function ConversationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [excluding, setExcluding] = useState(false);
  const bottomRef = useRef(null);

  const load = () => api.get(`/api/conversations/${id}`).then(setConv).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [id]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [conv?.messages?.length]);

  if (!conv) return <div className="py-24 text-center text-sm text-slate-400">{error || 'Cargando…'}</div>;

  const update = async (patch) => { await api.put(`/api/conversations/${id}`, patch); load(); };

  const remove = async () => {
    if (!window.confirm('¿Borrar TODA la conversación (chat, memoria y sesión)? El contacto volverá a entrar como nuevo. No se puede deshacer.')) return;
    await api.del(`/api/conversations/${id}`);
    navigate('/conversaciones');
  };

  const toggleExclude = async (exclude) => {
    setExcluding(true);
    setError('');
    try {
      await api.post(`/api/conversations/${id}/${exclude ? 'exclude' : 'include'}`);
      setExcludeOpen(false);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setExcluding(false);
    }
  };

  const sendManual = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/api/conversations/${id}/send`, { message: text.trim() });
      setText('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <Link to="/conversaciones" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Conversaciones
      </Link>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex h-[70vh] flex-col lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{conv.lead_name || 'Lead sin nombre'}</div>
              <div className="truncate text-xs text-slate-400">
                {conv.account_name} · {CHANNEL_LABEL[conv.channel] || conv.channel}
                {conv.lead_email && ` · ${conv.lead_email}`}
              </div>
              {conv.setter_name && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                  <span className="inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 font-semibold text-violet-600">🤖 Atendida por {conv.setter_name}</span>
                  {conv.messages?.some((m) => m.source === 'humano') && <span className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-600">👤 con intervención humana</span>}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {ghlContactUrl(conv.location_id, conv.ghl_contact_id) && (
                <a
                  href={ghlContactUrl(conv.location_id, conv.ghl_contact_id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Ir al perfil del contacto en GHL"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-violet-300 hover:text-violet-600"
                >
                  Ir a GHL <ExternalLink size={12} />
                </a>
              )}
              <button
                onClick={() => setExcludeOpen(true)}
                title={conv.paused_by === 'excluido' ? 'Este contacto está fuera de las IAs' : 'Sacar a este contacto de las IAs'}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                  conv.paused_by === 'excluido'
                    ? 'border-red-200 bg-red-50 text-red-600'
                    : 'border-slate-200 text-slate-400 hover:border-red-300 hover:text-red-500'
                }`}
              >
                <Ban size={13} /> {conv.paused_by === 'excluido' ? 'Sin IA' : 'IA'}
              </button>
              <StagePill stage={conv.stage} />
            </div>
          </div>
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
            {conv.messages.map((m) => <Bubble key={m.id} m={m} />)}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={sendManual} className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribir como humano (pausa el bot)…"
              className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
            />
            <Button type="submit" loading={sending} className="!px-3.5"><Send size={16} /></Button>
          </form>
        </Card>

        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Card className="space-y-4 p-5">
            <h3 className="text-sm font-semibold text-slate-700">Control</h3>
            <Toggle
              checked={!conv.bot_paused}
              onChange={(v) => update({ bot_paused: !v })}
              label={conv.bot_paused ? 'Bot en pausa' : 'Bot activo'}
              description={conv.bot_paused ? 'Un humano está al mando de este chat' : 'El setter responde automáticamente'}
            />
            <Select label="Etiqueta" value={conv.stage} onChange={(e) => update({ stage: e.target.value })}>
              {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Clock size={13} />
              Último mensaje del lead: {timeAgo(conv.last_inbound_at)}
            </div>
            {conv.followup_state !== 'ninguno' && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Seguimiento: {conv.followup_state.replaceAll('_', ' ')}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Memoria del lead</h3>
            {Object.keys(conv.memory || {}).length === 0 ? (
              <p className="text-xs text-slate-400">El agente aún no ha guardado datos de este lead.</p>
            ) : (
              <dl className="space-y-1.5">
                {Object.entries(conv.memory).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <dt className="font-semibold capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt>
                    <dd className="text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Historial de etiquetas</h3>
            {(conv.stage_history || []).length === 0 ? (
              <p className="text-xs text-slate-400">Sin cambios aún.</p>
            ) : (
              <div className="space-y-2">
                {conv.stage_history.map((h) => (
                  <div key={h.id} className="text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{stageByKey(h.to_stage).label}</span>
                    {h.reason && <span> — {h.reason}</span>}
                    <span className="block text-[10px] text-slate-400">{timeAgo(h.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <button onClick={remove} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 transition hover:text-red-500">
            <Trash2 size={14} /> Borrar conversación (reiniciar para volver a probar)
          </button>
        </div>
      </div>

      {excludeOpen && (() => {
        const excluded = conv.paused_by === 'excluido';
        return (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setExcludeOpen(false)}>
            <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Ban size={16} className="text-red-500" /> {excluded ? 'Volver a las IAs' : 'Sacar de las IAs'}</h3>
                <button onClick={() => setExcludeOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
              </div>
              {excluded ? (
                <p className="text-sm text-slate-600">Se quitará la etiqueta de exclusión de <b>{conv.lead_name || 'este contacto'}</b> en GHL y los setters podrán volver a responderle.</p>
              ) : (
                <p className="text-sm text-slate-600">Le pondremos una etiqueta en GHL a <b>{conv.lead_name || 'este contacto'}</b> para que <b>ningún setter</b> le responda — así el contacto queda fuera de la sección de IAs. El bot se pausa al instante.</p>
              )}
              {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setExcludeOpen(false)}>Cancelar</Button>
                {excluded
                  ? <Button onClick={() => toggleExclude(false)} loading={excluding}>Volver a incluir</Button>
                  : <Button variant="danger" onClick={() => toggleExclude(true)} loading={excluding}><Ban size={15} /> Sacar de las IAs</Button>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
