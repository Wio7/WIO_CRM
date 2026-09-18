"use client";

// ============================================================
// Configuración → Correo: conectar un buzón de Gmail a la bandeja (054).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Mail, Unplug, AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

interface Estado {
  configurado: boolean;
  migracion: boolean;
  conectado: boolean;
  email: string | null;
  ultima: string | null;
  error: string | null;
}

export function EmailConfig() {
  const params = useSearchParams();
  const [estado, setEstado] = useState<Estado | null>(null);

  const cargar = useCallback(async () => {
    const r = await fetch("/api/gmail/status").then((x) => x.json()).catch(() => null);
    setEstado(r);
  }, []);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const r = await fetch("/api/gmail/status").then((x) => x.json()).catch(() => null);
      if (!cancelado) setEstado(r);
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  useEffect(() => {
    const error = params.get("error");
    const conectado = params.get("connected");
    if (error) toast.error(error);
    if (conectado) toast.success(`Conectado: ${conectado}`);
  }, [params]);

  // Una redirección de verdad: el permiso se da en la página de Google.
  const conectar = () => {
    window.location.href = "/api/gmail/oauth/start";
  };

  async function desconectar() {
    if (!window.confirm("¿Desconectar el correo? Dejarán de entrar correos nuevos a la bandeja.")) return;
    const r = await fetch("/api/gmail/status", { method: "DELETE" });
    if (r.ok) {
      toast.success("Correo desconectado");
      cargar();
    } else toast.error("No se pudo desconectar");
  }

  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title="Correo"
        description="Los correos que llegan a tu Gmail entran a la bandeja como un chat más (“Por correo”), y la respuesta sale desde ese mismo buzón."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" /> Gmail
          </CardTitle>
          <CardDescription>
            Se revisa cada 5 minutos (con el mismo reloj de los recordatorios). Se ignoran promociones, redes sociales y
            correos automáticos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!estado ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : !estado.configurado ? (
            <p className="flex gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Falta crear la app de Google y poner GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel.
            </p>
          ) : !estado.migracion ? (
            <p className="flex gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Falta correr la migración 054 en Supabase.
            </p>
          ) : estado.conectado ? (
            <>
              <p className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Conectado: <b>{estado.email}</b>
              </p>
              <p className="text-muted-foreground">
                Última revisión: {estado.ultima ? new Date(estado.ultima).toLocaleString("es-PE") : "todavía no"}
              </p>
              {estado.error && <p className="text-red-400">Último error: {estado.error}</p>}
              <div className="flex gap-2">
                <Button variant="outline" onClick={conectar}>
                  Conectar otro buzón
                </Button>
                <Button variant="ghost" onClick={desconectar} className="text-muted-foreground hover:text-red-400">
                  <Unplug className="mr-1 h-4 w-4" /> Desconectar
                </Button>
              </div>
            </>
          ) : (
            <Button onClick={conectar}>Conectar Gmail</Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
