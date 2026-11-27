"use client";

// Logo (o iniciales) + nombre de la línea de WhatsApp de una conversación.
// Solo se pinta cuando la cuenta tiene más de una línea (ver line-filter.ts).

import { cn } from "@/lib/utils";
import type { ConversationLineLabel } from "@/lib/inbox/line-filter";

export function LineBadge({
  label,
  className,
}: {
  label: ConversationLineLabel;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground", className)}
      title={`Línea: ${label.name} · ${label.areaLabel}`}
    >
      {label.logoUrl ? (
        <img src={label.logoUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover" />
      ) : (
        <span className="flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm bg-muted px-0.5 text-[8px] font-semibold text-foreground">
          {label.initials}
        </span>
      )}
      <span className="truncate">{label.name}</span>
    </span>
  );
}
