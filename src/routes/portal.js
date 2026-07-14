import crypto from 'node:crypto';
import { one, q, getSetting, setSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { createSession, setSessionCookie } from '../lib/session.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { getLocationName } from '../services/ghl.js';
import { logEvent } from '../services/pipeline.js';

// Clave global del link de agencia (se genera sola).
export async function agencyKey() {
  let cfg = await getSetting('agency_portal', null);
  if (!cfg || !cfg.key) {
    cfg = { key: crypto.randomBytes(20).toString('hex') };
    await setSetting('agency_portal', cfg);
  }
  return cfg.key;
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function emailList(account) {
  const raw = account?.authorized_emails;
  let arr = [];
  try { arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { arr = []; }
  return arr.map(normEmail).filter(Boolean);
}

// ¿Puede este correo entrar al panel de este setter?
//  - lista vacía            → aún sin dueño: el primero en entrar la reclama (bootstrap)
//  - correo en la lista     → permitido
//  - correo fuera de lista  → denegado
//  - sin correo             → hay que pedirlo (registro)
function accessDecision(account, email) {
  const e = normEmail(email);
  if (!e || !e.includes('@')) return { ok: false, reason: 'no_email' };
  const list = emailList(account);
  if (!list.length) return { ok: true, bootstrap: true, email: e };
  if (list.includes(e)) return { ok: true, bootstrap: false, email: e };
  return { ok: false, reason: 'not_authorized', email: e };
}

// El primer correo que entra a un setter sin lista lo reclama como responsable.
async function claimOwner(accountId, email) {
  const e = normEmail(email);
  if (!e) return;
  await q(
    `UPDATE accounts SET owner_email = $2, authorized_emails = $3::jsonb
     WHERE id = $1 AND (authorized_emails IS NULL OR authorized_emails = '[]'::jsonb)`,
    [accountId, e, JSON.stringify([e])]
  );
}

function infoHtml(icon, titulo, cuerpo, pie) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <div style="font-family:system-ui,sans-serif;max-width:420px;margin:16vh auto;padding:0 20px;text-align:center;color:#1e293b">
    <div style="width:56px;height:56px;border-radius:16px;background:#fef2f2;color:#dc2626;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:26px">${icon}</div>
    <h2 style="margin:0 0 8px;font-size:20px">${titulo}</h2>
    <p style="margin:0;color:#64748b;font-size:14px;line-height:1.5">${cuerpo}</p>
    ${pie ? `<p style="margin:14px 0 0;color:#94a3b8;font-size:12px">${pie}</p>` : ''}
  </div>`;
}

function safeName(account) {
  return String(account?.name || 'este panel').replace(/[<>&]/g, '');
}

function deniedHtml(account) {
  return infoHtml('🔒', `Sin acceso a ${safeName(account)}`,
    'Tu correo de GHL no está autorizado para entrar a este panel. Pídele a la persona responsable que añada tu correo desde su pestaña <b>Accesos</b>.',
    'Si eres el responsable, entra con el correo con el que instalaste la app.');
}

// Setter existente pero aún sin lista de accesos: no se puede "reclamar" por el
// enlace global de agencia (evita que alguien con otro location_id se apropie de él).
function needsSetupHtml(account) {
  return infoHtml('⏳', `${safeName(account)} aún no tiene accesos`,
    'Este setter existe pero todavía no tiene correos autorizados. Pídele a la agencia que te añada como responsable desde el panel, o usa el enlace de portal propio de tu subcuenta.',
    null);
}

async function upsertPortalUser(accountId, name, email) {
  return one(
    `INSERT INTO portal_users (account_id, email, name, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account_id, email) DO UPDATE SET
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE portal_users.name END,
       last_seen_at = now()
     RETURNING *`,
    [accountId, normEmail(email), String(name || '').trim()]
  );
}

async function startPortalSession(reply, account, name, email) {
  const pu = await upsertPortalUser(account.id, name, email);
  const token = await createSession({ portal: true, role: 'user', accountId: account.id, portalUserId: pu.id });
  setSessionCookie(reply, token, { portal: true });
}

// Envía una cookie de registro y manda al formulario (nombre+correo).
// allowBootstrap viaja con el token: solo así el registro podrá reclamar un setter sin lista.
async function sendToRegister(reply, accountId, allowBootstrap) {
  const regToken = crypto.randomBytes(24).toString('hex');
  await redis.setex(`portalreg:${regToken}`, 900, JSON.stringify({ accountId: Number(accountId), allowBootstrap: Boolean(allowBootstrap) }));
  reply.setCookie('hermes_portal_reg', regToken, { path: '/', httpOnly: true, sameSite: 'none', secure: true, maxAge: 900 });
  return reply.redirect('/registro-portal');
}

// Decide la entrada según la lista blanca de correos del setter.
// allowBootstrap = true solo cuando el origen prueba control de la subcuenta:
//   enlace único por-setter, o setter recién creado en esta misma instalación.
// En el enlace global de agencia sobre un setter YA existente es false: si no tiene
// lista, no se puede reclamar (evita apropiárselo conociendo el location_id).
async function resolveEntry(reply, account, email, name, allowBootstrap) {
  if (!emailList(account).length && !allowBootstrap) {
    await logEvent('portal_sin_accesos', { account: account.id });
    return reply.code(403).type('text/html; charset=utf-8').send(needsSetupHtml(account));
  }
  const d = accessDecision(account, email);
  if (d.ok) {
    if (d.bootstrap) await claimOwner(account.id, d.email);
    await startPortalSession(reply, account, name, d.email);
    return reply.redirect('/');
  }
  if (d.reason === 'not_authorized') {
    await logEvent('portal_acceso_denegado', { account: account.id, email: d.email });
    return reply.code(403).type('text/html; charset=utf-8').send(deniedHtml(account));
  }
  return sendToRegister(reply, account.id, allowBootstrap); // no_email → pedir correo
}

async function currentPortalEmail(req) {
  const pid = req.auth?.portalUserId;
  if (!pid) return '';
  const pu = await one(`SELECT email FROM portal_users WHERE id = $1`, [pid]);
  return normEmail(pu?.email);
}

export default async function portalRoutes(app) {
  // Entrada desde el Custom Menu Link POR SETTER:
  // https://TU-APP/ghl-portal?key=CLAVE_DE_LA_CUENTA&location_id={{location.id}}&email={{user.email}}&name={{user.name}}
  app.get('/ghl-portal', async (req, reply) => {
    const { key, location_id, email, name } = req.query || {};
    const account = key ? await one(`SELECT * FROM accounts WHERE portal_key = $1`, [String(key)]) : null;
    if (!account) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Enlace de portal no válido. Pide al administrador el enlace de tu cuenta.</h3>');
    }
    // Defensa extra: si el enlace trae location_id, debe coincidir con el de la cuenta.
    if (location_id && account.location_id && String(location_id) !== account.location_id) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Este enlace no corresponde a tu subcuenta.</h3>');
    }
    // Enlace único por-setter: poseer la clave autoriza a reclamar (bootstrap ok).
    return resolveEntry(reply, account, email, name, true);
  });

  // Link de AGENCIA (uno para todas las subcuentas). GHL rellena location_id/email/name.
  // 1) subcuenta sin app conectada → la manda a instalar/conectar (OAuth).
  // 2) app conectada pero sin setter → crea el setter y entra (pide nombre/correo si falta).
  // 3) setter ya existe → entra a su panel (solo correos autorizados).
  app.get('/ghl-app', async (req, reply) => {
    const { key, location_id, email, name } = req.query || {};
    const okKey = key && key === (await agencyKey());
    if (!okKey) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Enlace no válido. Pide al administrador el enlace del menú.</h3>');
    }
    const loc = String(location_id || '');
    if (!loc) {
      return reply.code(400).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Falta la subcuenta. Abre este enlace desde el menú de GHL.</h3>');
    }

    let account = await one(`SELECT * FROM accounts WHERE location_id = $1`, [loc]);

    // Caso 3: setter ya existe → entrar solo si el correo está autorizado.
    // allowBootstrap=false: por el enlace global NO se puede reclamar un setter existente.
    if (account) return resolveEntry(reply, account, email, name, false);

    // ¿La app está conectada en esta subcuenta (hay token OAuth)?
    const token = await one(`SELECT location_id FROM ghl_tokens WHERE location_id = $1`, [loc]);
    if (token) {
      // Caso 2: conectada pero sin setter → crearlo y entrar (el instalador lo reclama)
      const nm = (await getLocationName({ mode: 'oauth', location_id: loc }, loc)) || `Setter ${loc.slice(0, 6)}`;
      account = await one(
        `INSERT INTO accounts (name, location_id, mode, webhook_token, portal_key) VALUES ($1, $2, 'oauth', $3, $4) RETURNING *`,
        [nm, loc, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(24).toString('hex')]
      );
      // Setter recién creado en ESTA instalación (control probado por OAuth) → puede reclamar.
      return resolveEntry(reply, account, email, name, true);
    }

    // Caso 1: app no conectada → mandar a instalar/conectar por OAuth
    const creds = (await getSetting('ghl_app', {})) || {};
    if (!creds.client_id) {
      return reply.code(200).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">La app aún no está configurada. Contacta con la agencia para activarla.</h3>');
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    await redis.setex(`oauthstate:${nonce}`, 600, `selfserve:${await agencyKey()}`);
    const redirect = `${config.appBaseUrl}/api/oauth/callback`;
    const url =
      'https://marketplace.gohighlevel.com/oauth/chooselocation' +
      `?response_type=code&redirect_uri=${encodeURIComponent(redirect)}` +
      `&client_id=${encodeURIComponent(creds.client_id)}` +
      `&scope=${OAUTH_SCOPES.map(encodeURIComponent).join('%20')}` +
      `&state=${nonce}`;
    return reply.redirect(url);
  });

  app.post('/api/portal/register', async (req, reply) => {
    const regToken = req.cookies?.hermes_portal_reg;
    const raw = regToken ? await redis.get(`portalreg:${regToken}`) : null;
    if (!raw) return reply.code(403).send({ error: 'Registro caducado. Vuelve a abrir el enlace desde GHL.' });
    let accountId = null, allowBootstrap = false;
    try { const p = JSON.parse(raw); accountId = p.accountId; allowBootstrap = Boolean(p.allowBootstrap); }
    catch { accountId = Number(raw); } // compat con tokens antiguos (solo id)
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [Number(accountId)]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const cleanName = String(req.body?.name || '').trim();
    const cleanEmail = normEmail(req.body?.email);
    if (!cleanName || !cleanEmail.includes('@')) return reply.code(400).send({ error: 'Nombre y correo válidos son obligatorios' });

    // Setter sin lista solo se puede reclamar si el origen lo permitía (no por enlace global).
    if (!emailList(account).length && !allowBootstrap) {
      return reply.code(403).send({ error: 'Este setter aún no tiene accesos configurados. Pídele a la agencia que te añada como responsable.' });
    }
    // Lista blanca: solo entra un correo autorizado (o el primero, que reclama el setter).
    const d = accessDecision(account, cleanEmail);
    if (!d.ok) return reply.code(403).send({ error: 'Tu correo no tiene acceso a este panel. Pídele al responsable que te añada desde su pestaña «Accesos».' });
    if (d.bootstrap) await claimOwner(account.id, cleanEmail);

    await redis.del(`portalreg:${regToken}`);
    reply.clearCookie('hermes_portal_reg', { path: '/' });
    await startPortalSession(reply, account, cleanName, cleanEmail);
    return { ok: true };
  });

  // --- Gestión de accesos (correos autorizados) ---------------------------
  // Alcance: admin puede gestionar cualquier setter (?account_id=); el usuario del
  // portal, solo el suyo, y solo si es el responsable (owner_email).
  function targetAccountId(req, fromBody) {
    const isAdmin = req.auth?.role === 'admin';
    const q = fromBody ? req.body?.account_id : req.query?.account_id;
    if (isAdmin && q) return Number(q);
    return req.auth?.accountId || null;
  }

  app.get('/api/portal/access', async (req, reply) => {
    const id = targetAccountId(req, false);
    if (!id) return reply.code(400).send({ error: 'Sin setter asignado' });
    const account = await one(`SELECT id, name, owner_email, authorized_emails FROM accounts WHERE id = $1`, [id]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    // un usuario del portal solo consulta el suyo
    if (req.auth?.role !== 'admin' && req.auth?.accountId !== account.id) {
      return reply.code(403).send({ error: 'Sin acceso' });
    }
    const myEmail = await currentPortalEmail(req);
    const canManage = req.auth?.role === 'admin' || (myEmail && myEmail === normEmail(account.owner_email));
    // A quien NO gestiona no se le revela el correo del responsable ni la lista completa:
    // esos datos convertirían el residual del correo falsificable en un oráculo del dueño.
    if (!canManage) {
      return { account_id: account.id, my_email: myEmail, can_manage: false, has_owner: Boolean(account.owner_email) };
    }
    return {
      account_id: account.id,
      owner_email: account.owner_email || '',
      emails: emailList(account),
      my_email: myEmail,
      can_manage: true,
    };
  });

  app.put('/api/portal/access', async (req, reply) => {
    const id = targetAccountId(req, true);
    if (!id) return reply.code(400).send({ error: 'Sin setter asignado' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [id]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    if (req.auth?.role !== 'admin' && req.auth?.accountId !== account.id) {
      return reply.code(403).send({ error: 'Sin acceso' });
    }
    const myEmail = await currentPortalEmail(req);
    const isOwner = req.auth?.role === 'admin' || (myEmail && myEmail === normEmail(account.owner_email));
    if (!isOwner) return reply.code(403).send({ error: 'Solo el responsable puede cambiar los accesos' });

    let emails = Array.isArray(req.body?.emails) ? req.body.emails.map(normEmail).filter((e) => e.includes('@') && e.length <= 254) : [];
    let owner = normEmail(account.owner_email);
    // Si el admin siembra un setter sin responsable, el primer correo pasa a serlo.
    if (!owner && req.auth?.role === 'admin' && emails.length) owner = emails[0];
    if (owner && !emails.includes(owner)) emails.unshift(owner); // el responsable nunca se auto-expulsa
    emails = [...new Set(emails)].slice(0, 50);
    await q(`UPDATE accounts SET owner_email = $2, authorized_emails = $3::jsonb WHERE id = $1`, [id, owner, JSON.stringify(emails)]);
    return { ok: true, emails, owner_email: owner };
  });
}
