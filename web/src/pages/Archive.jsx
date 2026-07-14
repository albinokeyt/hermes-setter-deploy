import { useEffect, useRef, useState } from 'react';
import { Search, Download, Send, Sparkles, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { api } from '../api.js';
import { CHANNEL_LABEL } from '../stages.js';
import { Card, SectionTitle, Button, Select, Toggle, Banner } from '../components/ui.jsx';

const fmtUsd = (v) => `$${Number(v || 0).toFixed(4)}`;

function fecha(s) {
  const d = new Date(s);
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const QUIEN_CLS = {
  Lead: 'bg-blue-50 text-blue-700',
  'Setter IA': 'bg-violet-50 text-violet-700',
  'Seguimiento IA': 'bg-amber-50 text-amber-700',
  Humano: 'bg-emerald-50 text-emerald-700',
};

export default function Archive() {
  const [accounts, setAccounts] = useState([]);
  const [providers, setProviders] = useState([]);
  const [settings, setSettings] = useState(null);
  const [spend, setSpend] = useState({ d24: 0, d30: 0, total: 0, preguntas: 0 });
  const [filters, setFilters] = useState({ account_id: '', direction: '', search: '' });
  const [data, setData] = useState({ total: 0, messages: [] });
  const [loading, setLoading] = useState(true);

  const [chat, setChat] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const chatEnd = useRef(null);

  useEffect(() => {
    api.get('/api/accounts').then(setAccounts).catch(() => {});
    api.get('/api/providers').then(setProviders).catch(() => {});
    api.get('/api/archive/settings').then(setSettings).catch(() => {});
    loadSpend();
  }, []);

  const loadSpend = () => api.get('/api/archive/spend').then(setSpend).catch(() => {});

  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.account_id) params.set('account_id', filters.account_id);
    if (filters.direction) params.set('direction', filters.direction);
    if (filters.search) params.set('search', filters.search);
    params.set('limit', '150');
    const t = setTimeout(() => {
      setLoading(true);
      api.get(`/api/archive/messages?${params}`).then(setData).catch(() => {}).finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [filters]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat, asking]);

  const saveSettings = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await api.put('/api/archive/settings', next).catch(() => {});
  };

  const download = async () => {
    const params = new URLSearchParams();
    if (filters.account_id) params.set('account_id', filters.account_id);
    if (filters.direction) params.set('direction', filters.direction);
    if (filters.search) params.set('search', filters.search);
    const res = await fetch(`/api/archive/export?${params}`, { credentials: 'same-origin' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mensajes-hermes.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const ask = async (e) => {
    e.preventDefault();
    const qtext = question.trim();
    if (!qtext) return;
    if (!settings?.provider_id) { setAskError('Elige primero un modelo de texto abajo'); return; }
    setAskError('');
    setChat((c) => [...c, { role: 'user', text: qtext }]);
    setQuestion('');
    setAsking(true);
    try {
      const r = await api.post('/api/archive/ask', {
        question: qtext,
        provider_id: settings.provider_id,
        model: settings.model,
        account_id: filters.account_id || undefined,
        direction: filters.direction || undefined,
        search: filters.search || undefined,
      });
      setChat((c) => [...c, { role: 'ai', text: r.answer }]);
      loadSpend();
    } catch (err) {
      setChat((c) => [...c, { role: 'ai', text: `⚠️ ${err.message}` }]);
    } finally {
      setAsking(false);
    }
  };

  const textProviders = providers.filter((p) => !Array.isArray(p.kinds) || p.kinds.includes('text'));

  return (
    <div>
      <SectionTitle
        title="Archivo de mensajes"
        subtitle="Todo lo que entra y sale (IA o humano), con fecha, quién y contenido — y una IA para preguntar sobre ello"
        actions={
          settings && (
            <Toggle
              checked={settings.enabled !== false}
              onChange={(v) => saveSettings({ enabled: v })}
              label={settings.enabled !== false ? 'Recaudación activa' : 'Recaudación en pausa'}
              description={settings.enabled !== false ? 'Guardando todo, esté el bot activo o no' : 'No se guardan mensajes de cuentas con el bot apagado'}
            />
          )
        }
      />

      {settings && settings.enabled === false && (
        <div className="mb-4"><Banner tone="warn">La recaudación está en pausa: no se guardan mensajes nuevos de cuentas con el bot apagado. Las cuentas con bot activo se siguen guardando porque el bot necesita el historial para responder.</Banner></div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Columna mensajes */}
        <div className="lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                placeholder="Buscar en los mensajes…"
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                className="w-60 rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
              />
            </div>
            <Select value={filters.account_id} onChange={(e) => setFilters({ ...filters, account_id: e.target.value })} className="!w-44">
              <option value="">Todas las cuentas</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Select value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })} className="!w-40">
              <option value="">Entrantes y salientes</option>
              <option value="inbound">Solo entrantes</option>
              <option value="outbound">Solo salientes</option>
            </Select>
            <Button variant="secondary" onClick={download}><Download size={15} /> Descargar CSV</Button>
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3 text-xs text-slate-400">
              {loading ? 'Cargando…' : `${data.total.toLocaleString('es-ES')} mensajes en total · mostrando ${data.messages.length}`}
            </div>
            <div className="scroll-thin max-h-[64vh] overflow-y-auto divide-y divide-slate-50">
              {data.messages.map((m) => (
                <div key={m.id} className="px-5 py-3">
                  <div className="mb-1 flex items-center gap-2 text-[11px]">
                    {m.direction === 'inbound'
                      ? <ArrowDownToLine size={13} className="text-blue-500" />
                      : <ArrowUpFromLine size={13} className="text-emerald-500" />}
                    <span className={`rounded-md px-1.5 py-0.5 font-semibold ${QUIEN_CLS[m.quien] || 'bg-slate-100 text-slate-600'}`}>{m.quien}</span>
                    <span className="text-slate-400">{m.account_name} · {m.lead_name || m.ghl_contact_id} · {CHANNEL_LABEL[m.channel] || m.channel}</span>
                    <span className="ml-auto text-slate-400">{fecha(m.created_at)}</span>
                  </div>
                  <p className="text-sm text-slate-700">{m.body}</p>
                </div>
              ))}
              {!loading && data.messages.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-400">Sin mensajes con esos filtros</p>}
            </div>
          </Card>
        </div>

        {/* Columna IA */}
        <div className="lg:col-span-1">
          <Card className="sticky top-6 flex h-[76vh] flex-col">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800"><Sparkles size={16} className="text-violet-600" /> Pregunta sobre tus mensajes</div>
              <p className="mt-0.5 text-[11px] text-slate-400">Responde según los mensajes filtrados a la izquierda.</p>
            </div>

            <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-4 py-3">
              {chat.length === 0 && (
                <p className="py-10 text-center text-xs text-slate-400">
                  Prueba: "¿Cuáles son las objeciones más comunes?", "¿Cuántos preguntaron el precio?", "Resume los últimos leads descartados"
                </p>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.role === 'user' ? 'rounded-br-md bg-violet-600 text-white' : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {asking && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-violet-100 px-3.5 py-3">
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                  </div>
                </div>
              )}
              <div ref={chatEnd} />
            </div>

            <div className="border-t border-slate-100 p-3 space-y-2">
              {askError && <Banner tone="error">{askError}</Banner>}
              <div className="grid grid-cols-2 gap-2">
                <Select value={settings?.provider_id || ''} onChange={(e) => saveSettings({ provider_id: e.target.value ? Number(e.target.value) : null })} className="!py-2 text-xs">
                  <option value="">Modelo de IA…</option>
                  {textProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <input
                  value={settings?.model || ''}
                  onChange={(e) => saveSettings({ model: e.target.value })}
                  placeholder="modelo (opcional)"
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-violet-400"
                />
              </div>
              <form onSubmit={ask} className="flex items-center gap-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Pregunta a la IA…"
                  className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
                />
                <Button type="submit" className="!px-3.5" loading={asking}><Send size={16} /></Button>
              </form>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Gasto de esta sección (aparte del panel):</span>
                <span className="font-semibold text-slate-600">{fmtUsd(spend.total)} · {spend.preguntas} preguntas</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
