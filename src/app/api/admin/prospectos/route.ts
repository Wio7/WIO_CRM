import { NextResponse } from "next/server";
import { requireSuperAdmin, toErrorResponse } from "@/lib/auth/account";

// Puente al formulario de prospectos (Worker de Cloudflare). No hay clave
// compartida: se reenvía la sesión del super admin y el Worker la comprueba
// contra Supabase con is_super_admin().
const BASE = process.env.PROSPECTOS_URL || "https://wio-formulario.bry-ig-media.workers.dev";
const ID = /^[0-9a-f-]{36}$/;

async function forward(request: Request, path: string, method: "GET" | "PATCH", body?: string) {
  const { supabase } = await requireSuperAdmin();
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) return NextResponse.json({ error: "Vuelve a iniciar sesión" }, { status: 401 });

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      body,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[prospectos]", err);
    return NextResponse.json({ error: "El formulario no responde" }, { status: 502 });
  }
}

export async function GET(request: Request) {
  try {
    return await forward(request, "/api/fichas", "GET");
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const b = (await request.json().catch(() => null)) as { id?: unknown; estado?: unknown; notas?: unknown } | null;
    if (typeof b?.id !== "string" || !ID.test(b.id) || typeof b.estado !== "string" || typeof b.notas !== "string") {
      return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
    }
    return await forward(request, `/api/respuestas/${b.id}`, "PATCH", JSON.stringify({ estado: b.estado, notas: b.notas }));
  } catch (err) {
    return toErrorResponse(err);
  }
}
