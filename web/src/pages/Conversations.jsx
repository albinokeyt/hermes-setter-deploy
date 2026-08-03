import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, MessagesSquare, Bot, PauseCircle, ExternalLink, User, Trash2 } from 'lucide-react';
import { api, timeAgo, ghlContactUrl } from '../api.js';
import { STAGES, CHANNEL_LABEL } from '../stages.js';
import { Card, SectionTitle, StagePill, Avatar, Select, EmptyState } from '../components/ui.jsx';

export default function Conversations() {
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [setters, setSetters] = useState([]);
  const [filters, setFilters] = useState({ account_id: '', setter_id: '', stage: '', human: '', search: '' });
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);

  // al elegir una conexión, cargar sus setters para el filtro de agente
  useEffect(() => {
    if (!filters.account_id) { setSetters([]); return; }
    api.get(`/api/accounts/${filters.account_id}/setters`).then(setSetters).catch(() => setSetters([]));
  }, [filters.account_id]);

  const reload = () => {
    const params = new URLSearchParams();
    if (filters.account_id) params.set('account_id', filters.account_id);
    if (filters.setter_id) params.set('setter_id', filters.setter_id);
    if (filters.stage) params.set('stage', filters.stage);
    if (filters.human) params.set('human', filters.human);
    if (filters.search) params.set('search', filters.search);
    setLoading(true);
    api.get(`/api/conversations?${params}`).then(setRows).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(reload, 250);
    return () => clearTimeout(t);
  }, [filters]);

  const remove = async (c, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`¿Borrar la conversación con ${c.lead_name || 'este contacto'}? Chat, memoria y sesión se borran y volverá a entrar como nuevo.`)) return;
    await api.del(`/api/conversations/${c.id}`);
    setRows((rs) => rs.filter((x) => x.id !== c.id));
  };

  return (
    <div>
      <SectionTitle tour="page:conv" title="Conversaciones" subtitle="Todo lo que está hablando tu setter, en tiempo real" />

      <div data-tour="conv-filtros" className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            placeholder="Buscar por nombre o correo…"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="w-64 rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
          />
        </div>
        <Select value={filters.account_id} onChange={(e) => setFilters({ ...filters, account_id: e.target.value, setter_id: '' })} className="!w-44">
          <option value="">Todas las conexiones</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        {filters.account_id && setters.length > 1 && (
          <Select value={filters.setter_id} onChange={(e) => setFilters({ ...filters, setter_id: e.target.value })} className="!w-44">
            <option value="">Todos los setters</option>
            {setters.map((s) => <option key={s.id} value={s.id}>🤖 {s.name}</option>)}
          </Select>
        )}
        <Select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })} className="!w-44">
          <option value="">Todos los status</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
        <Select value={filters.human} onChange={(e) => setFilters({ ...filters, human: e.target.value })} className="!w-44" title="Quién ha hablado">
          <option value="">IA y humano</option>
          <option value="1">👤 Con humano</option>
          <option value="ia">🤖 Solo IA</option>
        </Select>
      </div>

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="Sin conversaciones todavía"
          subtitle="En cuanto un lead escriba por Instagram o WhatsApp a una cuenta conectada, aparecerá aquí."
        />
      ) : (
        <Card data-tour="conv-lista" className="divide-y divide-slate-50 overflow-hidden">
          {rows.map((c) => {
            const ghlUrl = ghlContactUrl(c.location_id, c.ghl_contact_id);
            return (
              <div key={c.id} className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-slate-50/70">
                <Link to={`/conversaciones/${c.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                  <Avatar name={c.lead_name || c.channel} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-800">{c.lead_name || 'Lead sin nombre'}</span>
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{CHANNEL_LABEL[c.channel] || c.channel}</span>
                      {c.lead_email && <span className="hidden truncate text-[11px] text-slate-400 md:inline">· {c.lead_email}</span>}
                      <span className="hidden text-[11px] text-slate-400 sm:inline">· {c.account_name}</span>
                      {c.setter_name && <span className="hidden items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 sm:inline-flex" title="Setter (agente IA) asignado">🤖 {c.setter_name}</span>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {c.last_direction === 'outbound' ? '↩ ' : ''}{c.last_message || '—'}
                    </p>
                  </div>
                </Link>
                <div className="flex shrink-0 items-center gap-3">
                  {ghlUrl && (
                    <a
                      href={ghlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Ir al perfil del contacto en GHL"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-violet-300 hover:text-violet-600"
                    >
                      Ir a <ExternalLink size={12} />
                    </a>
                  )}
                  {c.human_touched && <span title="Un humano ha intervenido en este chat"><User size={15} className="text-blue-500" /></span>}
                  {c.bot_paused
                    ? <span title={c.paused_by === 'humano' ? 'Bot en pausa (humano respondió en GHL)' : 'Bot en pausa (humano al mando)'}><PauseCircle size={16} className="text-amber-500" /></span>
                    : <span title="Bot activo"><Bot size={16} className="text-emerald-500" /></span>}
                  <StagePill stage={c.stage} />
                  <span className="w-16 text-right text-[11px] text-slate-400">{timeAgo(c.updated_at)}</span>
                  <button onClick={(e) => remove(c, e)} title="Borrar conversación (reiniciar)" className="text-slate-300 transition hover:text-red-500">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
