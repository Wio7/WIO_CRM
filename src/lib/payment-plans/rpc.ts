// ============================================================
// Pagos de cuotas por RPC (migración 084).
//
// El dinero solo se escribe a través de estas funciones de la base: ellas
// validan monto, fecha, partes y permisos. Aquí no se duplica ninguna regla,
// solo se llama y se devuelve el mensaje de la base tal cual.
//
// Si la migración 084 todavía no está aplicada, PostgREST responde PGRST202
// (función inexistente): se avisa con `missing084` y NUNCA se cae a escribir
// en las tablas directamente.
// ============================================================

export type RpcResult =
  | { ok: true }
  | { ok: false; missing084: boolean; message: string };

interface RpcError {
  code?: string;
  message: string;
}

/** Lo mínimo del cliente de Supabase que usamos (facilita el test). */
export interface RpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
}

const MENSAJE_084 = "Falta aplicar la migración 084 (pagos protegidos) en Supabase.";

/** PGRST202 = PostgREST no encuentra la función: 084 sin aplicar. */
export function isMissing084(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "PGRST202";
}

async function llamar(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const { error } = await client.rpc(fn, args);
  if (!error) return { ok: true };
  if (isMissing084(error)) return { ok: false, missing084: true, message: MENSAJE_084 };
  return { ok: false, missing084: false, message: error.message };
}

export function registerPayment(
  client: RpcClient,
  a: {
    installmentId: string;
    amount: number;
    method?: string | null;
    reference?: string | null;
    voucherPath?: string | null;
    paidOn?: string | null;
  },
): Promise<RpcResult> {
  return llamar(client, "register_installment_payment", {
    p_installment_id: a.installmentId,
    p_amount: a.amount,
    p_method: a.method ?? null,
    p_reference: a.reference ?? null,
    p_voucher_path: a.voucherPath ?? null,
    p_paid_on: a.paidOn ?? null,
  });
}

export function registerAdvance(
  client: RpcClient,
  a: {
    planId: string;
    installmentIds: string[];
    method?: string | null;
    reference?: string | null;
    voucherPath?: string | null;
    paidOn?: string | null;
  },
): Promise<RpcResult> {
  return llamar(client, "register_advance_payment", {
    p_plan_id: a.planId,
    p_installment_ids: a.installmentIds,
    p_method: a.method ?? null,
    p_reference: a.reference ?? null,
    p_voucher_path: a.voucherPath ?? null,
    p_paid_on: a.paidOn ?? null,
  });
}

export function voidPayment(
  client: RpcClient,
  a: { paymentId: string; reason: string },
): Promise<RpcResult> {
  return llamar(client, "void_installment_payment", {
    p_payment_id: a.paymentId,
    p_reason: a.reason,
  });
}

export function createPlan(
  client: RpcClient,
  payload: Record<string, unknown>,
): Promise<RpcResult> {
  return llamar(client, "create_payment_plan", { p: payload });
}

export function rejectVoucher(
  client: RpcClient,
  a: { installmentId: string; reason: string },
): Promise<RpcResult> {
  return llamar(client, "reject_client_voucher", {
    p_installment_id: a.installmentId,
    p_reason: a.reason,
  });
}
