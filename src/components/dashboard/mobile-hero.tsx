"use client";

import Link from "next/link";
import { Ondas } from "@/components/layout/ondas";
import { navItems } from "@/components/layout/nav-items";
import { useAuth } from "@/hooks/use-auth";
import { useUnread } from "@/components/layout/unread-provider";
import { TAB_LABEL, visibleAreas } from "@/lib/mobile-tabs";
import { TONES } from "@/lib/tones";
import { cn } from "@/lib/utils";

const SHORTCUTS = ["/inbox", "/contacts", "/pipelines", "/calendar", "/broadcasts", "/collections", "/store", "/agents"];

/** Inicio del celular: saludo, lo urgente y accesos de un toque. */
export function MobileHero() {
  const { profile, account, moduleAccess } = useAuth();
  const { chats: unread } = useUnread();
  const name = profile?.full_name?.trim().split(" ")[0];
  const items = visibleAreas(account?.disabled_modules, moduleAccess).flatMap((a) =>
    a.hrefs.map((href) => ({ href, tone: a.tone })),
  );
  const shortcuts = SHORTCUTS.flatMap((h) => items.filter((i) => i.href === h)).slice(0, 4);
  const inbox = items.some((i) => i.href === "/inbox");

  return (
    <div className="space-y-4 lg:hidden">
      <section className="wio-banda">
        <Ondas />
        <p className="wio-titulo text-3xl">Hola{name ? `, ${name}` : ""}</p>
        {inbox &&
          (unread > 0 ? (
            <Link href="/inbox" className="wio-cta mt-4">
              <span className="text-3xl font-bold tabular-nums">{unread}</span>
              <span className="flex-1 leading-tight font-semibold">{unread === 1 ? "chat por responder" : "chats por responder"}</span>
              <span aria-hidden className="text-xl">→</span>
            </Link>
          ) : (
            <p className="mt-1 text-white/80">Estás al día con tus chats.</p>
          ))}
      </section>
      <ul className="grid grid-cols-4 gap-2">
        {shortcuts.map(({ href, tone }) => {
          const item = navItems.find((n) => n.href === href);
          if (!item) return null;
          return (
            <li key={href}>
              <Link href={href} className="flex flex-col items-center gap-1.5 text-center text-xs font-semibold text-foreground">
                <span className={cn("flex size-14 items-center justify-center rounded-[6px_6px_20px_6px]", TONES[tone].icon)}>
                  <item.icon className="size-6" aria-hidden />
                </span>
                {TAB_LABEL[href] ?? item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
