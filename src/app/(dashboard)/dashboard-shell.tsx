"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, isAccountInactive, signOut } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Cargando...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  if (isAccountInactive) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#070708] px-4 text-white relative overflow-hidden">
        {/* Background Mesh Gradients */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
          <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-rose-500/20 rounded-full blur-[140px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-primary/20 rounded-full blur-[140px]" />
        </div>
        <div className="w-full max-w-md border-white/5 bg-[#121214] border-2 rounded-[2rem] p-8 text-center space-y-6 relative z-10 shadow-2xl">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500 border border-rose-500/20">
            <Lock className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-black text-white uppercase tracking-tight">Cuenta Inactiva</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Tu cuenta de Wio CRM está actualmente inactiva o suspendida. Por favor, ponte en contacto con el soporte o el administrador principal para reactivarla.
          </p>
          <Button
            onClick={() => signOut()}
            variant="outline"
            className="w-full h-11 rounded-xl border-white/5 bg-white/5 hover:bg-rose-500/20 hover:border-rose-500/50 hover:text-white transition-all text-xs font-bold uppercase tracking-widest"
          >
            Cerrar Sesión
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
