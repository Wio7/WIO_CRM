"use client";

// ============================================================
// /auth/confirm?token_hash=…&type=invite&next=https://…/join/<token>
//
// Landing for the invitation and access-link emails (see
// docs/email-templates). It verifies the link only when the person
// presses the button, never on page load: Outlook/Hotmail and many
// antivirus products open every link in an email to scan it, and a
// page that verified on load would spend the one-time link before its
// owner ever tapped it. Scanners don't press buttons.
// ============================================================

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { AlertTriangle, Loader2, MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { inviteTokenFromPath, safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/client";

const TIPOS: EmailOtpType[] = ["invite", "magiclink", "email", "signup", "recovery", "email_change"];

export default function ConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmInner />
    </Suspense>
  );
}

function ConfirmInner() {
  const searchParams = useSearchParams();
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const [estado, setEstado] = useState<"listo" | "verificando" | "error">("listo");

  const valido = Boolean(tokenHash && type && TIPOS.includes(type));
  const destinoRaw = searchParams.get("next");

  const continuar = async () => {
    if (!valido) return;
    setEstado("verificando");
    const { error } = await createClient().auth.verifyOtp({
      token_hash: tokenHash!,
      type: type!,
    });
    if (error) {
      console.error("[auth/confirm] verifyOtp failed:", error.message);
      setEstado("error");
      return;
    }
    const origin = window.location.origin;
    const fallback = type === "recovery" ? "/reset-password" : "/dashboard";
    const destino = new URL(safeNext(destinoRaw, origin, fallback), origin);
    // Invited by email: the account has no password yet. The join page
    // asks for one before accepting.
    if (type === "invite") destino.searchParams.set("clave", "1");
    // Full navigation so the new session cookies reach the server.
    window.location.replace(destino.pathname + destino.search);
  };

  const invite =
    destinoRaw && typeof window !== "undefined"
      ? inviteTokenFromPath(safeNext(destinoRaw, window.location.origin, ""))
      : null;

  if (!valido || estado === "error") {
    return (
      <Pantalla>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <AlertTriangle className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Este enlace ya se usó o venció
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Los enlaces de los correos sirven una sola vez y por poco tiempo.
            Pide a quien te invitó que te envíe uno nuevo, o entra con tu
            contraseña si ya la creaste.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Link href={invite ? `/login?invite=${encodeURIComponent(invite)}` : "/login"}>
            <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Iniciar sesión
            </Button>
          </Link>
          <Link href="/forgot-password">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Crear o recuperar mi contraseña
            </Button>
          </Link>
        </CardContent>
      </Pantalla>
    );
  }

  return (
    <Pantalla>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <MailCheck className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">
          {type === "invite" ? "Activa tu acceso" : "Continúa a tu cuenta"}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {type === "invite"
            ? "Pulsa el botón para activar tu acceso. Luego crearás tu contraseña."
            : "Pulsa el botón para entrar con este enlace."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          onClick={continuar}
          disabled={estado === "verificando"}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {estado === "verificando" ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Verificando…
            </>
          ) : (
            "Continuar"
          )}
        </Button>
      </CardContent>
    </Pantalla>
  );
}

function Pantalla({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">{children}</Card>
    </div>
  );
}
