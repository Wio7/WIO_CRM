'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, CheckCircle2, Loader2, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED = '••••••••••••';

interface ConfigStatus {
  configured: boolean;
  is_active?: boolean;
  webhook_url?: string;
  verify_token?: string;
  page_id?: string;
  has_app_secret?: boolean;
  has_page_access_token?: boolean;
}

export function MetaLeadsConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<ConfigStatus>({ configured: false });

  // Form fields. Secrets start blank; leaving them blank on save keeps
  // the stored value (the API preserves it).
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pageToken, setPageToken] = useState('');
  const [pageId, setPageId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/meta-leads/config');
      const data = (await res.json()) as ConfigStatus;
      setStatus(data);
      setVerifyToken(data.verify_token ?? '');
      setPageId(data.page_id ?? '');
    } catch {
      toast.error('No se pudo cargar la configuración de Meta Leads');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

      {status.configured && status.webhook_url && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Webhook de tu
              cuenta
            </CardTitle>
            <CardDescription>
              Pega esta URL y tu Verify Token en Meta → tu App → Webhooks →
              suscripción <code>leadgen</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Input readOnly value={status.webhook_url} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="icon" onClick={copyUrl}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credenciales de la Meta App</CardTitle>
          <CardDescription>
            Los secretos se guardan cifrados y nunca se vuelven a mostrar. Deja
            un campo en blanco para conservar el valor ya guardado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
              placeholder={status.has_app_secret ? 'Dejar en blanco para conservar' : 'Meta → App → Configuración → Básica'}
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
              placeholder={status.has_page_access_token ? 'Dejar en blanco para conservar' : 'Token de tu Página de Facebook'}
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

          <div className="flex items-center gap-3 pt-2">
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
        </CardContent>
      </Card>
    </div>
  );
}
