import { useEffect, useRef, useState } from 'react';
import { Send, RotateCcw, FlaskConical, Wand2, X } from 'lucide-react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Select, StagePill, Banner, EmptyState } from '../components/ui.jsx';
import { PromptArchitect } from '../components/PromptArchitect.jsx';

export default function Playground() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [history, setHistory] = useState([]);
  const [memory, setMemory] = useState({});
  const [importOpen, setImportOpen] = useState(false);
  const [meta, setMeta] = useState(null);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const timerRef = useRef(null);
  const historyRef = useRef([]);
  historyRef.current = history;
  const memoryRef = useRef({});
  memoryRef.current = memory;

  useEffect(() => {
    api.get('/api/accounts').then((a) => { setAccounts(a); if (a[0]) setAccountId(String(a[0].id)); }).catch(() => {});
    return () => clearTimeout(timerRef.current);
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, thinking]);

  const askBot = async () => {
    setThinking(true);
    setError('');
    try {
      const r = await api.post('/api/playground/reply', { account_id: Number(accountId), history: historyRef.current, memory: memoryRef.current });
      setMemory(r.memoria_final || {});
      setMeta({ etiqueta: r.etiqueta, motivo: r.motivo, handoff: r.handoff });
      for (let i = 0; i < r.mensajes.length; i++) {
        await new Promise((res) => setTimeout(res, Math.min(r.delays?.[i] || 1500, 3500)));
        setHistory((h) => [...h, { role: 'bot', text: r.mensajes[i] }]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setThinking(false);
    }
  };

  const sendLead = (e) => {
    e.preventDefault();
    if (!text.trim() || !accountId) return;
    setHistory((h) => [...h, { role: 'lead', text: text.trim() }]);
    setText('');
    // simula el debounce real: espera por si escribes más mensajes seguidos
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(askBot, 4000);
  };

  const reset = () => { clearTimeout(timerRef.current); setHistory([]); setMemory({}); setMeta(null); setError(''); };

  if (accounts.length === 0) {
    return (
      <div>
        <SectionTitle title="Probar agente" subtitle="Simula ser un lead y mira cómo responde tu setter" />
        <EmptyState icon={FlaskConical} title="Primero crea una cuenta" subtitle="Necesitas una cuenta con prompt y proveedor de IA configurados para probar el agente." />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle
        title="Probar agente"
        subtitle="Escribe como si fueras el lead. El bot espera unos segundos (debounce real) y responde en varios mensajes."
        actions={
          <div className="flex items-center gap-2">
            <Select value={accountId} onChange={(e) => { setAccountId(e.target.value); reset(); }} className="!w-56">
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Button variant="secondary" onClick={reset}><RotateCcw size={15} /> Reiniciar</Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex h-[65vh] flex-col lg:col-span-2">
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
            {history.length === 0 && (
              <p className="py-16 text-center text-sm text-slate-400">
                Escribe abajo como lead. Prueba a mandar varios mensajes seguidos<br />("hola" … "quería info") y verás que responde a todo junto 😉
              </p>
            )}
            {history.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'bot' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                  m.role === 'bot' ? 'rounded-br-md bg-violet-600 text-white' : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-end">
                <div className="flex items-center gap-1 rounded-2xl rounded-br-md bg-violet-100 px-4 py-3">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={sendLead} className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribe como el lead…"
              className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
            />
            <Button type="submit" className="!px-3.5"><Send size={16} /></Button>
          </form>
        </Card>

        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Decisión del agente</h3>
            {meta ? (
              <div className="space-y-2.5">
                <StagePill stage={meta.etiqueta || 'nuevo'} />
                {meta.motivo && <p className="text-xs text-slate-500">{meta.motivo}</p>}
                {meta.handoff && <Banner tone="warn">El agente pidió pasar a un humano</Banner>}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Habla con el bot y aquí verás qué etiqueta decide y por qué.</p>
            )}
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Memoria que va construyendo</h3>
            {Object.keys(memory).length === 0 ? (
              <p className="text-xs text-slate-400">Vacía. Cuéntale cosas (tu nombre, tu negocio…) y mira cómo las guarda.</p>
            ) : (
              <dl className="space-y-1.5">
                {Object.entries(memory).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <dt className="font-semibold capitalize text-slate-500">{k.replaceAll('_', ' ')}</dt>
                    <dd className="text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">Ajustar el prompt</h3>
            <p className="mb-3 text-xs text-slate-400">¿Ves algo que mejorar mientras pruebas? Dile los cambios (con imágenes si quieres) y los aplica a los 3 bloques.</p>
            <Button variant="secondary" className="w-full" onClick={() => setImportOpen(true)} disabled={!accountId}>
              <Wand2 size={15} /> Importar cambio
            </Button>
          </Card>
        </div>
      </div>

      {importOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setImportOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Wand2 size={16} className="text-violet-600" /> Importar cambio al prompt</h3>
              <button onClick={() => setImportOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="p-3">
              <PromptArchitect accountId={accountId} mode="edit" compact onApplied={() => { /* prompts guardados en el setter */ }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
