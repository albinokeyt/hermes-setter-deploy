import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, ExternalLink, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { CHANNELS, CHANNEL_LABEL } from '../stages.js';
import { useMe } from '../components/Layout.jsx';
import { Card, SectionTitle, Button, Input, Textarea, Select, Toggle, Banner, CopyField } from '../components/ui.jsx';

const TABS = [
  { key: 'prompt', label: 'Prompt' },
  { key: 'ia', label: 'IA', adminOnly: true },
  { key: 'comportamiento', label: 'Comportamiento' },
  { key: 'seguimientos', label: 'Seguimientos' },
  { key: 'conexion', label: 'Conexión GHL', adminOnly: true },
];

export default function AccountEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = me?.role === 'admin';
  const tabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('conectada') ? 'conexion' : 'prompt');
  const [acc, setAcc] = useState(null);
  const [providers, setProviders] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/api/accounts/${id}`).then(setAcc).catch((e) => setError(e.message));
    api.get('/api/providers').then(setProviders).catch(() => {});
  }, [id]);

  if (!acc) return <div className="py-24 text-center text-sm text-slate-400">{error || 'Cargando…'}</div>;

  const set = (patch) => setAcc({ ...acc, ...patch });
  const providersFor = (kind) => providers.filter((p) => !Array.isArray(p.kinds) || p.kinds.includes(kind));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { ...acc };
      delete body.webhook_url; delete body.webhook_token; delete body.oauth_connected; delete body.provider_name;
      const updated = await api.put(`/api/accounts/${id}`, body);
      setAcc({ ...acc, ...updated });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const connectOauth = async () => {
    try {
      const { url } = await api.get(`/api/oauth/url?account_id=${id}`);
      window.location.href = url;
    } catch (err) {
      setError(err.message);
    }
  };

  const followups = Array.isArray(acc.followups) ? acc.followups : [];
  const activeHours = acc.active_hours || { always: true, start: '09:00', end: '21:00' };

  return (
    <div>
      {isAdmin && (
        <Link to="/cuentas" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> Cuentas
        </Link>
      )}
      <SectionTitle
        title={isAdmin ? acc.name : `Mi agente · ${acc.name}`}
        subtitle={isAdmin ? (acc.location_id ? `Subcuenta GHL: ${acc.location_id}` : 'Todavía sin subcuenta de GHL conectada') : 'El prompt, comportamiento y seguimientos de tu setter'}
        actions={
          <div className="flex items-center gap-3">
            <Toggle checked={acc.bot_enabled} onChange={(v) => set({ bot_enabled: v })} label={acc.bot_enabled ? 'Bot activo' : 'Bot apagado'} />
            <Button onClick={save} loading={saving}>{saved ? '✓ Guardado' : 'Guardar cambios'}</Button>
          </div>
        }
      />

      {error && <div className="mb-4"><Banner tone="error">{error}</Banner></div>}
      {searchParams.get('error') && <div className="mb-4"><Banner tone="error">{searchParams.get('error')}</Banner></div>}
      {searchParams.get('conectada') && <div className="mb-4"><Banner tone="ok">Subcuenta conectada por OAuth correctamente 🎉</Banner></div>}
      {acc.test_mode && (
        <div className="mb-4">
          <Banner tone="warn">
            🧪 <b>Modo test activo</b>: el bot solo responde a contactos de GHL con la etiqueta <b>{acc.test_tag || 'hermes-test'}</b>. Los demás leads no reciben respuesta.
          </Banner>
        </div>
      )}

      <div className="mb-5 flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'prompt' && (
        <div className="space-y-4">
          <Banner tone="info">
            El prompt se divide en 3 partes, como ya trabajas tus setters. El agente las combina con la memoria del lead y las reglas de humanización (2-3 mensajes, tono natural) automáticamente.
          </Banner>
          <Card className="p-5">
            <Textarea
              label="1 · Identidad y personalidad"
              hint="Quién es el setter: nombre, tono, forma de escribir, qué haría y qué jamás diría."
              rows={8}
              value={acc.prompt_identity}
              onChange={(e) => set({ prompt_identity: e.target.value })}
              placeholder="Eres Sofía, setter del centro..."
            />
          </Card>
          <Card className="p-5">
            <Textarea
              label="2 · Negocio y oferta"
              hint="Qué se vende, a quién, precios, beneficios, preguntas frecuentes, enlaces permitidos."
              rows={8}
              value={acc.prompt_business}
              onChange={(e) => set({ prompt_business: e.target.value })}
              placeholder="El negocio es..."
            />
          </Card>
          <Card className="p-5">
            <Textarea
              label="3 · Flujo y objetivo"
              hint="El paso a paso de la conversación: cómo cualificar, qué filtro aplicar, cuál es el objetivo (agendar, mandar link…) y cuándo considerar al lead calificado, en conversión o descartado."
              rows={8}
              value={acc.prompt_flow}
              onChange={(e) => set({ prompt_flow: e.target.value })}
              placeholder="1. Saluda y conecta... 2. Cualifica con... 3. Si cumple el filtro, propone..."
            />
          </Card>
        </div>
      )}

      {tab === 'ia' && (
        <div className="max-w-2xl space-y-4">
          {providers.length === 0 && <Banner tone="warn">Aún no tienes APIs. Créalas en la sección <b>APIs de IA</b> y marca de qué tipo es cada una (texto, imagen, audio).</Banner>}

          <Card className="space-y-5 p-6">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">💬 API de texto (el chat del agente)</div>
            <Select
              label="Proveedor de texto"
              value={acc.provider_id || ''}
              onChange={(e) => set({ provider_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— Elige una API de texto —</option>
              {providersFor('text').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Input
              label="Modelo"
              value={acc.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="vacío = modelo por defecto del proveedor"
              hint="Ej.: google/gemini-2.5-flash-lite (OpenRouter) · gemini-2.5-flash-lite (Gemini directo)"
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={`Temperatura: ${acc.temperature}`}
                type="range" min="0" max="1.5" step="0.1"
                value={acc.temperature}
                onChange={(e) => set({ temperature: Number(e.target.value) })}
                className="!p-0 accent-violet-600"
                hint="Más alta = más creativo y variado"
              />
              <Select label="Máximo de mensajes por respuesta" value={acc.max_msgs} onChange={(e) => set({ max_msgs: Number(e.target.value) })}>
                <option value={2}>2 mensajes</option>
                <option value={3}>3 mensajes</option>
                <option value={4}>4 mensajes</option>
              </Select>
            </div>
          </Card>

          <Card className="space-y-4 p-6">
            <Toggle
              checked={acc.vision_enabled}
              onChange={(v) => set({ vision_enabled: v })}
              label="👁️ API de imagen (leer fotos y capturas)"
              description="Cuando el lead envía una imagen, el agente la lee y la usa en la conversación"
            />
            {acc.vision_enabled && (
              <div className="grid grid-cols-2 gap-4 pl-1">
                <Select label="Proveedor de imagen" value={acc.vision_provider_id || ''} onChange={(e) => set({ vision_provider_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— Elige una API de imagen —</option>
                  {providersFor('image').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input label="Modelo de imagen" value={acc.vision_model} onChange={(e) => set({ vision_model: e.target.value })} placeholder="google/gemini-2.5-flash" hint="Debe aceptar imágenes" />
              </div>
            )}
          </Card>

          <Card className="space-y-4 p-6">
            <Toggle
              checked={acc.audio_enabled}
              onChange={(v) => set({ audio_enabled: v })}
              label="🎤 API de audio (transcribir notas de voz)"
              description="Convierte las notas de voz del lead en texto para que el agente las entienda"
            />
            {acc.audio_enabled && (
              <div className="grid grid-cols-2 gap-4 pl-1">
                <Select label="Proveedor de audio" value={acc.audio_provider_id || ''} onChange={(e) => set({ audio_provider_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— Elige una API de audio —</option>
                  {providersFor('audio').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input label="Modelo de audio (Whisper)" value={acc.audio_model} onChange={(e) => set({ audio_model: e.target.value })} placeholder="openai/whisper-large-v3-turbo" hint="Endpoint /audio/transcriptions (OpenRouter, Groq u OpenAI)" />
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'comportamiento' && (
        <Card className="max-w-2xl space-y-6 p-6">
          <div>
            <Input
              label={`Espera antes de responder (debounce): ${acc.debounce_seconds} segundos`}
              type="range" min="10" max="120" step="5"
              value={acc.debounce_seconds}
              onChange={(e) => set({ debounce_seconds: Number(e.target.value) })}
              className="!p-0 accent-violet-600"
              hint='Si el lead escribe "hola" y luego "cómo estás", el bot espera este tiempo de silencio y responde a TODO junto, como una persona.'
            />
          </div>
          {isAdmin && <div>
            <span className="mb-2 block text-sm font-medium text-slate-700">Canales activos</span>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((ch) => {
                const active = (acc.channels || []).includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => set({ channels: active ? acc.channels.filter((c) => c !== ch) : [...(acc.channels || []), ch] })}
                    className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                      active ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {CHANNEL_LABEL[ch]}
                  </button>
                );
              })}
            </div>
          </div>}
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle
              checked={!(activeHours.always !== false)}
              onChange={(v) => set({ active_hours: { ...activeHours, always: !v } })}
              label="Limitar horario de respuesta"
              description="Fuera del horario, el bot espera a la próxima apertura para contestar"
            />
            {activeHours.always === false && (
              <div className="grid grid-cols-3 gap-3">
                <Input label="Desde" type="time" value={activeHours.start || '09:00'} onChange={(e) => set({ active_hours: { ...activeHours, start: e.target.value } })} />
                <Input label="Hasta" type="time" value={activeHours.end || '21:00'} onChange={(e) => set({ active_hours: { ...activeHours, end: e.target.value } })} />
                <Input label="Zona horaria" value={acc.timezone} onChange={(e) => set({ timezone: e.target.value })} hint="Ej.: Europe/Madrid" />
              </div>
            )}
          </div>
          <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <Toggle
              checked={acc.test_mode}
              onChange={(v) => set({ test_mode: v })}
              label="🧪 Modo test"
              description="El bot SOLO responde a contactos de GHL que tengan la etiqueta de prueba"
            />
            {acc.test_mode && (
              <Input
                label="Etiqueta de prueba (tag de GHL)"
                value={acc.test_tag || ''}
                onChange={(e) => set({ test_tag: e.target.value })}
                placeholder="hermes-test"
                hint="Añade este tag a tu contacto en la subcuenta de GHL y chatéale por Instagram/WhatsApp: solo los contactos con el tag reciben respuesta. Quita el modo test cuando quieras encender el bot para todos."
              />
            )}
          </div>
          {isAdmin && <div className="space-y-4 border-t border-slate-100 pt-5">
            <Toggle
              checked={acc.auto_handoff}
              onChange={(v) => set({ auto_handoff: v })}
              label="Pausar bot si un humano interviene"
              description="Si alguien responde manualmente desde GHL, el bot se aparta solo en ese chat"
            />
            <Toggle
              checked={acc.sync_tags}
              onChange={(v) => set({ sync_tags: v })}
              label="Sincronizar etiquetas con GHL"
              description='Añade tags "setter-calificado", "setter-descartado", etc. al contacto en GHL'
            />
          </div>}
        </Card>
      )}

      {tab === 'seguimientos' && (
        <div className="max-w-2xl space-y-4">
          <Banner tone="info">
            Si el lead deja de responder, el setter retoma la conversación solo. Cada paso se cancela automáticamente si el lead contesta. Ojo: Instagram y WhatsApp solo permiten responder dentro de las 24 h del último mensaje del lead — los seguimientos que caigan fuera se marcan como «ventana cerrada».
          </Banner>
          {followups.map((f, i) => (
            <Card key={i} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-bold text-slate-800">Seguimiento #{i + 1}</span>
                <button onClick={() => set({ followups: followups.filter((_, j) => j !== i) })} className="text-slate-400 hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                <Input
                  label="Horas de espera"
                  type="number" min="1" max="23" step="0.5"
                  value={f.hours}
                  onChange={(e) => set({ followups: followups.map((x, j) => (j === i ? { ...x, hours: Number(e.target.value) } : x)) })}
                  hint="máx. 23 h (ventana Meta)"
                />
                <Textarea
                  label="Instrucción para la IA"
                  rows={2}
                  value={f.instruction || ''}
                  onChange={(e) => set({ followups: followups.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)) })}
                  placeholder="Ej.: Retoma con algo del último tema, pregunta ligera, cero presión."
                />
              </div>
            </Card>
          ))}
          <Button
            variant="secondary"
            onClick={() => set({ followups: [...followups, { hours: 4, instruction: '' }] })}
            disabled={followups.length >= 5}
          >
            <Plus size={16} /> Añadir seguimiento
          </Button>
        </div>
      )}

      {tab === 'conexion' && (
        <div className="max-w-2xl space-y-4">
          <Card className="space-y-4 p-6">
            <Select label="Modo de conexión" value={acc.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="oauth">App de Marketplace (OAuth) — recomendado</option>
              <option value="pit">Token privado (PIT) + Workflow — sin app</option>
            </Select>

            {acc.mode === 'oauth' ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-500">
                  Con la app privada de marketplace configurada (sección Configuración), instala la app en la subcuenta del cliente y todo queda conectado: recepción de mensajes y envío.
                </p>
                {acc.oauth_connected ? (
                  <Banner tone="ok">✓ Subcuenta <b>{acc.location_id}</b> conectada por OAuth. Mensajería lista.</Banner>
                ) : (
                  <Button onClick={connectOauth}><Sparkles size={16} /> Conectar subcuenta de GHL</Button>
                )}
                <CopyField
                  label="Plan B — webhook por workflow (recepción alternativa)"
                  value={acc.webhook_url || ''}
                  hint='Si el webhook de la app de marketplace no entrega mensajes, crea en la subcuenta un workflow: Trigger "Customer Replied" → Action "Custom Webhook" (POST) a esta URL con customData: contact_id = {{contact.id}}, message = {{message.body}}, channel = {{message.type}}. Desactívalo cuando el webhook de la app funcione (si no, los mensajes entrarían duplicados).'
                />
                <CopyField
                  label="Enlace del portal para el cliente (Custom Menu Link de GHL)"
                  value={acc.portal_url || ''}
                  hint="Pégalo en GHL como Custom Menu Link de ESTA subcuenta. El cliente entra directo a su panel (Mi agente, conversaciones, dashboard) sin contraseña. Es único por cuenta: no sirve para otra."
                />
              </div>
            ) : (
              <div className="space-y-4">
                <Input
                  label="Location ID de la subcuenta"
                  value={acc.location_id || ''}
                  onChange={(e) => set({ location_id: e.target.value.trim() })}
                  hint="En GHL: Settings → Business Profile de la subcuenta"
                />
                <Input
                  label="Private Integration Token (PIT)"
                  type="password"
                  value={acc.pit_token || ''}
                  onChange={(e) => set({ pit_token: e.target.value.trim() })}
                  hint="En la subcuenta: Settings → Private Integrations → crear con scopes de conversations, contacts y locations"
                />
                <CopyField
                  label="URL de webhook para el workflow de GHL"
                  value={acc.webhook_url || ''}
                  hint='En la subcuenta crea un workflow: Trigger "Customer Replied" → Action "Custom Webhook" (POST) a esta URL, con customData: contact_id = {{contact.id}}, message = {{message.body}}, channel = {{message.type}}'
                />
              </div>
            )}
          </Card>

          <Card className="p-6">
            <h3 className="mb-2 text-sm font-bold text-red-600">Zona de peligro</h3>
            <p className="mb-4 text-xs text-slate-500">Elimina la cuenta con todas sus conversaciones y mensajes. No se puede deshacer.</p>
            <Button
              variant="danger"
              onClick={async () => {
                if (window.confirm(`¿Eliminar la cuenta "${acc.name}" y todas sus conversaciones?`)) {
                  await api.del(`/api/accounts/${id}`);
                  navigate('/cuentas');
                }
              }}
            >
              <Trash2 size={15} /> Eliminar cuenta
            </Button>
          </Card>
        </div>
      )}
    </div>
  );
}
