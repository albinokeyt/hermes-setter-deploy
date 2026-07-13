import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { Card, SectionTitle, Button, Input, Banner, CopyField } from '../components/ui.jsx';

export default function SettingsPage() {
  const [cfg, setCfg] = useState(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [log, setLog] = useState([]);
  const [showGuide, setShowGuide] = useState(false);

  const load = () => api.get('/api/settings/ghl').then((c) => { setCfg(c); setClientId(c.client_id); }).catch(() => {});
  const loadLog = () => api.get('/api/settings/webhook-log?limit=60').then(setLog).catch(() => {});
  useEffect(() => { load(); loadLog(); }, []);

  if (!cfg) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const save = async () => {
    await api.put('/api/settings/ghl', { client_id: clientId, client_secret: clientSecret || undefined });
    setClientSecret('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    load();
  };

  return (
    <div>
      <SectionTitle title="Configuración" subtitle="Conexión con GoHighLevel y registro de actividad" />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">App de Marketplace de GHL</h3>
              <button onClick={() => setShowGuide(!showGuide)} className="text-xs font-semibold text-violet-600 hover:underline">
                {showGuide ? 'Ocultar guía' : '¿Cómo crear la app? Ver guía'}
              </button>
            </div>

            {showGuide && (
              <div className="space-y-2 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
                <p><b>1.</b> Entra en <b>marketplace.gohighlevel.com</b> → regístrate como developer con tu cuenta de agencia.</p>
                <p><b>2.</b> <b>Create App</b> → tipo <b>Private</b> (no necesita revisión), distribución <b>Sub-Account</b>.</p>
                <p><b>3.</b> En <b>Scopes</b> añade exactamente los de abajo.</p>
                <p><b>4.</b> En <b>Redirect URL</b> pega la Redirect URL de abajo.</p>
                <p><b>5.</b> En <b>Webhooks</b> pega la Webhook URL de abajo y activa los eventos <b>InboundMessage</b> y <b>OutboundMessage</b>.</p>
                <p><b>6.</b> Genera un <b>Client ID</b> y <b>Client Secret</b> (sección Client Keys) y pégalos aquí.</p>
                <p><b>7.</b> Ve a una cuenta en Hermes → pestaña Conexión GHL → «Conectar subcuenta».</p>
              </div>
            )}

            <Input label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="ej. 6683a1b2c3d4-xxxxx" />
            <Input
              label="Client Secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={cfg.client_secret_set ? '••••••••  (guardado — escribir para reemplazar)' : 'pega el secret'}
            />
            <Button onClick={save}>{saved ? '✓ Guardado' : 'Guardar credenciales'}</Button>
          </Card>

          <Card className="space-y-4 p-6">
            <h3 className="text-sm font-bold text-slate-800">URLs para pegar en la app de GHL</h3>
            <CopyField label="Redirect URL (OAuth)" value={cfg.redirect_url} />
            <CopyField label="Webhook URL (eventos de mensajes)" value={cfg.marketplace_webhook_url} />
            <CopyField label="Scopes (cópialos tal cual)" value={cfg.scopes.join(' ')} />
            <div className={`flex items-center gap-2 text-xs font-medium ${cfg.signature_check ? 'text-emerald-600' : 'text-amber-600'}`}>
              {cfg.signature_check ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
              {cfg.signature_check
                ? 'Verificación de firma de webhooks activada (claves oficiales de GHL incluidas)'
                : 'ATENCIÓN: webhooks sin verificar (ALLOW_UNSIGNED_WEBHOOKS=true)'}
            </div>
          </Card>
        </div>

        <Card className="p-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800">Registro de eventos (webhooks)</h3>
            <Button variant="secondary" className="!py-1.5 text-xs" onClick={loadLog}><RefreshCw size={13} /> Actualizar</Button>
          </div>
          <p className="mb-3 text-xs text-slate-400">
            Aquí ves TODO lo que llega de GHL en crudo. Úsalo para validar que Instagram y WhatsApp entran bien antes de activar el bot.
          </p>
          {log.length === 0 ? (
            <Banner tone="info">Aún no ha llegado ningún evento. Manda un DM de prueba a una subcuenta conectada y refresca.</Banner>
          ) : (
            <div className="scroll-thin max-h-[60vh] space-y-2 overflow-y-auto">
              {log.map((l) => (
                <details key={l.id} className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <summary className="cursor-pointer text-xs">
                    <span className={`font-bold ${l.kind.startsWith('error') || l.kind === 'firma_invalida' ? 'text-red-500' : l.kind.includes('recibido') ? 'text-emerald-600' : 'text-slate-600'}`}>
                      {l.kind}
                    </span>
                    <span className="ml-2 text-slate-400">{timeAgo(l.created_at)}</span>
                  </summary>
                  <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded-lg bg-white p-2 text-[10px] leading-relaxed text-slate-600">
                    {JSON.stringify(l.payload, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
