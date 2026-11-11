// Reglas puras del autoregistro de asesores Promueve (sin Supabase, sin red).
// Las usa POST /api/promueve/registro y las prueba registro.test.ts.
//
// El código de invitación se guarda solo como hash. La normalización (mayúsculas,
// sin espacios ni guiones) es la MISMA que promueve_hash_code() de la migración
// 089: si cambia una, cambia la otra.

import { createHash } from "node:crypto";

export const MIN_PASSWORD = 8;
/** bcrypt (Supabase Auth) corta en 72 bytes: más largo no suma seguridad. */
export const MAX_PASSWORD = 72;

export function normalizarCodigo(codigo: string): string {
  return codigo.replace(/[\s-]/g, "").toUpperCase();
}

/** SHA-256 (hex) del código normalizado; igual a promueve_hash_code() en SQL. */
export function hashCodigo(codigo: string): string {
  return createHash("sha256").update(normalizarCodigo(codigo), "utf8").digest("hex");
}

/** Celular peruano de 9 dígitos que empieza en 9; acepta +51, espacios y guiones. */
export function normalizarCelular(valor: string): string | null {
  const digitos = valor.replace(/[\s().-]/g, "").replace(/^\+?51(?=9\d{8}$)/, "");
  return /^9\d{8}$/.test(digitos) ? `+51${digitos}` : null;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const NOMBRE_RE = /^\p{L}[\p{L}\p{M} .'’-]{0,78}\p{L}$/u;

export type CampoRegistro = "nombre" | "celular" | "correo" | "password" | "codigo";

export interface RegistroValido {
  nombre: string;
  celular: string;
  correo: string;
  password: string;
  codigoHash: string;
}

export type ResultadoValidacion =
  | { ok: true; datos: RegistroValido }
  | { ok: false; campo: CampoRegistro; mensaje: string };

const MENSAJES: Record<CampoRegistro, string> = {
  nombre: "Escribe tu nombre completo.",
  celular: "Escribe un celular de 9 dígitos que empiece con 9.",
  correo: "Escribe un correo válido.",
  password: `La contraseña debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres.`,
  codigo: "Escribe el código de invitación que te dieron.",
};

const texto = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Validación estricta del cuerpo. El primer campo malo corta. */
export function validarRegistro(body: unknown): ResultadoValidacion {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const falla = (campo: CampoRegistro): ResultadoValidacion => ({ ok: false, campo, mensaje: MENSAJES[campo] });

  const nombre = texto(b.nombre)?.trim().replace(/\s+/g, " ") ?? "";
  if (!nombre || nombre.length > 80 || !NOMBRE_RE.test(nombre)) return falla("nombre");

  const celular = normalizarCelular(texto(b.celular) ?? "");
  if (!celular) return falla("celular");

  const correo = texto(b.correo)?.trim().toLowerCase() ?? "";
  if (!correo || correo.length > 254 || !EMAIL_RE.test(correo)) return falla("correo");

  const password = texto(b.password) ?? "";
  if (password.length < MIN_PASSWORD || new TextEncoder().encode(password).length > MAX_PASSWORD) {
    return falla("password");
  }

  const codigo = normalizarCodigo(texto(b.codigo) ?? "");
  if (codigo.length < 8 || codigo.length > 32 || !/^[A-Z0-9]+$/.test(codigo)) return falla("codigo");

  return { ok: true, datos: { nombre, celular, correo, password, codigoHash: hashCodigo(codigo) } };
}
