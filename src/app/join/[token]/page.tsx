'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign in" + "Sign up"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
//
// Copy is in Spanish: the people invited here are Golden Habitat's team.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

/** Where most members actually work. After accepting, send them there. */
const GOLDEN_APP_URL =
  process.env.NEXT_PUBLIC_GOLDEN_APP_URL?.replace(/\/+$/, '') || null;

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

const ROLE_LABEL: Record<PeekOk['role'], string> = {
  owner: 'Dueño',
  admin: 'Administrador',
  agent: 'Asesor inmobiliario',
  viewer: 'Solo lectura',
};

const FAIL_COPY: Record<PeekFail['reason'], { title: string; body: string }> = {
  not_found: {
    title: 'Invitación no encontrada',
    body: 'Este enlace no corresponde a ninguna invitación. Revisa que esté completo o pide a quien te invitó que te envíe uno nuevo.',
  },
  used: {
    title: 'Invitación ya aceptada',
    body: 'Esta invitación ya se usó. Si ya la aceptaste, inicia sesión. Si no fuiste tú, pide una nueva.',
  },
  expired: {
    title: 'Invitación vencida',
    body: 'Esta invitación ya venció. Pide a quien te invitó que te envíe una nueva.',
  },
  server_error: {
    title: 'Algo salió mal',
    body: 'No pudimos verificar la invitación en este momento. Inténtalo de nuevo en unos segundos.',
  },
};

type LinkResult = 'invite' | 'magiclink' | 'error' | null;

/**
 * Email links can land here three ways:
 *   · #access_token=…&type=invite|magiclink — invitation emails sent
 *     before the /auth/confirm templates.
 *   · ?code=… — a signup confirmation sent before /auth/callback existed.
 *   · #error_description=… — Supabase rejected the link (already used,
 *     or opened by a mail scanner first).
 * Store the session before probing auth and clean the address bar.
 */
async function absorbSessionFromUrl(): Promise<LinkResult> {
  if (typeof window === 'undefined') return null;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');

  if (!hash.has('access_token') && !hash.has('error_description') && !code) {
    return null;
  }

  query.delete('code');
  const rest = query.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));

  if (hash.has('error_description')) return 'error';

  const supabase = createClient();
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[join] could not exchange the code from the email link:', error);
      return 'error';
    }
    return 'magiclink';
  }

  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    console.error('[join] could not store the session from the email link:', error);
    return 'error';
  }
  return hash.get('type') === 'invite' ? 'invite' : 'magiclink';
}

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // Invited by email: the account exists but has no password yet.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);

  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      // /auth/confirm adds ?clave=1 after verifying an invitation.
      const query = new URLSearchParams(window.location.search);
      const fromConfirm = query.get('clave') === '1';
      if (fromConfirm) {
        query.delete('clave');
        const rest = query.toString();
        window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
      }
      try {
        const linkType = await absorbSessionFromUrl();
        if (cancelled) return;
        if (linkType === 'invite' || fromConfirm) setNeedsPassword(true);
        if (linkType === 'error') setLinkFailed(true);
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (res.status === 409) {
          setConflictMessage(
            payload.error ||
              'Ya perteneces a otra cuenta. Inicia sesión con otro correo para unirte a esta.',
          );
        } else {
          toast.error(payload.error || 'No se pudo aceptar la invitación');
        }
        setAccepting(false);
        return;
      }
      toast.success('¡Bienvenido al equipo!');
      if (GOLDEN_APP_URL) {
        // Advisors work from the Golden App on their phone: offer it first.
        setAccepted(true);
        setAccepting(false);
        return;
      }
      // Full reload so AuthProvider re-fetches the profile with the new
      // account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error('No se pudo conectar con el servidor');
      setAccepting(false);
    }
  }, [token]);

  const handleSavePassword = useCallback(async () => {
    if (password.length < 8) {
      toast.error('Usa al menos 8 caracteres');
      return;
    }
    setSavingPassword(true);
    const { error } = await createClient().auth.updateUser({ password });
    setSavingPassword(false);
    if (error) {
      toast.error(error.message || 'No se pudo guardar la contraseña');
      return;
    }
    setNeedsPassword(false);
    setPassword('');
    toast.success('Contraseña guardada');
  }, [password]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload keeps the invite token in the URL so the rebuilt page
      // renders the signed-out path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error('No se pudo cerrar la sesión. Recarga la página.');
      setSigningOut(false);
    }
  }, []);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Verificando la invitación…</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const copy = FAIL_COPY[peek.reason];
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{copy.title}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {copy.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {peek.reason === 'server_error' ? (
            <Button
              onClick={loadPeekAndAuth}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Intentar de nuevo
            </Button>
          ) : (
            <Link href="/login">
              <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Iniciar sesión
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        Te invitaron a{' '}
        <span className="text-primary">{peek.account_name}</span>
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        Entrarás como{' '}
        <span className="inline-flex items-center gap-1 text-foreground">
          <ShieldCheck className="size-3.5 text-primary" />
          {ROLE_LABEL[peek.role]}
        </span>
        . Enlace válido hasta el{' '}
        {new Date(peek.expires_at).toLocaleDateString('es-PE', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
        .
      </CardDescription>
    </CardHeader>
  );

  // ----- Accepted: point them to where they will work -----
  if (accepted && GOLDEN_APP_URL) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <CheckCircle className="h-6 w-6 text-emerald-400" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Ya eres parte de{' '}
            <span className="text-primary">{peek.account_name}</span>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Abre la Golden App e inicia sesión con este mismo correo y tu
            contraseña. Tus chats y tu equipo ya están ahí.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <a href={GOLDEN_APP_URL}>
            <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Abrir la Golden App
            </Button>
          </a>
          <a href="/dashboard">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Ir al CRM
            </Button>
          </a>
        </CardContent>
      </Card>
    );
  }

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card">
          {inviteHeader}
          {needsPassword ? (
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Primero crea la contraseña con la que entrarás aquí y en la
                Golden App.
              </p>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Nueva contraseña (mínimo 8 caracteres)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-muted border-border text-foreground"
              />
              <Button
                onClick={handleSavePassword}
                disabled={savingPassword}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {savingPassword ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Guardando…
                  </>
                ) : (
                  'Guardar contraseña'
                )}
              </Button>
            </CardContent>
          ) : (
            <CardContent className="flex flex-col gap-3">
              <Button
                onClick={handleAccept}
                disabled={accepting}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {accepting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Aceptando…
                  </>
                ) : (
                  <>
                    <CheckCircle className="size-4" />
                    Aceptar invitación
                  </>
                )}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Al aceptar, tu usuario pasa a{' '}
                <span className="text-muted-foreground">{peek.account_name}</span>.
              </p>
            </CardContent>
          )}
        </Card>

        {/* Conflict modal — opens when the redeem endpoint returns 409. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                No puedes unirte a {peek.account_name} con este usuario
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>
                Para unirte a{' '}
                <span className="text-popover-foreground">{peek.account_name}</span>,
                cierra la sesión y entra con otro correo. El enlace sigue
                sirviendo mientras no venza.
              </p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                Seguir con esta sesión
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Cerrando sesión…
                  </>
                ) : (
                  'Cerrar sesión y usar otro correo'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: sign in first; creating an account is the fallback -----
  return (
    <Card className="w-full max-w-md border-border bg-card">
      {inviteHeader}
      <CardContent className="flex flex-col gap-3">
        {linkFailed && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
            El enlace del correo ya se usó o venció. Inicia sesión, o usa
            «Crear o recuperar mi contraseña» si todavía no tienes una.
          </p>
        )}
        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            Ya tengo cuenta: iniciar sesión
          </Button>
        </Link>
        <Link href={`/signup?invite=${encodeURIComponent(token!)}`}>
          <Button
            variant="outline"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Soy nuevo: crear cuenta y unirme
          </Button>
        </Link>
        <Link
          href="/forgot-password"
          className="text-center text-sm text-primary hover:text-primary/80"
        >
          Crear o recuperar mi contraseña
        </Link>
        <p className="text-center text-xs text-muted-foreground">
          ¿Te invitaron por correo? Ya tienes usuario con ese correo: no crees
          otra cuenta, usa el botón del correo o crea tu contraseña aquí arriba.
        </p>
      </CardContent>
    </Card>
  );
}
