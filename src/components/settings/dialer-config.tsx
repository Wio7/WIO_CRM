'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Upload,
  ShieldBan,
} from 'lucide-react';

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

interface DialerStatus {
  configured: boolean;
  account_sid: string | null;
  from_number: string | null;
  is_active: boolean;
  verified_at: string | null;
  last_error: string | null;
  has_auth_token: boolean;
  advisor_phone: string | null;
  do_not_call_count: number;
}

export function DialerConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<DialerStatus | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [advisorPhone, setAdvisorPhone] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/calls/config');
      if (!res.ok) return;
      const data = (await res.json()) as DialerStatus;
      setStatus(data);
      setAccountSid(data.account_sid ?? '');
      setFromNumber(data.from_number ?? '');
      setAdvisorPhone(data.advisor_phone ?? '');
    } catch {
      toast.error('No se pudo cargar la configuración del marcador');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/calls/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_sid: accountSid.trim() || undefined,
          auth_token: authToken.trim() || undefined,
          from_number: fromNumber.trim() || undefined,
          advisor_phone: advisorPhone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo guardar');
        return;
      }
      // Saved either way — `verified` says whether Twilio accepted the
      // credentials, which is what actually gates dialing.
      if (data.warning) toast.warning(data.warning);
      else if (data.verified) toast.success('Credenciales verificadas con Twilio');
      else toast.success('Guardado');
      setAuthToken('');
      await load();
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function importDnc(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      // Accept a bare list or a CSV — take the first column of each row.
      const phones = text
        .split(/\r?\n/)
        .map((line) => line.split(/[,;\t]/)[0]?.trim())
        .filter((v): v is string => !!v);

      const res = await fetch('/api/calls/do-not-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones, source: 'importacion' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo importar');
        return;
      }
      toast.success(`${data.imported} número(s) procesados — ${data.total} en la lista`);
      await load();
    } catch {
      toast.error('No se pudo leer el archivo');
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
      </div>
    );
  }

  const verified = !!status?.verified_at;

  return (
    <div>
      <SettingsPanelHead
        title="Marcador (Power Dialer)"
        description="Marca secuencialmente a una cola de leads y puentea al asesor cuando contestan. Cada llamada contestada queda grabada, transcrita y resumida por IA."
      />

      {status?.configured && (
        <div
          className={`mb-5 flex items-start gap-2 rounded-lg border p-3 text-sm ${
            verified
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
          }`}
        >
          {verified ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            {verified ? (
              <p>Credenciales verificadas con Twilio. El marcador está listo.</p>
            ) : (
              <p>
                Guardado, pero Twilio no aceptó la configuración
                {status.last_error ? `: ${status.last_error}` : '.'}
              </p>
            )}
          </div>
        </div>
      )}

      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="text-base">Credenciales de Twilio</CardTitle>
          <CardDescription>
            El Auth Token se guarda cifrado y nunca se vuelve a mostrar. Déjalo en
            blanco para conservar el guardado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="account-sid">Account SID</Label>
            <Input
              id="account-sid"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auth-token">
              Auth Token
              {status?.has_auth_token && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({MASKED} guardado)
                </span>
              )}
            </Label>
            <Input
              id="auth-token"
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={
                status?.has_auth_token
                  ? 'Dejar en blanco para conservar'
                  : 'Twilio → Console → Account Info'
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="from-number">Número de origen (caller ID)</Label>
            <Input
              id="from-number"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              placeholder="+51999888777"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Debe ser un número que tu empresa posee y verificó en Twilio (te llaman
              con un PIN). Mostrar un número ajeno es spoofing: lo bloquea STIR/SHAKEN
              y lo sanciona Indecopi.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="advisor-phone">Tu teléfono (destino del puente)</Label>
            <Input
              id="advisor-phone"
              value={advisorPhone}
              onChange={(e) => setAdvisorPhone(e.target.value)}
              placeholder="+51987654321"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Cuando el lead contesta, la llamada se puentea a este número. Cada asesor
              configura el suyo.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? 'Verificando…' : 'Guardar y verificar'}
            </Button>
            <a
              href="https://www.twilio.com/docs/voice/make-calls"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Documentación de Twilio <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldBan className="h-4 w-4 text-muted-foreground" />
            Lista &quot;No llamar&quot;
          </CardTitle>
          <CardDescription>
            Números excluidos del marcado. Actualmente{' '}
            <span className="font-medium text-foreground">
              {status?.do_not_call_count ?? 0}
            </span>{' '}
            en la lista.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
            <strong className="font-semibold text-amber-200">Importante:</strong> el
            registro &quot;Gracias, no insista&quot; de Indecopi no tiene API pública —
            se descarga y se importa aquí. Esta lista <em>no</em> se sincroniza sola;
            actualízala periódicamente por tu cuenta.
          </div>

          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importDnc(file);
            }}
          />
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Importar CSV
          </Button>
          <p className="text-xs text-muted-foreground">
            Un número por línea, o CSV con el número en la primera columna.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
