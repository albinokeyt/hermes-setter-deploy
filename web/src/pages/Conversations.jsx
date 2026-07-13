import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, MessagesSquare, Bot, PauseCircle } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { STAGES, CHANNEL_LABEL } from '../stages.js';
import { Card, SectionTitle, StagePill, Avatar, Select, EmptyState } from '../components/ui.jsx';

export default function Conversations() {
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [filters, setFilters] = useState({ account_id: '', stage: '', search: '' });
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.get('/api/accounts').then(setAccounts).catch(() => {}); }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.account_id) params.set('account_id', filters.account_id);
    if (filters.stage) params.set('stage', filters.stage);
    if (filters.search) params.set('search', filters.search);
    const t = setTimeout(() => {
      setLoading(true);
      api.get(`/api/conversations?${params}`).then(setRows).catch(() => {}).finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [filters]);

  return (
    <div>
      <SectionTitle title="Conversaciones" subtitle="Todo lo que está hablando tu setter, en tiempo real" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            placeholder="Buscar lead…"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="w-64 rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
          />
        </div>
        <Select value={filters.account_id} onChange={(e) => setFilters({ ...filters, account_id: e.target.value })} className="!w-48">
          <option value="">Todas las cuentas</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })} className="!w-48">
          <option value="">Todas las etiquetas</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
      </div>

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="Sin conversaciones todavía"
          subtitle="En cuanto un lead escriba por Instagram o WhatsApp a una cuenta conectada, aparecerá aquí."
        />
      ) : (
        <Card className="divide-y divide-slate-50 overflow-hidden">
          {rows.map((c) => (
            <Link key={c.id} to={`/conversaciones/${c.id}`} className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-slate-50/70">
              <Avatar name={c.lead_name || c.channel} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-800">{c.lead_name || 'Lead sin nombre'}</span>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{CHANNEL_LABEL[c.channel] || c.channel}</span>
                  <span className="hidden text-[11px] text-slate-400 sm:inline">· {c.account_name}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {c.last_direction === 'outbound' ? '↩ ' : ''}{c.last_message || '—'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {c.bot_paused
                  ? <span title="Bot en pausa (humano al mando)"><PauseCircle size={16} className="text-amber-500" /></span>
                  : <span title="Bot activo"><Bot size={16} className="text-emerald-500" /></span>}
                <StagePill stage={c.stage} />
                <span className="w-16 text-right text-[11px] text-slate-400">{timeAgo(c.updated_at)}</span>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
