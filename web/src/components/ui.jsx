import { useState, useEffect } from 'react';
import { Copy, Check, Loader2, Sun, Moon } from 'lucide-react';
import { stageByKey } from '../stages.js';

export function ThemeToggle({ className = '' }) {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('hermes-theme', dark ? 'dark' : 'light'); } catch {}
  }, [dark]);
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-label={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      className={`inline-flex items-center justify-center rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 ${className}`}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function Card({ children, className = '', onClick, ...rest }) {
  return <div onClick={onClick} className={`bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_2px_rgba(16,24,40,.04)] ${className}`} {...rest}>{children}</div>;
}

export function SectionTitle({ title, subtitle, actions, tour }) {
  return (
    <div data-tour={tour} className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Button({ children, variant = 'primary', className = '', loading, ...props }) {
  const styles = {
    primary: 'bg-violet-600 text-white hover:bg-violet-700 shadow-sm',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ label, hint, className = '', ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}</span>}
      <input
        className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 placeholder:text-slate-400 ${className}`}
        {...props}
      />
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

export function Textarea({ label, hint, rows = 6, className = '', ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}</span>}
      <textarea
        rows={rows}
        className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 placeholder:text-slate-400 leading-relaxed ${className}`}
        {...props}
      />
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

export function Select({ label, children, className = '', ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}</span>}
      <select
        className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 ${className}`}
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

export function Toggle({ checked, onChange, label, description }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-start gap-3 text-left group">
      <span className={`mt-0.5 relative inline-flex h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-violet-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </button>
  );
}

export function StagePill({ stage, className = '' }) {
  const s = stageByKey(stage);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${s.pill} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'violet', onClick }) {
  const tones = {
    violet: 'bg-violet-50 text-violet-600',
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <Card onClick={onClick} className={`p-5 fade-up ${onClick ? 'cursor-pointer transition hover:border-violet-300' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        {Icon && <span className={`rounded-xl p-2 ${tones[tone]}`}><Icon size={17} /></span>}
      </div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

export function CopyField({ label, value, hint }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}</span>}
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-xs text-slate-600">{value}</code>
        <Button
          variant="secondary"
          className="!px-3"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
        </Button>
      </div>
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, subtitle, action }) {
  return (
    <Card className="p-12 text-center">
      {Icon && (
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-500">
          <Icon size={22} />
        </div>
      )}
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      {subtitle && <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{subtitle}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Card>
  );
}

export function Avatar({ name, className = '' }) {
  const initials = String(name || '?')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const palette = ['bg-violet-100 text-violet-700', 'bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700', 'bg-pink-100 text-pink-700'];
  const tone = palette[(String(name).charCodeAt(0) || 0) % palette.length];
  return (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tone} ${className}`}>
      {initials || '?'}
    </span>
  );
}

export function Banner({ tone = 'info', children }) {
  const tones = {
    info: 'bg-blue-50 text-blue-800 border-blue-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    error: 'bg-red-50 text-red-700 border-red-200',
    ok: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  };
  return <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}
