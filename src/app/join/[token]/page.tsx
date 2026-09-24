'use client';

// ============================================================
// /join/[token] — the team's way in, on a phone, in one screen.
//
// Golden Habitat's advisors, admins and owners get this link by email
// or WhatsApp. They type a name and a password and land inside the
// Golden App already signed in. /api/invitations/[token]/enter does
// the work (create or sign in, join the team, hand back a session).
//
// Three forms, one card:
//   crear   — new person. The email is fixed when the invite had one;
//             a WhatsApp link asks for it and shows it back before
//             creating ("Tu usuario será…"), since a typo there means
//             no password recovery later.
//   entrar  — already has a login: just the password.
//   clave   — came through the email button (/auth/confirm?type=invite
//             → ?clave=1) with a session but no password yet: save one
//             with that session, then enter like everyone else.
//
// Copy is in Spanish: the people invited here are Golden Habitat's team.
// ============================================================

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';

/** Where the team works. After joining, the session is handed over there. */
const GOLDEN_APP_URL =
  process.env.NEXT_PUBLIC_GOLDEN_APP_URL?.replace(/\/+$/, '') || null;

const MIN_PASSWORD = 8;

type Role = 'owner' | 'admin' | 'agent' | 'viewer';
type FailReason = 'not_found' | 'used' | 'expired' | 'server_error';

interface InviteOk {
  ok: true;
  account_name: string;
  role: Role;
  expires_at: string;
  email: string | null;
  name: string | null;
}
type Invite = InviteOk | { ok: false; reason: FailReason };

type Modo = 'crear' | 'entrar' | 'clave';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Dueño',
  admin: 'Administrador',
  agent: 'Asesor inmobiliario',
  viewer: 'Solo lectura',
};

const FAIL_COPY: Record<FailReason, { title: string; body: string }> = {
  not_found: {
    title: 'Invitación no encontrada',
    body: 'Este enlace no corresponde a ninguna invitación. Revisa que esté completo o pide a quien te invitó uno nuevo.',
  },
  used: {
    title: 'Esta invitación ya se usó',
    body: 'Si fuiste tú, ya tienes cuenta: entra a la Golden App con tu correo y tu contraseña.',
  },
  expired: {
    title: 'Invitación vencida',
    body: 'Pide a quien te invitó que te envíe una nueva.',
  },
  server_error: {
    title: 'Algo salió mal',
    body: 'No pudimos revisar la invitación. Inténtalo de nuevo en unos segundos.',
  },
};

const ERROR_COPY: Record<string, string> = {
  weak_password: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`,
  missing_name: 'Escribe tu nombre.',
  missing_password: 'Escribe tu contraseña.',
  invalid_email: 'Revisa el correo: parece incompleto.',
  wrong_password: 'La contraseña no es correcta.',
  other_account:
    'Este correo ya pertenece a otro equipo del CRM. Usa otro correo para unirte.',
  server_error: 'Algo salió mal. Inténtalo de nuevo.',
};

/**
 * Email links can arrive with a session in the URL (older invitation
 * emails, before /auth/confirm existed). Store it and clean the address
 * bar. Returns true when that link was an invitation (needs a password).
 */
async function absorbSessionFromUrl(): Promise<boolean> {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');
  const fromConfirm = query.get('clave') === '1';
  if (!hash.has('access_token') && !hash.has('error_description') && !code && !fromConfirm) {
    return false;
  }

  query.delete('code');
  query.delete('clave');
  const rest = query.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));

  const supabase = createClient();
  if (code) {
    await supabase.auth.exchangeCodeForSession(code).catch(() => null);
    return false;
  }
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) {
    await supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .catch(() => null);
    return hash.get('type') === 'invite';
  }
  return fromConfirm;
}

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [invite, setInvite] = useState<Invite | null>(null);
  const [modo, setModo] = useState<Modo>('crear');
  const [nombre, setNombre] = useState('');
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  // WhatsApp links: the typed email is shown back before creating.
  const [revisando, setRevisando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const needsPassword = await absorbSessionFromUrl().catch(() => false);
      let sessionEmail: string | null = null;
      if (needsPassword) {
        const { data } = await createClient().auth.getUser();
        sessionEmail = data.user?.email ?? null;
      }
      try {
        const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/enter`, {
          cache: 'no-store',
        });
        const body = (await res.json()) as Invite;
        if (cancelled) return;
        setInvite(body);
        if (body.ok) {
          setNombre(body.name ?? '');
          setCorreo(body.email ?? sessionEmail ?? '');
          if (needsPassword && sessionEmail) setModo('clave');
        }
      } catch {
        if (!cancelled) setInvite({ ok: false, reason: 'server_error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!invite) {
    return <Loader2 className="size-6 animate-spin text-muted-foreground" />;
  }

  if (!invite.ok) {
    const copy = FAIL_COPY[invite.reason];
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{copy.title}</CardTitle>
          <CardDescription className="text-muted-foreground">{copy.body}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {invite.reason === 'server_error' ? (
            <Button onClick={() => window.location.reload()} className="h-11 w-full">
              Intentar de nuevo
            </Button>
          ) : (
            <a href={GOLDEN_APP_URL ?? '/login'}>
              <Button className="h-11 w-full">
                {GOLDEN_APP_URL ? 'Abrir la Golden App' : 'Iniciar sesión'}
              </Button>
            </a>
          )}
        </CardContent>
      </Card>
    );
  }

  const correoFijo = Boolean(invite.email) || modo === 'clave';

  const entrar = async (mode: 'create' | 'login') => {
    const res = await fetch(`/api/invitations/${encodeURIComponent(token!)}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, email: correo, password: clave, full_name: nombre }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      access_token?: string;
      refresh_token?: string;
      golden_app_url?: string | null;
    };

    if (res.ok && body.access_token && body.refresh_token) {
      const destino = body.golden_app_url ?? GOLDEN_APP_URL;
      if (destino) {
        // The session travels in the fragment: it never reaches a server
        // log, and the Golden App wipes it from the address bar on arrival.
        const handoff = new URLSearchParams({
          a: body.access_token,
          r: body.refresh_token,
        });
        window.location.replace(`${destino}/#/entrar?${handoff}`);
        return;
      }
      await createClient().auth.setSession({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      });
      window.location.replace('/dashboard');
      return;
    }

    setEnviando(false);
    setRevisando(false);
    if (res.status === 429) {
      setError('Demasiados intentos seguidos. Espera un minuto.');
      return;
    }
    if (body.reason === 'existing_account') {
      setModo('entrar');
      setClave('');
      setError(null);
      setAviso(`Ya tienes una cuenta con ${correo}. Escribe tu contraseña de siempre para entrar.`);
      return;
    }
    if (body.reason === 'used' || body.reason === 'expired' || body.reason === 'not_found') {
      setInvite({ ok: false, reason: body.reason });
      return;
    }
    setError(ERROR_COPY[body.reason ?? ''] ?? ERROR_COPY.server_error);
  };

  const enviar = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);

    if (modo !== 'entrar' && !nombre.trim()) {
      setError(ERROR_COPY.missing_name);
      return;
    }
    if (!correoFijo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) {
      setError(ERROR_COPY.invalid_email);
      return;
    }
    if (modo !== 'entrar' && clave.length < MIN_PASSWORD) {
      setError(ERROR_COPY.weak_password);
      return;
    }
    if (!clave) {
      setError(ERROR_COPY.missing_password);
      return;
    }
    if (modo === 'crear' && !correoFijo && !revisando) {
      setRevisando(true);
      return;
    }

    setEnviando(true);
    if (modo === 'clave') {
      const { error: updError } = await createClient().auth.updateUser({
        password: clave,
        data: { full_name: nombre.trim() },
      });
      if (updError) {
        setEnviando(false);
        setError(
          updError.code === 'weak_password'
            ? ERROR_COPY.weak_password
            : 'No se pudo guardar la contraseña. Inténtalo de nuevo.',
        );
        return;
      }
      await entrar('login');
      return;
    }
    await entrar(modo === 'entrar' ? 'login' : 'create');
  };

  /**
   * Le manda un correo para poner una contraseña nueva. Es la única
   * forma de desencallar a quien ya tenía cuenta y no se acuerda de la
   * suya: hasta ahora la invitación era un callejón sin salida.
   */
  const recuperar = async () => {
    const destino = correo.trim().toLowerCase();
    if (!destino) {
      setError('Escribe tu correo primero.');
      return;
    }
    setEnviando(true);
    setError(null);
    const { error: recError } = await createClient().auth.resetPasswordForEmail(destino, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setEnviando(false);
    if (recError) {
      setError('No se pudo enviar el correo. Inténtalo de nuevo en un momento.');
      return;
    }
    setAviso(
      `Te mandamos un correo a ${destino} para poner una contraseña nueva. Revisa también la carpeta de spam; cuando la cambies, vuelve a abrir este mismo enlace.`,
    );
  };

  const cambiarModo = (siguiente: Modo) => {
    setModo(siguiente);
    setError(null);
    setAviso(null);
    setRevisando(false);
  };

  const titulo =
    modo === 'entrar' ? 'Entra para unirte' : 'Crea tu cuenta';
  const boton =
    modo === 'entrar'
      ? 'Entrar'
      : modo === 'clave'
        ? 'Guardar y entrar'
        : 'Crear mi cuenta y entrar';

  return (
    <Card className="w-full max-w-md border-border bg-card">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <UsersRound className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">
          Te invitaron a <span className="text-primary">{invite.account_name}</span>
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Entrarás como{' '}
          <span className="inline-flex items-center gap-1 text-foreground">
            <ShieldCheck className="size-3.5 text-primary" />
            {ROLE_LABEL[invite.role]}
          </span>
          . {titulo}.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {revisando ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Tu usuario será:</p>
            <p className="break-all rounded-lg border border-border bg-muted px-3 py-3 text-lg font-semibold text-foreground">
              {correo.trim().toLowerCase()}
            </p>
            <p className="text-sm text-muted-foreground">
              Con este correo entrarás a la Golden App y recuperarás tu
              contraseña si la olvidas. ¿Está bien escrito?
            </p>
            {error && <Mensaje texto={error} />}
            <Button onClick={() => enviar()} disabled={enviando} className="h-11 w-full">
              {enviando ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creando tu cuenta…
                </>
              ) : (
                'Sí, crear mi cuenta'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => setRevisando(false)}
              disabled={enviando}
              className="h-11 w-full"
            >
              Corregir el correo
            </Button>
          </div>
        ) : (
          <form onSubmit={enviar} className="flex flex-col gap-4" noValidate>
            {aviso && (
              <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
                {aviso}
              </p>
            )}

            {modo !== 'entrar' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nombre">Tu nombre</Label>
                <Input
                  id="nombre"
                  autoComplete="name"
                  value={nombre}
                  maxLength={80}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder="Ej. Carlos Merino"
                  className="h-11 text-base"
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correo">Correo</Label>
              {correoFijo ? (
                <p
                  id="correo"
                  className="break-all rounded-md border border-border bg-muted px-3 py-2.5 text-base text-foreground"
                >
                  {correo}
                </p>
              ) : (
                <Input
                  id="correo"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  value={correo}
                  onChange={(e) => setCorreo(e.target.value)}
                  placeholder="nombre@correo.com"
                  className="h-11 text-base"
                />
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clave">
                {modo === 'entrar' ? 'Tu contraseña' : 'Crea tu contraseña'}
              </Label>
              <div className="relative">
                <Input
                  id="clave"
                  type={verClave ? 'text' : 'password'}
                  autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
                  value={clave}
                  onChange={(e) => setClave(e.target.value)}
                  placeholder={modo === 'entrar' ? '' : `Mínimo ${MIN_PASSWORD} caracteres`}
                  className="h-11 pr-12 text-base"
                />
                <button
                  type="button"
                  onClick={() => setVerClave((v) => !v)}
                  aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground"
                >
                  {verClave ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                </button>
              </div>
            </div>

            {/* La salida de emergencia. Quien ya tenía cuenta y no
                recuerda su contraseña se quedaba encallado aquí: el
                formulario le pedía "tu contraseña de siempre" y no había
                ningún otro camino, ni hacia adelante ni hacia atrás.
                Sólo aparece cuando se le está pidiendo una contraseña que
                ya existe, que es cuando hace falta. */}
            {modo === 'entrar' && (
              <button
                type="button"
                onClick={recuperar}
                disabled={enviando}
                className="-mt-1 self-start text-sm font-medium text-primary underline underline-offset-2"
              >
                No recuerdo mi contraseña
              </button>
            )}

            {error && <Mensaje texto={error} />}

            <Button type="submit" disabled={enviando} className="h-11 w-full text-base">
              {enviando ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Entrando…
                </>
              ) : (
                boton
              )}
            </Button>

            {modo === 'crear' && (
              <button
                type="button"
                onClick={() => cambiarModo('entrar')}
                className="min-h-11 text-sm text-primary"
              >
                ¿Ya tienes cuenta? Entra con tu contraseña
              </button>
            )}
            {modo === 'entrar' && (
              <div className="flex flex-col items-center gap-1">
                <Link href="/forgot-password" className="flex min-h-11 items-center text-sm text-primary">
                  Olvidé mi contraseña
                </Link>
                {!aviso && (
                  <button
                    type="button"
                    onClick={() => cambiarModo('crear')}
                    className="min-h-11 text-sm text-muted-foreground"
                  >
                    Soy nuevo: crear mi cuenta
                  </button>
                )}
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Mensaje({ texto }: { texto: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-foreground"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" />
      {texto}
    </p>
  );
}
