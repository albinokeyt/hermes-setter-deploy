import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Building2, Link2, Link2Off, ChevronRight, Bot, Settings2 } from 'lucide-react';
import { api } from '../api.js';
import { CHANNEL_LABEL } from '../stages.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Select, Toggle, EmptyState, Banner } from '../components/ui.jsx';

export default function Accounts() {
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const [accounts, setAccounts] = useState([]);
  const [open, setOpen] = useState({});          // accountId -> bool
  const [setters, setSetters] = useState({});     // accountId -> [setters]
  const [connForm, setConnForm] = useState(false);
  const [connInfo, setConnInfo] = useState(false);
  const [setterForm, setSetterForm] = useState(false);
  const [name, setName] = useState('');
  const [connFor, setConnFor] = useState(null);   // accountId para "nuevo setter"
  const [loading, setLoading] = useState(false);

  const loadAccounts = () => api.get('/api/accounts').then(setAccounts).catch(() => {});
  useEffect(() => { loadAccounts(); }, []);

  const loadSetters = (accId) => api.get(`/api/accounts/${accId}/setters`).then((r) => setSetters((m) => ({ ...m, [accId]: r }))).catch(() => {});
  const toggle = (accId) => {
    setOpen((o) => ({ ...o, [accId]: !o[accId] }));
    if (!setters[accId]) loadSetters(accId);
  };

  const createConn = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const acc = await api.post('/api/accounts', { name: name.trim() });
      navigate(`/cuentas/${acc.id}?conectada=`); // lleva a conectar GHL
    } finally { setLoading(false); }
  };

  const createSetter = async (e) => {
    e.preventDefault();
    const accId = connFor || accounts[0]?.id;
    if (!accId || !name.trim()) return;
    setLoading(true);
    try {
      const st = await api.post(`/api/accounts/${accId}/setters`, { name: name.trim() });
      navigate(`/setters/${st.id}`);
    } finally { setLoading(false); }
  };

  const toggleTest = async (acc, v) => {
    setAccounts((list) => list.map((a) => (a.id === acc.id ? { ...a, test_mode: v } : a)));
    try { await api.put(`/api/accounts/${acc.id}`, { test_mode: v }); } catch { loadAccounts(); }
  };

  const toggleAi = async (acc, v) => {
    setAccounts((list) => list.map((a) => (a.id === acc.id ? { ...a, ai_enabled: v } : a)));
    try { await api.put(`/api/accounts/${acc.id}`, { ai_enabled: v }); } catch { loadAccounts(); }
  };

  const openSetterForm = (accId) => { setConnFor(accId); setName(''); setSetterForm(true); setConnForm(false); };

  // 🏆 de la batalla: mejor tasa de agenda (o de conversión) entre setters con leads.
  const winnerOf = (list) => {
    const w = (list || []).filter((s) => s.leads > 0);
    if (w.length < 2) return null;
    const key = w.some((s) => s.tasa_agenda > 0) ? 'tasa_agenda' : w.some((s) => s.tasa_conversion > 0) ? 'tasa_conversion' : null;
    return key ? w.reduce((b, s) => (s[key] > b[key] ? s : b)).id : null;
  };

  return (
    <div>
      <SectionTitle
        title={isAdmin ? 'Conexiones' : 'Mis agentes'}
        subtitle={isAdmin ? 'Cada conexión es una subcuenta de GHL. Dentro viven sus setters (bots), que se reparten los leads por etiqueta.' : 'Cada conexión es una de tus subcuentas de GHL. Dentro creas y configuras tus setters (agentes).'}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => { setSetterForm(true); setConnForm(false); setConnFor(null); setName(''); }} disabled={!accounts.length}><Bot size={16} /> Nuevo setter</Button>
            <Button onClick={() => { if (isAdmin) { setConnForm(true); setSetterForm(false); setName(''); } else { setConnInfo(true); } }}><Plus size={16} /> Nueva conexión</Button>
          </div>
        }
      />

      {connInfo && !isAdmin && (
        <Card className="mb-5 p-5">
          <Banner tone="info">
            Para añadir otra subcuenta de GHL, <b>abre Hermes desde esa subcuenta</b> en GoHighLevel (el mismo menú/página por el que entraste aquí). Se creará su conexión automáticamente y aparecerá en esta lista.
          </Banner>
          <div className="mt-3"><Button variant="ghost" onClick={() => setConnInfo(false)}>Entendido</Button></div>
        </Card>
      )}

      {connForm && (
        <Card className="mb-5 p-5">
          <form onSubmit={createConn} className="flex items-end gap-3">
            <div className="flex-1"><Input label="Nombre de la conexión (cliente / subcuenta)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Albatros" autoFocus /></div>
            <Button type="submit" loading={loading}>Crear y conectar GHL</Button>
            <Button variant="ghost" type="button" onClick={() => setConnForm(false)}>Cancelar</Button>
          </form>
        </Card>
      )}

      {setterForm && (
        <Card className="mb-5 p-5">
          <form onSubmit={createSetter} className="flex items-end gap-3">
            <div className="w-64">
              <Select label="Conexión" value={connFor || accounts[0]?.id || ''} onChange={(e) => setConnFor(Number(e.target.value))}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.name}</option>)}
              </Select>
            </div>
            <div className="flex-1"><Input label="Nombre del setter" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Ventas high-ticket" autoFocus /></div>
            <Button type="submit" loading={loading}>Crear</Button>
            <Button variant="ghost" type="button" onClick={() => setSetterForm(false)}>Cancelar</Button>
          </form>
        </Card>
      )}

      {accounts.length === 0 && !connForm ? (
        <EmptyState icon={Building2} title="Aún no tienes conexiones" subtitle="Crea una conexión por cada subcuenta de GHL; dentro pondrás sus setters." action={<Button onClick={() => setConnForm(true)}><Plus size={16} /> Crear la primera</Button>} />
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => {
            const connected = a.mode === 'pit' ? Boolean(a.pit_token) : a.oauth_connected;
            const isOpen = open[a.id];
            const list = setters[a.id];
            return (
              <Card key={a.id} className="overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <button onClick={() => toggle(a.id)} className="flex flex-1 items-center gap-3 text-left">
                    <ChevronRight size={18} className={`shrink-0 text-slate-400 transition ${isOpen ? 'rotate-90' : ''}`} />
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Building2 size={17} /></span>
                    <span>
                      <span className="block text-sm font-bold text-slate-900">{a.alias || a.name}</span>
                      <span className="flex items-center gap-1.5 text-xs text-slate-400">
                        {connected ? <Link2 size={12} className="text-emerald-500" /> : <Link2Off size={12} className="text-amber-500" />}
                        {connected ? `GHL conectado${a.location_id ? ` · ${a.location_id.slice(0, 8)}…` : ''}` : 'Sin conectar a GHL'}
                      </span>
                    </span>
                  </button>
                  <div className="hidden gap-1 sm:flex">
                    {(a.channels || []).map((ch) => <span key={ch} className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{CHANNEL_LABEL[ch] || ch}</span>)}
                  </div>
                  <div className="flex items-center gap-3">
                    {isAdmin ? (
                      <button
                        onClick={() => toggleAi(a, !a.ai_enabled)}
                        title={a.ai_enabled ? 'IA activada: los setters responden y el cliente ve la configuración' : 'IA apagada: el cliente solo ve mensajes; los setters no responden'}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${a.ai_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}
                      >
                        {a.ai_enabled ? '🤖 IA activa' : '🤖 IA apagada'}
                      </button>
                    ) : (
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${a.ai_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                        {a.ai_enabled ? '🤖 IA activa' : '🤖 IA pendiente'}
                      </span>
                    )}
                    <Toggle checked={a.test_mode} onChange={(v) => toggleTest(a, v)} label="🧪 Test" />
                    <Link to={`/cuentas/${a.id}`} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"><Settings2 size={14} /> Conexión</Link>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                    {a.test_mode && <div className="mb-3"><Banner tone="warn">🧪 Modo test: los setters de esta conexión solo responden a contactos con la etiqueta <b>{a.test_tag || 'hermes-test'}</b>.</Banner></div>}
                    {!list ? (
                      <div className="py-4 text-center text-xs text-slate-400">Cargando setters…</div>
                    ) : (
                      <div className="space-y-2">
                        {(() => { const winId = winnerOf(list); return list.map((st) => (
                          <Link key={st.id} to={`/setters/${st.id}`} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 transition hover:border-violet-300">
                            <span className={`h-2 w-2 rounded-full ${st.bot_enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                            <span className="flex-1">
                              <span className="text-sm font-semibold text-slate-800">
                                {st.id === winId && <span title="Va ganando la batalla">🏆 </span>}{st.name}
                                {st.is_default && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">principal</span>}
                              </span>
                              <span className="ml-2 text-xs text-slate-400">{st.provider_name || 'sin IA'}{(st.required_tags || []).length ? ` · 🏷️ ${st.required_tags.join(', ')}` : ''}</span>
                            </span>
                            <span className="hidden text-right text-xs text-slate-400 sm:block">
                              <span className="font-semibold text-slate-600">{st.leads}</span> leads · <span className="font-semibold text-emerald-600">{st.agendados}</span> agendas ({st.tasa_agenda}%)
                              {(isAdmin ? st.gasto : st.facturado) > 0 && <span> · ${(isAdmin ? st.gasto : st.facturado).toFixed(2)}</span>}
                            </span>
                            <ChevronRight size={15} className="text-slate-300" />
                          </Link>
                        )); })()}
                        <Button variant="ghost" className="!text-violet-600" onClick={() => openSetterForm(a.id)}><Plus size={15} /> Nuevo setter en esta conexión</Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
