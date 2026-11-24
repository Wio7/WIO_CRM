"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LogOut, MoreHorizontal, Network, Settings, User } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { navItems } from "@/components/layout/nav-items";
import { useAuth } from "@/hooks/use-auth";
import { useMyArea } from "@/hooks/use-my-area";
import { useUnread } from "@/components/layout/unread-provider";
import { puedeVerCuentas } from "@/lib/areas/destinos";
import { cajaMenuLabel } from "@/lib/cash/menu";
import { TAB_LABEL, mobileTabs, visibleAreas } from "@/lib/mobile-tabs";
import { TONES } from "@/lib/tones";
import { cn } from "@/lib/utils";

const isIn = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Navegación del celular: cuatro pestañas y "Más" con todo lo demás en íconos. */
export function MobileTabBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { account, accountRole, isSuperAdmin, moduleAccess, signOut } = useAuth();
  const { area } = useMyArea();
  const { chats: unread, notifications } = useUnread();

  const tabs = mobileTabs(account?.disabled_modules, moduleAccess);
  const areas = visibleAreas(account?.disabled_modules, moduleAccess);
  const inMore = !tabs.some((h) => isIn(pathname, h));
  const close = () => setOpen(false);

  const general = [
    ...(isSuperAdmin
      ? [{ href: "/saas-owner", label: "Cuentas", icon: Building2 }]
      : puedeVerCuentas({ role: accountRole, area })
        ? [{ href: "/cuentas", label: "Cuentas", icon: Network }]
        : []),
    { href: "/settings?tab=profile", label: "Mi perfil", icon: User },
    { href: "/settings", label: "Configuración", icon: Settings },
  ];

  return (
    <nav
      data-tab-bar
      aria-label="Secciones"
      className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto grid max-w-lg auto-cols-fr grid-flow-col px-1 py-1.5">
        {tabs.map((href) => {
          const item = navItems.find((n) => n.href === href);
          if (!item) return null;
          const active = isIn(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn("flex flex-col items-center gap-0.5 text-xs font-semibold", active ? "text-foreground" : "text-muted-foreground")}
              >
                <span className={cn("relative flex h-9 w-14 items-center justify-center rounded-full transition-colors", active && "bg-primary text-primary-foreground")}>
                  <item.icon className="size-5" aria-hidden />
                  {href === "/inbox" && unread > 0 && (
                    <span className="absolute -top-0.5 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold text-white">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </span>
                {TAB_LABEL[href]}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={cn("flex w-full flex-col items-center gap-0.5 text-xs font-semibold", inMore ? "text-foreground" : "text-muted-foreground")}
          >
            <span className={cn("relative flex h-9 w-14 items-center justify-center rounded-full", inMore && "bg-primary text-primary-foreground")}>
              <MoreHorizontal className="size-5" aria-hidden />
              {notifications > 0 && <span className="absolute top-1 right-3 size-2.5 rounded-full bg-rose-600" />}
            </span>
            Más
          </button>
        </li>
      </ul>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-3xl p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:hidden">
          <SheetTitle className="text-xl font-bold">Todo tu sistema</SheetTitle>
          {areas.map((a) => (
            <section key={a.key} className="mt-5">
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{a.label}</h3>
              <ul className="grid grid-cols-3 gap-2">
                {a.hrefs.map((href) => {
                  const item = navItems.find((n) => n.href === href);
                  if (!item) return null;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={close}
                        aria-current={isIn(pathname, href) ? "page" : undefined}
                        className={cn("relative flex h-full min-h-24 flex-col items-center gap-2 rounded-2xl border p-3 text-center text-[13px] leading-tight font-medium", TONES[a.tone].card, isIn(pathname, href) && "ring-2 ring-primary")}
                      >
                        <span className={cn("flex size-11 items-center justify-center rounded-xl", TONES[a.tone].icon)}>
                          <item.icon className="size-5" aria-hidden />
                        </span>
                        {href === "/caja" ? cajaMenuLabel(account?.name, account?.brand_name) : item.label}
                        {href === "/notifications" && notifications > 0 && (
                          <span className="absolute top-1.5 right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold text-white">
                            {notifications > 9 ? "9+" : notifications}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <section className="mt-5 grid gap-1 border-t border-border pt-3">
            {general.map((g) => (
              <Link key={g.href} href={g.href} onClick={close} className="flex min-h-12 items-center gap-3 rounded-xl px-2 font-medium hover:bg-muted">
                <g.icon className="size-5 text-muted-foreground" aria-hidden />
                {g.label}
              </Link>
            ))}
            <button type="button" onClick={signOut} className="flex min-h-12 items-center gap-3 rounded-xl px-2 text-left font-medium hover:bg-muted">
              <LogOut className="size-5 text-muted-foreground" aria-hidden />
              Cerrar sesión
            </button>
          </section>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
