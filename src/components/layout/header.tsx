"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { resolveAccountBrand } from "@/lib/account-brand";
import { LogOut, Settings as SettingsIcon, User } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";

const pageTitles: Record<string, string> = {
  "/dashboard": "Panel Principal",
  "/saas-owner": "Cuentas",
  "/prospectos": "Prospectos",
  "/inbox": "Bandeja de Entrada",
  "/notifications": "Notificaciones",
  "/contacts": "Contactos",
  "/pipelines": "Embudos de Venta",
  "/projects": "Proyectos Inmobiliarios",
  "/reservations": "Centro de Separaciones",
  "/payment-plans": "Cuotas y Cobranzas",
  "/calendar": "Calendario",
  "/dialer": "Marcador",
  "/calls": "Llamadas",
  "/broadcasts": "Difusiones",
  "/automations": "Automatizaciones",
  "/settings": "Configuración",
};

function getPageTitle(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "Dashboard";
}

export function Header() {
  const pathname = usePathname();
  const { profile, account, signOut } = useAuth();
  const brand = resolveAccountBrand(account);
  const title = getPageTitle(pathname);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Celular: logo de la cuenta; el menú vive en la barra inferior. */}
        <Link href="/dashboard" aria-label="Inicio" className="shrink-0 lg:hidden">
          <img
            src={brand.custom ? brand.logo : "/app-icon-192.png"}
            alt=""
            className={`size-9 rounded-xl object-contain ${brand.custom ? "bg-[#021736]" : ""}`}
          />
        </Link>
        <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
          {pathname === "/dashboard" ? (
            <>
              <span className="lg:hidden">{brand.name}</span>
              <span className="hidden lg:inline">{title}</span>
            </>
          ) : (
            title
          )}
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label="Open account menu"
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? "Avatar"}
              />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? "User"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? "User"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            Perfil
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=whatsapp"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            Configuración
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            Cerrar Sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
