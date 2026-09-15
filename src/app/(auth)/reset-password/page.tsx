"use client";

// ============================================================
// /reset-password — set a new password.
//
// Reached from the "forgot password" email through /auth/callback,
// which has already opened the session. Also the way out for anyone
// invited by email who never created a password: "forgot password"
// works for them too.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

const GOLDEN_APP_URL =
  process.env.NEXT_PUBLIC_GOLDEN_APP_URL?.replace(/\/+$/, "") || null;

export default function ResetPasswordPage() {
  const [conSesion, setConSesion] = useState<boolean | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setConSesion(Boolean(data.user)))
      .catch(() => setConSesion(false));
  }, []);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres");
      return;
    }
    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden");
      return;
    }
    setLoading(true);
    const { error } = await createClient().auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setListo(true);
  };

  if (conSesion === undefined) {
    return (
      <Pantalla>
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </CardContent>
      </Pantalla>
    );
  }

  if (!conSesion) {
    return (
      <Pantalla>
        <CardHeader className="items-center text-center">
          <CardTitle className="text-xl text-foreground">El enlace venció</CardTitle>
          <CardDescription className="text-muted-foreground">
            Pide un enlace nuevo y ábrelo en este mismo navegador.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/forgot-password">
            <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Pedir un enlace nuevo
            </Button>
          </Link>
        </CardContent>
      </Pantalla>
    );
  }

  if (listo) {
    return (
      <Pantalla>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <CheckCircle className="h-6 w-6 text-emerald-400" />
          </div>
          <CardTitle className="text-xl text-foreground">Contraseña guardada</CardTitle>
          <CardDescription className="text-muted-foreground">
            Ya puedes entrar con tu correo y esta contraseña, aquí y en la Golden App.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {GOLDEN_APP_URL && (
            <a href={GOLDEN_APP_URL}>
              <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Abrir la Golden App
              </Button>
            </a>
          )}
          <a href="/dashboard">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Ir al CRM
            </Button>
          </a>
        </CardContent>
      </Pantalla>
    );
  }

  return (
    <Pantalla>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <KeyRound className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">Crea tu nueva contraseña</CardTitle>
        <CardDescription className="text-muted-foreground">
          La usarás para entrar al CRM y a la Golden App.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={guardar} className="flex flex-col gap-4">
          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-muted-foreground">
              Nueva contraseña
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="Mínimo 6 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className="text-muted-foreground">
              Confirmar contraseña
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Repite tu contraseña"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Guardando..." : "Guardar contraseña"}
          </Button>
        </form>
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
