import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, SectionTitle, Button, Input, Banner } from '../components/ui.jsx';

export default function UserPage() {
  const [me, setMe] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [current, setCurrent] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/api/auth/me').then((u) => { setMe(u); setUsername(u.username || ''); }).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (password && password !== password2) {
      setMsg({ tone: 'error', text: 'Las contraseñas nuevas no coinciden' });
      return;
    }
    setSaving(true);
    try {
      await api.put('/api/auth/me', { current_password: current, username, password: password || undefined });
      setMsg({ tone: 'ok', text: 'Datos actualizados correctamente' });
      setPassword(''); setPassword2(''); setCurrent('');
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (!me) return <div className="py-24 text-center text-sm text-slate-400">Cargando…</div>;

  return (
    <div>
      <SectionTitle title="Usuario" subtitle="Tu acceso al panel" />
      <Card className="max-w-lg p-6">
        <form onSubmit={save} className="space-y-4">
          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
          <Input label="Nombre de usuario" value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Nueva contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="vacío = no cambiar" />
            <Input label="Repetir nueva contraseña" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </div>
          <Input label="Contraseña actual (para confirmar)" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <Button type="submit" loading={saving}>Guardar</Button>
        </form>
      </Card>
    </div>
  );
}
