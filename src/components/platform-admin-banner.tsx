"use client";

import { useEffect, useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { ACCOUNT_SWITCH_EVENT, switchPlatformAccount } from "@/lib/auth/account-switch";
import { Button } from "@/components/ui/button";

export function PlatformAdminBanner() {
  const { isVisiting, isSuperAdmin, account, accountId, user } = useAuth();
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin || !user || !accountId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACCOUNT_SWITCH_EVENT) window.location.reload();
    };
    // El cambio es por usuario: al volver desde otro dispositivo, descartar
    // el estado si profiles ya apunta a otra cuenta. No hay otra fuente de cuenta.
    const onFocus = async () => {
      const { data, error } = await createClient().from("profiles")
        .select("account_id").eq("user_id", user.id).maybeSingle();
      if (!error && data && data.account_id !== accountId) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [isSuperAdmin, user, accountId]);

  if (!isVisiting) return null;

  const exit = async () => {
    setExiting(true);
    try {
      await switchPlatformAccount(createClient(), null);
    } catch {
      toast.error("No se pudo salir de la cuenta. Vuelve a intentarlo.");
      setExiting(false);
    }
  };

  return (
    <>
      <div className="h-20 sm:h-14" aria-hidden="true" />
      <div data-platform-admin-banner role="status" className="fixed inset-x-0 top-0 z-[100] flex h-20 items-center justify-center gap-3 border-b border-amber-700 bg-amber-300 px-4 text-sm font-semibold text-amber-950 shadow-md sm:h-14">
        <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span>Estás dentro de «{account?.name ?? accountId ?? "la cuenta seleccionada"}» como superadmin</span>
        <Button variant="outline" disabled={exiting} onClick={exit} className="shrink-0 border-amber-900 bg-amber-100 text-amber-950 hover:bg-amber-200">
          <LogOut className="h-4 w-4" /> {exiting ? "Saliendo…" : "Salir"}
        </Button>
      </div>
    </>
  );
}
