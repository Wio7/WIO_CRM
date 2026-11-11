"use client";

// Login propio de la app de Cobranzas, dentro de su scope (/cobranzas): en
// Android la app instalada no salta a una pestaña del navegador para entrar.
// Antes de iniciar sesión no se sabe la cuenta, así que el título es genérico.

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { HandCoins, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/app-paths";
import { nombreApp } from "@/lib/apps/nombres";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { GoldenBody } from "@/components/apps/golden-frame";

function mensajeDeError(mensaje: string): string {
  if (/invalid login credentials/i.test(mensaje)) {
    return "Correo o contraseña incorrectos. Si te invitaron por correo y aún no creaste tu contraseña, usa «¿Olvidaste tu contraseña?».";
  }
  if (/email not confirmed/i.test(mensaje)) {
    return "Aún no confirmaste tu correo. Abre el enlace que te enviamos y vuelve a intentarlo.";
  }
  return mensaje;
}

export default function CobranzasLoginPage() {
  return (
    <Suspense fallback={null}>
      <Formulario />
    </Suspense>
  );
}

function Formulario() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: err } = await createClient().auth.signInWithPassword({ email, password });
    if (err) {
      setError(mensajeDeError(err.message));
      setLoading(false);
      return;
    }
    // Navegación completa: el servidor lee la sesión recién guardada en la cookie.
    window.location.assign(safeNextPath(searchParams.get("next"), "/cobranzas"));
  }

  return (
    <GoldenBody app="cobranzas">
    <main data-app-login className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <form onSubmit={entrar} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <HandCoins className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold">{nombreApp("cobranzas")}</h1>
          <p className="text-sm text-muted-foreground">Entra con tu correo y contraseña.</p>
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
            {error}
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Correo</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-11" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-11" />
        </div>
        <Button type="submit" disabled={loading} className="min-h-11 w-full">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Entrar"}
        </Button>
        <p className="text-center text-sm">
          <Link href="/forgot-password" className="text-muted-foreground underline">
            ¿Olvidaste tu contraseña?
          </Link>
        </p>
      </form>
    </main>
    </GoldenBody>
  );
}
