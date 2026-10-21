export interface AccountBrand {
  brand_name: string | null;
  logo_url: string | null;
}

/** Una marca incompleta sin logo conserva la identidad original de Wio. */
export function resolveAccountBrand(account?: Partial<AccountBrand> | null) {
  const logo = account?.logo_url?.trim();
  return logo
    ? { name: account?.brand_name?.trim() || "Wio CRM", logo, custom: true }
    : { name: "Wio CRM", logo: "/logo.png", custom: false };
}

/** Aísla errores de esquema, permisos o red de los datos obligatorios de sesión. */
export async function loadAccountBrand(
  query: () => PromiseLike<{ data: AccountBrand | null; error: unknown }>,
): Promise<AccountBrand> {
  try {
    const { data, error } = await query();
    if (!error && data) return data;
  } catch {
    // La marca es opcional: no debe impedir cargar la cuenta.
  }
  return { brand_name: null, logo_url: null };
}
