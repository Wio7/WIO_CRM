"use client";

// Home for accounts that only run WhatsApp campaigns (no sales pipeline,
// see isSimpleAccount): three big actions and how the last campaign went.

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, MessageSquare, Radio, Upload } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { resolveAccountBrand } from "@/lib/account-brand";
import { getBroadcastStatus } from "@/lib/broadcast-status";
import type { Broadcast } from "@/types";

interface HomeData {
  lastBroadcast: Broadcast | null;
  unreadChats: number;
  approvedTemplates: number;
  pendingTemplates: number;
}

const ACTIONS = [
  {
    href: "/broadcasts/new",
    title: "Enviar campaña",
    text: "Sube tu Excel, elige la plantilla y envía ahora o prográmala.",
    icon: Upload,
  },
  {
    href: "/broadcasts/templates",
    title: "Mis plantillas",
    text: "Escribe el mensaje y mándalo a aprobar a WhatsApp.",
    icon: FileText,
  },
  {
    href: "/inbox",
    title: "Ver respuestas",
    text: "Contesta a las personas que te escribieron.",
    icon: MessageSquare,
  },
] as const;

export function SimpleHome() {
  const { account, accountId } = useAuth();
  const brand = resolveAccountBrand(account);
  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const [last, unread, approved, pending] = await Promise.all([
        supabase
          .from("broadcasts")
          .select("*")
          .eq("account_id", accountId)
          .neq("status", "draft")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("account_id", accountId)
          .gt("unread_count", 0),
        supabase
          .from("message_templates")
          .select("id", { count: "exact", head: true })
          .eq("account_id", accountId)
          .eq("status", "APPROVED"),
        supabase
          .from("message_templates")
          .select("id", { count: "exact", head: true })
          .eq("account_id", accountId)
          .eq("status", "PENDING"),
      ]);
      if (cancelled) return;
      setData({
        lastBroadcast: (last.data as Broadcast | null) ?? null,
        unreadChats: unread.count ?? 0,
        approvedTemplates: approved.count ?? 0,
        pendingTemplates: pending.count ?? 0,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const last = data?.lastBroadcast;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Hola, {brand.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">¿Qué quieres hacer hoy?</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ACTIONS.map(({ href, title, text, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <p className="text-base font-semibold text-foreground">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{text}</p>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">Mensajes sin responder</p>
          <p className="mt-1 text-3xl font-bold text-foreground">{data ? data.unreadChats : "–"}</p>
          {data && data.unreadChats > 0 && (
            <Link href="/inbox" className="mt-2 inline-block text-sm text-primary hover:underline">
              Responder ahora
            </Link>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">Plantillas</p>
          <p className="mt-1 text-3xl font-bold text-foreground">{data ? data.approvedTemplates : "–"}</p>
          <p className="text-sm text-muted-foreground">
            aprobadas
            {data && data.pendingTemplates > 0 && ` · ${data.pendingTemplates} en revisión`}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">Tu última campaña</p>
        </div>
        {!data ? (
          <p className="mt-3 text-sm text-muted-foreground">Cargando…</p>
        ) : !last ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Todavía no enviaste ninguna. Empieza con &quot;Enviar campaña&quot;.
          </p>
        ) : (
          <Link href={`/broadcasts/${last.id}`} className="mt-3 block">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-foreground">{last.name}</p>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${getBroadcastStatus(last.status).classes}`}
              >
                {getBroadcastStatus(last.status).label}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["Personas", last.total_recipients],
                ["Enviados", last.sent_count],
                ["Entregados", last.delivered_count],
                ["Leídos", last.read_count],
                ["Respondieron", last.replied_count],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-xl bg-muted/50 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-lg font-bold text-foreground">{(value as number) ?? 0}</p>
                </div>
              ))}
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
