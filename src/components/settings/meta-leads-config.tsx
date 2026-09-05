'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Copy,
  CheckCircle2,
  Loader2,
  ExternalLink,
  RefreshCw,
  Unplug,
  FileText,
  AlertTriangle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED = '••••••••••••';

/** Facebook wordmark glyph — lucide dropped brand icons, so we inline it. */
function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 3.925 23.094 9.101 24v-8.437H6.627v-3.49h2.474V9.9c0-3.47 1.9-5.386 5.02-5.386 1.494 0 2.858.11 3.24.16v3.756h-2.223c-1.746 0-2.084.83-2.084 2.05v2.045h4.16l-.542 3.49h-3.618V24C20.075 23.094 24 18.1 24 12.073z" />
    </svg>
  );
}

interface ConfigStatus {
  configured: boolean;
  is_active?: boolean;
  webhook_url?: string;
  verify_token?: string;
  page_id?: string;
  has_app_secret?: boolean;
  has_page_access_token?: boolean;
}

interface MetaPage {
  id: string;
  page_id: string;
  page_name: string | null;
  is_active: boolean;
  subscribed_at: string | null;
  has_token: boolean;
  last_error: string | null;
}

interface MetaConnection {
  fb_user_name: string | null;
  connected_at: string | null;
  token_expires_at: string | null;
  last_error: string | null;
}

interface PagesResponse {
  connected: boolean;
  connection: MetaConnection | null;
  pages: MetaPage[];
}

interface LeadForm {
  id: string;
  name?: string;
  status?: string;
}

export function MetaLeadsConfig() {
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [oauth, setOauth] = useState<PagesResponse>({
    connected: false,
    connection: null,
    pages: [],
  });
  const [togglingPage, setTogglingPage] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formsFor, setFormsFor] = useState<string | null>(null);
  const [forms, setForms] = useState<LeadForm[] | null>(null);
  const [loadingForms, setLoadingForms] = useState(false);

  // Manual (own Meta App) path — preserved as the advanced option.
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<ConfigStatus>({ configured: false });
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pageToken, setPageToken] = useState('');
  const [pageId, setPageId] = useState('');

  const loadPages = useCallback(async () => {
    try {
      const res = await fetch('/api/meta/pages');
      if (!res.ok) return;
      setOauth((await res.json()) as PagesResponse);
    } catch {
      // Non-fatal: the manual path below still works.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes] = await Promise.all([
        fetch('/api/meta-leads/config'),
        loadPages(),
      ]);
      const data = (await cfgRes.json()) as ConfigStatus;
      setStatus(data);
      setVerifyToken(data.verify_token ?? '');
      setPageId(data.page_id ?? '');
    } catch {
      toast.error('No se pudo cargar la configuración de Meta Leads');
    } finally {
      setLoading(false);
    }
  }, [loadPages]);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface the outcome of the OAuth redirect once, on return from Meta.
  useEffect(() => {
    const error = searchParams.get('error');
    const warning = searchParams.get('warning');
    const connected = searchParams.get('connected');
    if (error) toast.error(error);
    else if (connected) {
      const count = searchParams.get('pages');
      toast.success(
        count && count !== '0'
          ? `Facebook conectado — ${count} página(s) encontrada(s)`
          : 'Facebook conectado',
      );
    }
    if (warning) toast.warning(warning);
  }, [searchParams]);

  async function togglePage(page: MetaPage, next: boolean) {
    setTogglingPage(page.page_id);
    try {
      const res = await fetch('/api/meta/pages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: page.page_id, is_active: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo actualizar la página');
        await loadPages();
        return;
      }
      toast.success(
        next
          ? `"${page.page_name ?? page.page_id}" ahora envía leads al CRM`
          : `"${page.page_name ?? page.page_id}" dejó de enviar leads`,
      );
      await loadPages();
    } catch {
      toast.error('Error al comunicar con el servidor');
    } finally {
      setTogglingPage(null);
    }
  }

  async function showForms(page: MetaPage) {
    if (formsFor === page.page_id) {
      setFormsFor(null);
      setForms(null);
      return;
    }
    setFormsFor(page.page_id);
    setForms(null);
    setLoadingForms(true);
    try {
      const res = await fetch(`/api/meta/pages?forms=${encodeURIComponent(page.page_id)}`);
      const data = (await res.json()) as PagesResponse & { forms: LeadForm[] | null };
      setForms(data.forms ?? []);
    } catch {
      toast.error('No se pudieron cargar los formularios');
      setForms([]);
    } finally {
      setLoadingForms(false);
    }
  }

  async function disconnect() {
    if (
      !confirm(
        '¿Desconectar Facebook? Las páginas dejarán de enviar leads al CRM. Los contactos ya registrados no se borran.',
      )
    )
      return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/meta/disconnect', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo desconectar');
        return;
      }
      toast.success('Facebook desconectado');
      setFormsFor(null);
      setForms(null);
      await loadPages();
    } catch {
      toast.error('Error al desconectar');
    } finally {
      setDisconnecting(false);
    }
  }

  const save = async () => {
    if (!status.configured && (!appSecret || !verifyToken || !pageToken)) {
      toast.error(
        'Completa App Secret, Verify Token y Page Access Token para conectar.'
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/meta-leads/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_secret: appSecret || undefined,
          verify_token: verifyToken || undefined,
          page_access_token: pageToken || undefined,
          page_id: pageId || undefined,
          is_active: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo guardar');
        return;
      }
      toast.success('Configuración de Meta Leads guardada');
      setAppSecret('');
      setPageToken('');
      await load();
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const copyUrl = () => {
    if (status.webhook_url) {
      void navigator.clipboard.writeText(status.webhook_url);
      toast.success('URL copiada');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="Meta Lead Ads"
        description="Conecta tus campañas de Facebook e Instagram. Cada formulario de anuncio envía sus leads directo al CRM y se asignan solos a un asesor (según tu automatización de round-robin)."
      />

      {/* ---------------- OAuth: the primary path ---------------- */}
      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FacebookIcon className="h-4 w-4 text-[#1877F2]" />
            {oauth.connected ? 'Facebook conectado' : 'Conectar Facebook'}
          </CardTitle>
          <CardDescription>
            {oauth.connected
              ? 'Activa las páginas cuyos formularios deban enviar leads a este CRM.'
              : 'Inicia sesión con Facebook y elige tus páginas. Tu contraseña se escribe en Facebook — el CRM nunca la ve.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!oauth.connected ? (
            <a
              href="/api/meta/oauth/start"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-[#1877F2] px-4 text-sm font-medium text-white transition-colors hover:bg-[#166FE5]"
            >
              <FacebookIcon className="h-4 w-4" />
              Conectar con Facebook
            </a>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-foreground">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    Conectado como{' '}
                    <span className="font-medium">
                      {oauth.connection?.fb_user_name ?? 'usuario de Facebook'}
                    </span>
                  </p>
                  {oauth.connection?.token_expires_at && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      La sesión con Meta vence el{' '}
                      {new Date(oauth.connection.token_expires_at).toLocaleDateString('es-PE')}
                      . Vuelve a conectar antes de esa fecha para seguir viendo páginas nuevas.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <a
                    href="/api/meta/oauth/start"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Volver a sincronizar
                  </a>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={disconnect}
                    disabled={disconnecting}
                    className="h-8 text-xs text-destructive hover:text-destructive"
                  >
                    {disconnecting ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Unplug className="mr-1 h-3.5 w-3.5" />
                    )}
                    Desconectar
                  </Button>
                </div>
              </div>

              {oauth.pages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No encontramos páginas de Facebook en esta cuenta. Asegúrate de
                  administrar al menos una página y vuelve a sincronizar.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {oauth.pages.map((page) => (
                    <div key={page.id} className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {page.page_name ?? page.page_id}
                          </p>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {page.page_id}
                          </p>
                          {page.last_error && (
                            <p className="mt-1 flex items-start gap-1 text-xs text-amber-500">
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                              {page.last_error}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {page.is_active && (
                            <button
                              type="button"
                              onClick={() => showForms(page)}
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Formularios
                            </button>
                          )}
                          {togglingPage === page.page_id ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <Switch
                              checked={page.is_active}
                              onCheckedChange={(v) => togglePage(page, !!v)}
                              aria-label={`Activar ${page.page_name ?? page.page_id}`}
                            />
                          )}
                        </div>
                      </div>

                      {formsFor === page.page_id && (
                        <div className="mt-3 rounded-md bg-muted/50 p-2.5">
                          {loadingForms ? (
                            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" /> Cargando
                              formularios…
                            </p>
                          ) : forms && forms.length > 0 ? (
                            <ul className="space-y-1">
                              {forms.map((f) => (
                                <li
                                  key={f.id}
                                  className="flex items-center justify-between gap-2 text-xs"
                                >
                                  <span className="truncate text-foreground">
                                    {f.name ?? f.id}
                                  </span>
                                  {f.status && (
                                    <span className="shrink-0 text-muted-foreground">
                                      {f.status}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Esta página aún no tiene formularios de leads.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Manual: own Meta App (advanced) ---------------- */}
      <Accordion>
        <AccordionItem className="rounded-lg border border-border px-4">
          <AccordionTrigger className="text-sm text-muted-foreground hover:text-foreground hover:no-underline">
            Configuración manual (avanzado)
          </AccordionTrigger>
          <AccordionContent>
            <p className="mb-4 text-xs text-muted-foreground">
              Solo si prefieres usar tu propia Meta App en vez de conectar con el
              botón de arriba. Los secretos se guardan cifrados y nunca se
              vuelven a mostrar; deja un campo en blanco para conservar el valor
              guardado.
            </p>

            {status.configured && status.webhook_url && (
              <div className="mb-4 space-y-1.5">
                <Label>Webhook de tu cuenta</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={status.webhook_url}
                    className="font-mono text-xs"
                  />
                  <Button type="button" variant="outline" size="icon" onClick={copyUrl}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pégala junto a tu Verify Token en Meta → tu App → Webhooks →
                  suscripción <code>leadgen</code>.
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="app-secret">
                  App Secret
                  {status.has_app_secret && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({MASKED} guardado)
                    </span>
                  )}
                </Label>
                <Input
                  id="app-secret"
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={
                    status.has_app_secret
                      ? 'Dejar en blanco para conservar'
                      : 'Meta → App → Configuración → Básica'
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="verify-token">Verify Token</Label>
                <Input
                  id="verify-token"
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  placeholder="Una frase que tú inventas y también pegas en Meta"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="page-token">
                  Page Access Token
                  {status.has_page_access_token && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({MASKED} guardado)
                    </span>
                  )}
                </Label>
                <Input
                  id="page-token"
                  type="password"
                  value={pageToken}
                  onChange={(e) => setPageToken(e.target.value)}
                  placeholder={
                    status.has_page_access_token
                      ? 'Dejar en blanco para conservar'
                      : 'Token de tu Página de Facebook'
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="page-id">Page ID (opcional)</Label>
                <Input
                  id="page-id"
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  placeholder="ID de la Página de Facebook"
                />
              </div>

              <div className="flex items-center gap-3 pt-1">
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {status.configured ? 'Guardar cambios' : 'Conectar'}
                </Button>
                <a
                  href="https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Guía de Meta <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
