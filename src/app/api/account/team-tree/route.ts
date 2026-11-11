// ============================================================
// GET /api/account/team-tree
//
// Datos para la página Cuentas del dueño de un negocio: la gente de SU
// cuenta (con área y rol) y los módulos que tiene apagados. Solo el dueño
// y quienes tienen el área Gerencia; el resto recibe 403. Lee únicamente
// la cuenta del que llama (RLS de profiles + filtro por su account_id).
// ============================================================

import { NextResponse } from "next/server";

import { ForbiddenError, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { puedeVerCuentas } from "@/lib/areas/destinos";

type DbError = { code?: string; message?: string } | null;

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Su propia área (profiles.area, migración 046/084/085). Si la columna no
    // existe todavía, cuenta como sin área: solo el dueño pasa.
    const { data: yo, error: yoError } = await ctx.supabase
      .from("profiles")
      .select("area")
      .eq("user_id", ctx.userId)
      .maybeSingle();
    const miArea = yoError ? null : ((yo?.area as string | null | undefined) ?? null);

    if (!puedeVerCuentas({ role: ctx.role, area: miArea })) {
      throw new ForbiddenError("Solo el dueño o Gerencia pueden ver las cuentas del negocio");
    }

    const pedirGente = (columnas: string) =>
      ctx.supabase
        .from("profiles")
        .select(columnas)
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: true });

    let { data: gente, error } = (await pedirGente("id, full_name, email, account_role, area")) as unknown as {
      data: unknown;
      error: DbError;
    };
    if (error) {
      ({ data: gente, error } = (await pedirGente("id, full_name, email, account_role")) as unknown as {
        data: unknown;
        error: DbError;
      });
    }
    if (error) {
      console.error("[GET /api/account/team-tree] members error:", error);
      return NextResponse.json({ error: "No se pudo leer el equipo" }, { status: 500 });
    }

    // brand_name y disabled_modules vienen de migraciones propias: si faltan,
    // se vuelve a pedir lo básico en vez de romper la página.
    const pedirCuenta = (columnas: string) =>
      ctx.supabase.from("accounts").select(columnas).eq("id", ctx.accountId).maybeSingle();
    let cuenta = (await pedirCuenta("id, name, brand_name, disabled_modules")) as unknown as {
      data: Record<string, unknown> | null;
      error: DbError;
    };
    if (cuenta.error) {
      cuenta = (await pedirCuenta("id, name")) as unknown as typeof cuenta;
    }

    return NextResponse.json({
      account: cuenta.data ?? { id: ctx.accountId, name: ctx.account.name },
      members: gente ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
