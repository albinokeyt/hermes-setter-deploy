import { useState } from 'react';
import { Bot } from 'lucide-react';
import { api } from '../api.js';
import { Button, Input, Banner } from '../components/ui.jsx';

export default function PortalRegister() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // la cuenta se resuelve desde la cookie temporal creada al abrir el enlace de GHL
      await api.post('/api/portal/register', { name, email });
      window.location.replace('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm fade-up">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-600/25">
            <Bot size={28} strokeWidth={2.2} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">¡Bienvenido!</h1>
          <p className="mt-1 text-sm text-slate-500">Primera vez por aquí: dinos quién eres para entrar a tu panel del setter</p>
        </div>
        <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          <Input label="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Input label="Tu correo" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" loading={loading}>Entrar</Button>
        </form>
      </div>
    </div>
  );
}
