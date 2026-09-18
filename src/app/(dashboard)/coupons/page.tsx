"use client";

// ============================================================
// /coupons — referidos y cupones (051).
//
// Arriba, lo que pide una decisión: clientes que trajeron a alguien que
// ya compró y todavía no recibieron su premio. "Dar cupón" le crea uno
// atado a su DNI. Debajo, todos los cupones: se crean a mano (promociones,
// descuentos negociados) y se marcan como usados al aplicarlos en la
// separación o el plan. Un cupón se usa una sola vez.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Gift, Ticket, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const nuevoCodigo = () => {
  const bytes = new Uint32Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join("");
};

interface Referido {
  id: string;
  status: string;
  created_at: string;
  converted_at: string | null;
  padrino: { id: string; name: string | null; phone: string | null; dni: string | null } | null;
  referido: { name: string | null; phone: string | null } | null;
}

interface Cupon {
  id: string;
  code: string;
  dni: string;
  kind: "monto" | "porcentaje";
  value: number;
  currency: string;
  description: string | null;
  origin: string;
  status: string;
  expires_at: string | null;
  used_at: string | null;
  used_note: string | null;
  created_at: string;
  contact: { name: string | null } | null;
}

const ESTADO_REFERIDO: Record<string, string> = {
  registrado: "Se registró",
  compro: "Compró — falta premiar",
  premiado: "Premiado",
  anulado: "Anulado",
};

const valorDe = (c: Pick<Cupon, "kind" | "value" | "currency">) =>
  c.kind === "porcentaje"
    ? `${Number(c.value)} %`
    : `${c.currency === "PEN" ? "S/" : c.currency} ${Number(c.value).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`;

const fecha = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" }) : "—";

export default function CouponsPage() {
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const puede = useCan("send-messages");

  const [referidos, setReferidos] = useState<Referido[]>([]);
  const [cupones, setCupones] = useState<Cupon[]>([]);
  const [cargando, setCargando] = useState(true);
  const [sinTabla, setSinTabla] = useState(false);

  // Formulario de cupón. `referidoId` se llena cuando viene de "Dar cupón".
  const [dni, setDni] = useState("");
  const [tipo, setTipo] = useState<"monto" | "porcentaje">("monto");
  const [valor, setValor] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [vence, setVence] = useState("");
  const [referidoId, setReferidoId] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    if (!accountId) return;
    const [r, c] = await Promise.all([
      supabase
        .from("referrals")
        .select(
          "id, status, created_at, converted_at, padrino:contacts!referrals_referrer_contact_id_fkey(id, name, phone, dni), referido:contacts!referrals_referred_contact_id_fkey(name, phone)",
        )
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("coupons")
        .select("*, contact:contacts(name)")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    if (r.error || c.error) {
      setSinTabla(true);
      return;
    }
    setReferidos((r.data ?? []) as unknown as Referido[]);
    setCupones((c.data ?? []) as unknown as Cupon[]);
  }, [accountId, supabase]);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      await cargar();
      if (!cancelado) setCargando(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [cargar]);

  function premiar(r: Referido) {
    if (!r.padrino?.dni) {
      toast.error("Quien lo trajo no tiene DNI en su ficha: regístralo primero en Contactos.");
      return;
    }
    setDni(r.padrino.dni);
    setReferidoId(r.id);
    setDescripcion(`Por recomendar a ${r.referido?.name || r.referido?.phone || "un cliente"}`);
    document.getElementById("cupon-form")?.scrollIntoView({ behavior: "smooth" });
  }

  async function crear() {
    if (!accountId) return;
    const limpio = dni.replace(/\D/g, "");
    const n = Number(valor);
    if (!/^[0-9]{8,12}$/.test(limpio)) return toast.error("El DNI tiene que tener entre 8 y 12 dígitos.");
    if (!(n > 0) || (tipo === "porcentaje" && n > 100)) return toast.error("Revisa el valor del cupón.");

    setGuardando(true);
    const { data: contacto } = await supabase
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .eq("dni", limpio)
      .limit(1)
      .maybeSingle();

    let error: { code?: string; message: string } | null = null;
    let codigo = "";
    for (let i = 0; i < 4; i += 1) {
      codigo = nuevoCodigo();
      const r = await supabase.from("coupons").insert({
        account_id: accountId,
        code: codigo,
        dni: limpio,
        contact_id: contacto?.id ?? null,
        kind: tipo,
        value: n,
        currency: "PEN",
        description: descripcion.trim() || null,
        origin: referidoId ? "referido" : "manual",
        referral_id: referidoId,
        expires_at: vence || null,
        created_by: user?.id ?? null,
      });
      error = r.error;
      if (!error || error.code !== "23505") break;
    }
    if (error) {
      setGuardando(false);
      return toast.error(`No se pudo crear el cupón: ${error.message}`);
    }
    if (referidoId) await supabase.from("referrals").update({ status: "premiado" }).eq("id", referidoId);

    toast.success(`Cupón ${codigo} creado`);
    setDni("");
    setValor("");
    setDescripcion("");
    setVence("");
    setReferidoId(null);
    setGuardando(false);
    cargar();
  }

  async function cambiar(c: Cupon, estado: "usado" | "anulado") {
    const nota =
      estado === "usado"
        ? window.prompt(`¿Dónde se aplicó el cupón ${c.code}? (p. ej. separación del lote B-12)`, "")
        : window.confirm(`¿Anular el cupón ${c.code}? Ya no se podrá usar.`)
          ? ""
          : null;
    if (nota === null) return;
    const { error } = await supabase
      .from("coupons")
      .update(
        estado === "usado"
          ? { status: "usado", used_at: new Date().toISOString(), used_by: user?.id ?? null, used_note: nota || null }
          : { status: "anulado" },
      )
      .eq("id", c.id)
      .eq("status", "activo");
    if (error) return toast.error("No se pudo cambiar el cupón.");
    toast.success(estado === "usado" ? "Cupón aplicado" : "Cupón anulado");
    cargar();
  }

  if (cargando) return <p className="py-16 text-center text-sm text-muted-foreground">Cargando…</p>;
  if (sinTabla) {
    return (
      <p className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        Falta correr la migración 051 en Supabase para usar referidos y cupones.
      </p>
    );
  }

  const porPremiar = referidos.filter((r) => r.status === "compro");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Cupones y referidos</h1>
        <p className="text-sm text-muted-foreground">
          Cupones de un solo uso atados a un DNI. Los clientes invitan con su enlace desde la app (Beneficios).
        </p>
      </header>

      {/* ── Lo que espera una decisión ── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Gift className="h-4 w-4" /> Por premiar
        </h2>
        {porPremiar.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            Nadie espera premio. Cuando un referido compre, aparece aquí.
          </p>
        ) : (
          <ul className="space-y-2">
            {porPremiar.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
                <div className="text-sm">
                  <p className="font-medium text-foreground">
                    {r.padrino?.name || r.padrino?.phone} trajo a {r.referido?.name || r.referido?.phone}
                  </p>
                  <p className="text-xs text-muted-foreground">Compró el {fecha(r.converted_at)}</p>
                </div>
                {puede && (
                  <Button onClick={() => premiar(r)} className="h-9 text-xs">
                    Dar cupón
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Crear cupón ── */}
      {puede && (
        <section id="cupon-form" className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Ticket className="h-4 w-4" /> {referidoId ? "Cupón por referido" : "Nuevo cupón"}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              DNI del cliente
              <Input value={dni} onChange={(e) => setDni(e.target.value)} inputMode="numeric" placeholder="12345678" />
            </label>
            <div className="grid grid-cols-[auto_1fr] items-end gap-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                Tipo
                <select
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value as "monto" | "porcentaje")}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                >
                  <option value="monto">S/ monto</option>
                  <option value="porcentaje">% porcentaje</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Valor
                <Input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder={tipo === "monto" ? "500" : "5"} />
              </label>
            </div>
            <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
              Para qué es
              <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Descuento en la cuota inicial" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Vence (opcional)
              <Input type="date" value={vence} onChange={(e) => setVence(e.target.value)} />
            </label>
            <div className="flex items-end gap-2">
              <Button onClick={crear} disabled={guardando} className="h-9">
                {guardando ? "Creando…" : "Crear cupón"}
              </Button>
              {referidoId && (
                <Button variant="ghost" className="h-9" onClick={() => { setReferidoId(null); setDescripcion(""); setDni(""); }}>
                  Cancelar
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Cupones ── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Ticket className="h-4 w-4" /> Cupones
        </h2>
        {cupones.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">Todavía no hay cupones.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Código</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Valor</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {cupones.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono font-semibold tracking-wider">{c.code}</td>
                    <td className="px-3 py-2">
                      <p>{c.contact?.name || "—"}</p>
                      <p className="text-xs text-muted-foreground">DNI {c.dni}{c.description ? ` · ${c.description}` : ""}</p>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{valorDe(c)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs",
                          c.status === "activo" && "bg-emerald-500/15 text-emerald-400",
                          c.status === "usado" && "bg-muted text-muted-foreground",
                          c.status === "anulado" && "bg-red-500/10 text-red-400",
                        )}
                      >
                        {c.status === "usado" ? `Usado ${fecha(c.used_at)}` : c.status === "activo" ? (c.expires_at ? `Activo · vence ${fecha(c.expires_at)}` : "Activo") : "Anulado"}
                      </span>
                      {c.used_note && <p className="mt-1 text-xs text-muted-foreground">{c.used_note}</p>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {puede && c.status === "activo" && (
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" className="h-8 px-2 text-xs" onClick={() => cambiar(c, "usado")}>Aplicar</Button>
                          <Button variant="ghost" className="h-8 px-2 text-xs text-muted-foreground hover:text-red-400" onClick={() => cambiar(c, "anulado")}>Anular</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Todos los referidos ── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <UserPlus className="h-4 w-4" /> Referidos
        </h2>
        {referidos.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            Todavía nadie entró con el enlace de un cliente.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {referidos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <b>{r.referido?.name || r.referido?.phone}</b>
                  <span className="text-muted-foreground"> · invitado por {r.padrino?.name || r.padrino?.phone}</span>
                </span>
                <span className="text-xs text-muted-foreground">{ESTADO_REFERIDO[r.status] ?? r.status} · {fecha(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
