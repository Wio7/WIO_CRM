'use client';

import { useState, type ReactNode } from 'react';
import { Loader2, Pencil, Plug, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LINE_AREAS } from '@/lib/whatsapp/lines';
import { AREA_LABELS, toLineRows, type LineRow, type LineView } from '@/lib/whatsapp/lines-view';

export type LineEdit = { line_name: string; area: string; logo_url: string };

type Props = {
  lines: LineView[];
  /** Línea con una acción en curso (guardar / quitar): sus botones se deshabilitan. */
  busyId?: string | null;
  /** Guarda nombre, área y logo; devuelve true si salió bien (cierra el formulario). */
  onSaveEdit: (lineId: string, edit: LineEdit) => Promise<boolean>;
  onRemove: (row: LineRow) => void;
  onReconnect: (row: LineRow) => void;
  onAdvanced: (row: LineRow) => void;
  /** Línea cuyo panel de reconexión está abierto, y su contenido. */
  reconnectingId?: string | null;
  reconnectSlot?: ReactNode;
};

const STATUS_STYLE: Record<LineRow['statusKey'], string> = {
  connected: 'bg-emerald-500/15 text-emerald-400',
  disconnected: 'bg-red-500/15 text-red-400',
  attention: 'bg-amber-500/15 text-amber-400',
};

function Avatar({ row }: { row: LineRow }) {
  return row.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={row.logoUrl} alt={row.name} className="size-10 shrink-0 rounded-full border border-border object-cover" />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary"
    >
      {row.initials}
    </span>
  );
}

function Badges({ row }: { row: LineRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.statusKey]}`}>{row.statusLabel}</span>
      {row.isPrimary && (
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Principal</span>
      )}
    </span>
  );
}

function Actions({
  row, busy, onEdit, onRemove, onReconnect, onAdvanced,
}: {
  row: LineRow;
  busy: boolean;
  onEdit: (row: LineRow) => void;
  onRemove: (row: LineRow) => void;
  onReconnect: (row: LineRow) => void;
  onAdvanced: (row: LineRow) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {row.canReconnect && (
        <Button size="sm" onClick={() => onReconnect(row)} disabled={busy}>
          <Plug className="size-3.5" />
          Reconectar
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => onEdit(row)} disabled={busy}>
        <Pencil className="size-3.5" />
        Editar
      </Button>
      <Button size="sm" variant="outline" onClick={() => onAdvanced(row)} disabled={busy}>
        Opciones avanzadas
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onRemove(row)}
        disabled={busy}
        className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        Quitar
      </Button>
    </div>
  );
}

export function WhatsAppLinesList({
  lines, busyId = null, onSaveEdit, onRemove, onReconnect, onAdvanced, reconnectingId = null, reconnectSlot,
}: Props) {
  const rows = toLineRows(lines);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LineEdit>({ line_name: '', area: '', logo_url: '' });

  function startEdit(row: LineRow) {
    setDraft({ line_name: row.name, area: row.area ?? '', logo_url: row.logoUrl ?? '' });
    setEditingId(row.id);
  }

  async function save(row: LineRow) {
    const ok = await onSaveEdit(row.id, draft);
    if (ok) setEditingId(null);
  }

  return (
    <ul className="mb-6 space-y-3" aria-label="Líneas de WhatsApp">
      {rows.map((row) => {
        const actions = (
          <Actions
            row={row}
            busy={busyId === row.id}
            onEdit={startEdit}
            onRemove={onRemove}
            onReconnect={onReconnect}
            onAdvanced={onAdvanced}
          />
        );
        return (
          <li key={row.id} className="rounded-lg border border-border bg-card" data-line-id={row.id}>
            {/* Vista web: una fila con todo en línea. */}
            <div data-line-row="desktop" className="hidden items-center gap-4 p-4 md:flex">
              <Avatar row={row} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{row.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {row.areaLabel} · {row.metaIdLabel}
                </p>
              </div>
              <Badges row={row} />
              {actions}
            </div>

            {/* Vista de celular: tarjeta apilada, acciones debajo. */}
            <div data-line-row="mobile" className="space-y-3 p-4 md:hidden">
              <div className="flex items-center gap-3">
                <Avatar row={row} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{row.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{row.areaLabel}</p>
                  <p className="truncate text-xs text-muted-foreground">{row.metaIdLabel}</p>
                </div>
              </div>
              <Badges row={row} />
              {actions}
            </div>

            {editingId === row.id && (
              <div data-line-edit className="space-y-3 border-t border-border p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground" htmlFor={`line-name-${row.id}`}>Nombre de la línea</Label>
                    <Input
                      id={`line-name-${row.id}`}
                      maxLength={80}
                      autoComplete="off"
                      value={draft.line_name}
                      onChange={(e) => setDraft({ ...draft, line_name: e.target.value })}
                      className="bg-muted border-border text-foreground"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground" htmlFor={`line-area-${row.id}`}>Área</Label>
                    <select
                      id={`line-area-${row.id}`}
                      value={draft.area}
                      onChange={(e) => setDraft({ ...draft, area: e.target.value })}
                      className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
                    >
                      <option value="">Sin área</option>
                      {LINE_AREAS.map((a) => (
                        <option key={a} value={a}>{AREA_LABELS[a]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground" htmlFor={`line-logo-${row.id}`}>Logo (enlace)</Label>
                    <Input
                      id={`line-logo-${row.id}`}
                      type="url"
                      autoComplete="off"
                      placeholder="https://…"
                      value={draft.logo_url}
                      onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })}
                      className="bg-muted border-border text-foreground"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void save(row)} disabled={busyId === row.id || !draft.line_name.trim()}>
                    {busyId === row.id && <Loader2 className="size-3.5 animate-spin" />}
                    Guardar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}

            {reconnectingId === row.id && (
              <div data-line-reconnect className="space-y-2 border-t border-border p-4">
                <p className="text-sm text-muted-foreground">
                  Conecta de nuevo el mismo número para reactivar esta línea; sus conversaciones se conservan.
                </p>
                {reconnectSlot}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
