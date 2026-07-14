import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldAlert, ShieldHalf, Wand2 } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { Card, SectionTitle, Button, Input, Textarea, Select, Banner, CopyField } from '../components/ui.jsx';

export default function SettingsPage() {
  const [cfg, setCfg] = useState(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [ssoSecret, setSsoSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [log, setLog] = useState([]);
  const [showGuide, setShowGuide] = useState(false);
  const [prompts, setPrompts] = useState(null);
  const [pSaved, setPSaved] = useState(false);

  const [providers, setProviders] = useState([]);
  const load = () => api.get('/api/settings/ghl').then((c) => { setCfg(c); setClientId(c.client_id); }).catch(() => {});
  const loadLog = () => api.get('/api/settings/webhook-log?limit=60').then(setLog).catch(() => {});
  useEffect(() => { load(); loadLog(); api.get('/api/settings/prompts').then(setPrompts).catch(() => {}); api.get('/api/providers').then(setProviders).catch(() => {}); }, []);

  if (!cfg) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  const save = async () => {
    await api.put('/api/settings/ghl', { client_id: clientId, client_secret: clientSecret || undefined, sso_secret: ssoSecret || undefined });
    setClientSecret('');
    setSsoSecret('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    load();
  };

  const savePrompts = async () => {
    await api.put('/api/settings/prompts', {
      guardrail: prompts.guardrail, architect: prompts.architect,
      architect_provider_id: prompts.architect_provider_id, architect_model: prompts.architect_model,
      corrector_provider_id: prompts.corrector_provider_id, corrector_model: prompts.corrector_model,
    });
    setPSaved(true);
    setTimeout(() => setPSaved(false), 2000);
  };

  return (
    <div>
      <SectionTitle title="Configuración" subtitle="Conexión con GoHighLevel, seguridad de la IA y registro de actividad" />

      {prompts && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3 p-6">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><ShieldHalf size={16} className="text-emerald-600" /> Guardarraíl de seguridad</h3>
            <p className="text-xs text-slate-500">Regla inquebrantable que se aplica a TODOS los setters: evita que inventen datos o actúen como chatbot general. Va por encima de sus prompts.</p>
            <Textarea rows={7} value={prompts.guardrail} onChange={(e) => setPrompts({ ...prompts, guardrail: e.target.value })} />
            <div className="flex gap-2">
              <Button onClick={savePrompts}>{pSaved ? '✓ Guardado' : 'Guardar'}</Button>
              <Button variant="ghost" onClick={() => setPrompts({ ...prompts, guardrail: prompts.guardrail_default })}>Restaurar por defecto</Button>
            </div>
          </Card>
          <Card className="space-y-3 p-6">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Wand2 size={16} className="text-violet-600" /> Arquitecto de prompts</h3>
            <p className="text-xs text-slate-500">El "prompt que ayuda a crear los prompts". Define cómo entrevista la IA arquitecta para armar los 3 bloques de cada setter.</p>
            <Textarea rows={7} value={prompts.architect} onChange={(e) => setPrompts({ ...prompts, architect: e.target.value })} />
            <div className="flex gap-2">
              <Button onClick={savePrompts}>{pSaved ? '✓ Guardado' : 'Guardar'}</Button>
              <Button variant="ghost" onClick={() => setPrompts({ ...prompts, architect: prompts.architect_default })}>Restaurar por defecto</Button>
            </div>
          </Card>

          <Card className="space-y-4 p-6 lg:col-span-2">
            <h3 className="text-sm font-bold text-slate-800">Modelos de IA del arquitecto y del corrector</h3>
            <p className="text-xs text-slate-500">Con qué modelo trabaja cada uno (independiente del modelo de chat de cada setter). Si lo dejas vacío, usa el del setter.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-violet-700">✨ Arquitecto (crea el prompt)</span>
                <Select value={prompts.architect_provider_id || ''} onChange={(e) => setPrompts({ ...prompts, architect_provider_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— del setter —</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input placeholder="modelo (ej. openai/gpt-5.1)" value={prompts.architect_model || ''} onChange={(e) => setPrompts({ ...prompts, architect_model: e.target.value })} />
              </div>
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-violet-700">🛠️ Corrector / ingeniero (ajusta el prompt)</span>
                <Select value={prompts.corrector_provider_id || ''} onChange={(e) => setPrompts({ ...prompts, corrector_provider_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— del setter —</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input placeholder="modelo (ej. openai/gpt-5.1)" value={prompts.corrector_model || ''} onChange={(e) => setPrompts({ ...prompts, corrector_model: e.target.value })} />
              </div>
            </div>
            <Button onClick={savePrompts}>{pSaved ? '✓ Guardado' : 'Guardar modelos'}</Button>
          </Card>
        </div>
      )}

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
            <Input
              label="SSO Shared Secret (para el acceso blindado por Custom Page)"
              type="password"
              value={ssoSecret}
              onChange={(e) => setSsoSecret(e.target.value)}
              placeholder={cfg.sso_secret_set ? '••••••••  (guardado — escribir para reemplazar)' : 'pega el Shared Secret de Advanced Settings'}
              hint="En la app del marketplace → Advanced Settings → Auth → SSO / Shared Secret. Con esto la identidad del usuario la certifica GHL cifrada (no por URL): imposible falsificar."
            />
            <Button onClick={save}>{saved ? '✓ Guardado' : 'Guardar credenciales'}</Button>
          </Card>

          <Card className="space-y-4 p-6">
            <h3 className="text-sm font-bold text-slate-800">🔗 Enlace de agencia (autoservicio)</h3>
            <p className="text-xs text-slate-500">
              Pégalo <b>UNA vez</b> como <b>Custom Menu Link a nivel agencia</b> en GHL: aparece en todas las subcuentas. Al abrirlo, GHL rellena la subcuenta y el usuario, y Hermes decide solo: si la app no está conectada la manda a instalarla, si está conectada pero sin setter lo crea (pide nombre y correo la primera vez), y si ya existe entra a su panel.
            </p>
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              🔒 <b>Acceso automático por usuarios de GHL.</b> Entra solo quien sea usuario de esa subcuenta en GoHighLevel; nadie más. Se administra desde GHL (das de alta/baja al usuario allí). En la pestaña <b>Accesos</b> de cada setter puedes además añadir correos <b>extra</b> que no tengan usuario en GHL. Requiere el scope <b>users.readonly</b> en la app y reconectar las subcuentas.
            </p>
            <CopyField label="Enlace de agencia (pégalo tal cual, con las llaves)" value={cfg.agency_menu_url || ''} />
            <p className="text-xs text-slate-400">Alternativa más estricta: el enlace <b>por setter</b> (en cada setter → Conexión GHL) usa una clave única por subcuenta.</p>
          </Card>

          <Card className="space-y-4 p-6">
            <h3 className="text-sm font-bold text-slate-800">URLs para pegar en la app de GHL</h3>
            <CopyField
              label="Custom Page URL (acceso blindado con SSO)"
              value={cfg.custom_page_url || ''}
              hint="En la app del marketplace → Custom Pages → añade una página con esta URL. El cliente la abre EMBEBIDA dentro de GHL y su identidad se verifica por SSO (no por la URL). Es el acceso recomendado y a prueba de falsificación."
            />
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
