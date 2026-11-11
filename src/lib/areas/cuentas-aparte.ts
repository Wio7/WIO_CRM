// Cuentas hijas de un negocio que son restos de una persona que se registró
// sola con su correo: la persona ya está dentro del negocio. Función pura.

export interface PersonaConCorreo {
  id: string;
  email: string | null;
}

export interface CuentaHijaBasica {
  id: string;
  name: string;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Ata cada cuenta hija cuyo nombre es el correo de una persona del negocio
 * (sin distinguir mayúsculas) a esa persona. Las que no coinciden quedan en
 * `otras`. Si dos cuentas coinciden con la misma persona, la primera se ata y
 * la otra queda en `otras`, para no esconder ninguna.
 */
export function separarCuentasAparte<C extends CuentaHijaBasica>(
  personas: PersonaConCorreo[],
  hijas: C[],
): { porPersona: Map<string, C>; otras: C[] } {
  const porCorreo = new Map<string, string>();
  for (const p of personas) {
    const e = norm(p.email);
    if (e && !porCorreo.has(e)) porCorreo.set(e, p.id);
  }
  const porPersona = new Map<string, C>();
  const otras: C[] = [];
  for (const c of hijas) {
    const personaId = porCorreo.get(norm(c.name));
    if (personaId !== undefined && !porPersona.has(personaId)) porPersona.set(personaId, c);
    else otras.push(c);
  }
  return { porPersona, otras };
}
