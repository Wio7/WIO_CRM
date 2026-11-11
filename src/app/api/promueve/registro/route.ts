// ============================================================
// /api/promueve/registro — autoregistro de asesores Promueve
//
//   POST (público; lo llama la Golden App desde su dominio)
//        { nombre, celular, correo, password, codigo }
//     → { ok: true } | { ok: false, reason, message, campo? }
//
// Promueve = asesores de venta externos que venden lotes por comisión. Crean
// su propio acceso, pero SOLO con el código de invitación que reparte el
// dueño (tabla promueve_invites, migración 089). Sin código válido no se crea
// nada. Después de { ok: true } la app inicia sesión normal con correo y
// contraseña.
//
// Qué protege:
//   · Límite por IP (8 intentos / 15 min) y por correo (5 / hora).
//   · El código se comprueba ANTES de crear el usuario: con un código malo no
//     se toca Auth. Solo se guarda su hash SHA-256.
//   · Nada de "ese correo ya existe" a un anónimo: un correo repetido recibe
//     el mismo mensaje genérico que cualquier otro fallo de creación (y solo
//     se llega ahí con un código válido).
//   · Atómico: promueve_registrar mueve el perfil y consume el uso del código
//     en UNA transacción. Si falla, se borra la cuenta personal y el usuario
//     de Auth recién creados: no queda nadie huérfano.
//   · El usuario nace con account_role = 'agent' y area = 'promueve'; con esa
//     área is_account_member() lo deja fuera de los datos del CRM.
// ============================================================

import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "@/lib/cors";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { validarRegistro } from "@/lib/promueve/registro";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const LIMITE_IP = { limit: 8, windowMs: 15 * 60_000 };
const LIMITE_CORREO = { limit: 5, windowMs: 60 * 60_000 };

const MENSAJE_CODIGO = "El código no es válido o ya venció. Pídele uno a Golden Habitat.";
const MENSAJE_NO_SE_PUDO =
  "No pudimos crear la cuenta con esos datos. Si ya te registraste, entra con tu correo y contraseña.";

function ipDe(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

const responder = (request: Request, cuerpo: object, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

const fallo = (request: Request, reason: string, message: string, status: number, campo?: string) =>
  responder(request, { ok: false, reason, message, ...(campo ? { campo } : {}) }, status);

function yaExiste(error: { message?: string; status?: number; code?: string }) {
  return (
    error.code === "email_exists" ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? "")
  );
}

/** Deshace un registro a medias: la cuenta personal que creó Auth y el usuario. */
async function deshacer(db: ReturnType<typeof supabaseAdmin>, userId: string) {
  try {
    const { data: perfil } = await db.from("profiles").select("account_id").eq("user_id", userId).maybeSingle();
    // Solo si la cuenta es del propio usuario: nunca la de Golden.
    if (perfil?.account_id) await db.from("accounts").delete().eq("id", perfil.account_id).eq("owner_user_id", userId);
    await db.auth.admin.deleteUser(userId);
  } catch (err) {
    console.error("[promueve/registro] no se pudo deshacer:", (err as Error).message);
  }
}

export async function POST(request: Request) {
  const porIp = checkRateLimit(`promueve-registro:ip:${ipDe(request)}`, LIMITE_IP);
  if (!porIp.success) return withCors(request, rateLimitResponse(porIp));

  const body = await request.json().catch(() => null);
  const v = validarRegistro(body);
  if (!v.ok) return fallo(request, "invalid_input", v.mensaje, 400, v.campo);
  const { nombre, celular, correo, password, codigoHash } = v.datos;

  const porCorreo = checkRateLimit(`promueve-registro:correo:${correo}`, LIMITE_CORREO);
  if (!porCorreo.success) return withCors(request, rateLimitResponse(porCorreo));

  const db = supabaseAdmin();

  // 1. El código, antes de crear nada.
  const { data: cuenta, error: errCodigo } = await db.rpc("promueve_check_code", { p_code_hash: codigoHash });
  if (errCodigo) {
    console.error("[promueve/registro] promueve_check_code:", errCodigo.message);
    return fallo(request, "server_error", "No pudimos crear tu cuenta ahora. Intenta de nuevo en unos minutos.", 500);
  }
  if (!cuenta) return fallo(request, "invalid_code", MENSAJE_CODIGO, 400, "codigo");

  // 2. El usuario de Auth (el trigger le abre una cuenta personal vacía).
  const { data: creado, error: errUsuario } = await db.auth.admin.createUser({
    email: correo,
    password,
    email_confirm: true,
    user_metadata: { full_name: nombre, phone: celular, origen: "promueve" },
  });
  if (errUsuario || !creado?.user) {
    if (errUsuario?.code === "weak_password") {
      return fallo(request, "weak_password", "Esa contraseña es muy fácil de adivinar. Elige otra.", 400, "password");
    }
    if (errUsuario && !yaExiste(errUsuario)) {
      console.error("[promueve/registro] createUser:", errUsuario.message);
    }
    // Correo repetido o cualquier otro fallo: misma respuesta, sin confirmar nada.
    return fallo(request, "no_se_pudo", MENSAJE_NO_SE_PUDO, 409);
  }
  const userId = creado.user.id;

  // 3. Perfil de Promueve en la cuenta de Golden, atómico.
  const { error: errRegistro } = await db.rpc("promueve_registrar", {
    p_user_id: userId,
    p_full_name: nombre,
    p_phone: celular,
    p_code_hash: codigoHash,
  });
  if (errRegistro) {
    await deshacer(db, userId);
    // 22023 = código agotado o desactivado entre el paso 1 y este (otro se lo ganó).
    if (errRegistro.code === "22023") return fallo(request, "invalid_code", MENSAJE_CODIGO, 400, "codigo");
    console.error("[promueve/registro] promueve_registrar:", errRegistro.message);
    return fallo(request, "server_error", "No pudimos crear tu cuenta ahora. Intenta de nuevo en unos minutos.", 500);
  }

  return responder(request, { ok: true });
}
