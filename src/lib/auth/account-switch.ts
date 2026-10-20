import type { SupabaseClient } from "@supabase/supabase-js";

export const ACCOUNT_SWITCH_EVENT = "wio-account-switch";

/** Descartar el estado React anterior solo después de confirmar la transacción. */
export async function switchPlatformAccount(
  supabase: SupabaseClient,
  accountId: string | null,
) {
  const { error } = accountId === null
    ? await supabase.rpc("platform_admin_exit_account")
    : await supabase.rpc("platform_admin_enter_account", { p_account_id: accountId });
  if (error) throw error;
  try {
    // Las otras pestañas de este navegador también descartan su estado anterior.
    localStorage.setItem(ACCOUNT_SWITCH_EVENT, crypto.randomUUID());
  } catch {
    // La recarga de esta pestaña no depende del almacenamiento del navegador.
  }
  window.location.assign(accountId === null ? "/saas-owner" : "/dashboard");
}
