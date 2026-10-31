'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllPages } from '@/lib/supabase/paginate';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock } from 'lucide-react';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** `scheduledAt` is null for "Enviar ahora". */
  onSend: (scheduledAt: Date | null) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

type SendMode = 'now' | 'schedule';

/** Value for <input type="datetime-local">: local wall-clock time. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse the datetime-local value as the browser's local time. */
function parseLocalInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(date: Date): string {
  return date.toLocaleString('es-PE', { dateStyle: 'full', timeStyle: 'short' });
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const [mode, setMode] = useState<SendMode>('now');
  const [whenValue, setWhenValue] = useState('');
  const [minValue, setMinValue] = useState(() => toLocalInputValue(new Date()));

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const tagIds = audience.tagIds;
          const rows = await fetchAllPages<{ contact_id: string }>((from, to) =>
            supabase
              .from('contact_tags')
              .select('contact_id')
              .in('tag_id', tagIds)
              .order('contact_id', { ascending: true })
              .order('tag_id', { ascending: true })
              .range(from, to),
          );
          setEstimatedReach(new Set(rows.map((ct) => ct.contact_id)).size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const scheduledAt = mode === 'schedule' ? parseLocalInput(whenValue) : null;
  // The past is not allowed: a scheduled time must still be ahead.
  const scheduleInvalid =
    mode === 'schedule' && (!scheduledAt || scheduledAt.getTime() <= Date.now());

  const audienceLabel =
    audience.type === 'all'
      ? 'Todos los contactos'
      : audience.type === 'tags'
        ? `Etiquetas (${audience.tagIds?.length ?? 0} seleccionadas)`
        : audience.type === 'csv'
          ? 'Archivo subido'
          : 'Campo personalizado';

  const whenLabel =
    mode === 'schedule' && scheduledAt ? formatWhen(scheduledAt) : 'Ahora (en el próximo minuto)';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Revisar y enviar</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ponle nombre a la difusión, revisa los detalles y envíala ahora o prográmala.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Nombre de la difusión</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Ej. Promoción de noviembre"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* When */}
      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <p className="text-sm font-medium text-foreground">¿Cuándo se envía?</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={mode === 'now' ? 'default' : 'outline'}
            onClick={() => setMode('now')}
            disabled={isProcessing}
          >
            <Send className="h-4 w-4" />
            Enviar ahora
          </Button>
          <Button
            type="button"
            variant={mode === 'schedule' ? 'default' : 'outline'}
            onClick={() => {
              setMode('schedule');
              setMinValue(toLocalInputValue(new Date()));
            }}
            disabled={isProcessing}
          >
            <CalendarClock className="h-4 w-4" />
            Programar
          </Button>
        </div>
        {mode === 'schedule' && (
          <div className="space-y-1.5">
            <label className="block text-xs text-muted-foreground">
              Fecha y hora (tu hora local)
            </label>
            <Input
              type="datetime-local"
              value={whenValue}
              min={minValue}
              onChange={(e) => setWhenValue(e.target.value)}
              className="max-w-xs border-border bg-muted text-foreground"
            />
            {whenValue && scheduleInvalid && (
              <p className="text-xs text-red-400">Elige una fecha y hora futura.</p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          La difusión sale desde el servidor: no necesitas dejar esta pestaña abierta.
        </p>
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">Resumen</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Plantilla</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Audiencia</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Destinatarios estimados</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Idioma</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Fecha de envío</p>
            <p className="text-foreground">{whenLabel}</p>
          </div>
        </div>
        <p className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-xs text-muted-foreground">
          Meta cobra por cada mensaje entregado, y el cargo va a la tarjeta de la cuenta de
          WhatsApp Business. Envía solo a personas que hayan aceptado recibir mensajes. Quien
          responda BAJA deja de recibir difusiones de esta cuenta: conviene decirlo en la plantilla.
        </p>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Preparando la difusión...</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Atrás
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Guardar borrador
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing || scheduleInvalid}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              {mode === 'schedule' ? (
                <CalendarClock className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {mode === 'schedule' ? 'Programar difusión' : 'Enviar difusión'}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {mode === 'schedule' ? 'Confirmar programación' : 'Confirmar envío'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Se enviará a{' '}
                  <span className="font-medium text-popover-foreground">
                    {estimatedReach.toLocaleString()}
                  </span>{' '}
                  contactos con la plantilla{' '}
                  <span className="font-medium text-popover-foreground">{template.name}</span>.
                  <br />
                  Fecha de envío:{' '}
                  <span className="font-medium text-popover-foreground">{whenLabel}</span>.
                  <br />
                  Meta cobra por cada mensaje entregado, a la tarjeta de la cuenta de WhatsApp
                  Business, y los destinatarios deben haber aceptado recibir mensajes.
                  {mode === 'schedule' &&
                    ' Podrás cancelar la programación desde el detalle antes de la hora.'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend(mode === 'schedule' ? scheduledAt : null);
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  {mode === 'schedule' ? 'Confirmar y programar' : 'Confirmar y enviar'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
