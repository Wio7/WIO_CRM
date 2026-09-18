"use client";

// ============================================================
// /calendar — mi horario y mis citas.
//
// Dos cosas, en este orden: primero las citas de hoy, que es a lo que se
// entra por la mañana, y debajo el horario que uno ofrece, que se toca
// una vez al mes.
//
// El horario NO son citas: son las horas en las que a uno se le puede
// buscar. De ahí salen las horas que el cliente ve libres en su app
// (`staff_availability`, migración 049), restándoles lo ya tomado.
//
// Cada quien edita el suyo; los administradores, el de cualquiera — lo
// decide la política de la base, no esta pantalla.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GatedButton } from "@/components/ui/gated-button";
import { CalendarDays, Plus, Trash2, Video } from "lucide-react";
import { toast } from "sonner";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

interface Tramo {
  id: string;
  user_id: string;
  weekday: number;
  starts_min: number;
  ends_min: number;
}

interface Cita {
  id: string;
  starts_at: string;
  minutes: number;
  kind: string;
  status: string;
  room: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

const aHora = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const aMinutos = (hora: string) => {
  const [h, m] = hora.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

const cuando = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const esHoy = (iso: string) => {
  const f = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d);
  return f(new Date(iso)) === f(new Date());
};

export default function CalendarPage() {
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const canAct = useCan("send-messages");

  const [tramos, setTramos] = useState<Tramo[]>([]);
  const [citas, setCitas] = useState<Cita[]>([]);
  const [cargando, setCargando] = useState(true);
  const [dia, setDia] = useState(1);
  // La hora, en el estado y no leída al pintar: así el botón "Entrar"
  // aparece solo cuando llega el momento, sin recargar, y el render no
  // depende de un reloj que cambia por debajo.
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [desde, setDesde] = useState("09:00");
  const [hasta, setHasta] = useState("13:00");

  // El id de auth, que es lo que guardan `staff_availability.user_id` y
  // `appointments.user_id` (y también `conversations.assigned_agent_id`).
  const yo = user?.id;

  const cargar = useCallback(async () => {
    if (!yo) return;
    const [{ data: h }, { data: c }] = await Promise.all([
      supabase
        .from("staff_availability")
        .select("id, user_id, weekday, starts_min, ends_min")
        .eq("user_id", yo)
        .order("weekday")
        .order("starts_min"),
      supabase
        .from("appointments")
        .select("id, starts_at, minutes, kind, status, room, contact:contacts(name, phone)")
        .eq("user_id", yo)
        .eq("status", "agendada")
        .gte("starts_at", new Date(Date.now() - 2 * 60 * 60_000).toISOString())
        .order("starts_at")
        .limit(50),
    ]);
    setTramos((h ?? []) as Tramo[]);
    setCitas((c ?? []) as unknown as Cita[]);
  }, [supabase, yo]);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      if (!yo) return;
      await cargar();
      if (!cancelado) setCargando(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [cargar, yo]);

  const hoy = useMemo(() => citas.filter((c) => esHoy(c.starts_at)), [citas]);
  const siguientes = useMemo(() => citas.filter((c) => !esHoy(c.starts_at)), [citas]);

  async function agregar() {
    if (!accountId || !yo) return;
    const a = aMinutos(desde);
    const b = aMinutos(hasta);
    if (b <= a) {
      toast.error("La hora de fin tiene que ser posterior a la de inicio");
      return;
    }
    const { error } = await supabase.from("staff_availability").insert({
      account_id: accountId,
      user_id: yo,
      weekday: dia,
      starts_min: a,
      ends_min: b,
    });
    if (error) {
      toast.error(
        (error as { code?: string }).code === "23505"
          ? "Ya tienes un tramo que empieza a esa hora"
          : "No se pudo guardar el horario",
      );
      return;
    }
    toast.success(`${DIAS[dia]} de ${desde} a ${hasta}`);
    cargar();
  }

  async function quitar(id: string) {
    const { error } = await supabase.from("staff_availability").delete().eq("id", id);
    if (error) {
      toast.error("No se pudo quitar");
      return;
    }
    cargar();
  }

  async function cancelar(id: string) {
    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelada" })
      .eq("id", id);
    if (error) {
      toast.error("No se pudo cancelar");
      return;
    }
    toast.success("Cita cancelada");
    cargar();
  }

  if (cargando) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Cargando tu agenda…</p>;
  }

  return (
    <div className="space-y-6">
      {/* ── Lo de hoy ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          Hoy
        </h2>
        {hoy.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No tienes citas para hoy.
          </p>
        ) : (
          <ul className="space-y-2">
            {hoy.map((c) => (
              <FilaCita key={c.id} cita={c} ahora={ahora} onCancelar={cancelar} canAct={canAct} />
            ))}
          </ul>
        )}
      </section>

      {siguientes.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Más adelante
          </h2>
          <ul className="space-y-2">
            {siguientes.map((c) => (
              <FilaCita key={c.id} cita={c} ahora={ahora} onCancelar={cancelar} canAct={canAct} />
            ))}
          </ul>
        </section>
      )}

      {/* ── Mi horario ────────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Cuándo te pueden agendar</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Estas son las horas que tus clientes van a ver libres en la app. Las citas ya
          tomadas se descuentan solas.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <label htmlFor="cal-dia" className="text-xs text-muted-foreground">Día</label>
            <select
              id="cal-dia"
              value={dia}
              onChange={(e) => setDia(Number(e.target.value))}
              className="h-10 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
            >
              {DIAS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="cal-desde" className="text-xs text-muted-foreground">Desde</label>
            <Input
              id="cal-desde"
              type="time"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="h-10 w-32 border-border bg-muted text-foreground"
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="cal-hasta" className="text-xs text-muted-foreground">Hasta</label>
            <Input
              id="cal-hasta"
              type="time"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="h-10 w-32 border-border bg-muted text-foreground"
            />
          </div>
          <GatedButton
            canAct={canAct}
            gateReason="cambiar horarios"
            onClick={agregar}
            className="h-10 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Agregar
          </GatedButton>
        </div>

        <div className="mt-4 space-y-3">
          {DIAS.map((nombre, i) => {
            const delDia = tramos.filter((t) => t.weekday === i);
            if (!delDia.length) return null;
            return (
              <div key={nombre} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs text-muted-foreground">{nombre}</span>
                {delDia.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground"
                  >
                    {aHora(t.starts_min)}–{aHora(t.ends_min)}
                    {canAct && (
                      <button
                        type="button"
                        onClick={() => quitar(t.id)}
                        aria-label={`Quitar ${nombre} ${aHora(t.starts_min)}`}
                        className="text-muted-foreground hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            );
          })}
          {tramos.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Todavía no ofreces ninguna hora, así que tus clientes no pueden agendar contigo.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function FilaCita({
  cita,
  ahora,
  onCancelar,
  canAct,
}: {
  cita: Cita;
  ahora: number;
  onCancelar: (id: string) => void;
  canAct: boolean;
}) {
  const dominio = (process.env.NEXT_PUBLIC_VIDEO_BASE || "https://meet.jit.si").replace(/\/+$/, "");
  const esVideo = cita.kind === "videollamada" && cita.room;
  // Se puede entrar desde diez minutos antes: llegar antes que el cliente
  // es parte del trabajo.
  const abierta = Date.parse(cita.starts_at) - ahora < 10 * 60_000;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          {cita.contact?.name || cita.contact?.phone || "Cliente"}
          <span className="ml-2 font-normal text-muted-foreground">{cita.kind}</span>
        </p>
        <p className="text-xs text-muted-foreground">{cuando(cita.starts_at)}</p>
      </div>
      <div className="flex items-center gap-2">
        {esVideo && (
          <a
            href={`${dominio}/${cita.room}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium",
              abierta
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "border border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <Video className="h-3.5 w-3.5" />
            {abierta ? "Entrar" : "Sala"}
          </a>
        )}
        {canAct && (
          <Button
            variant="ghost"
            onClick={() => onCancelar(cita.id)}
            className="h-9 px-2 text-xs text-muted-foreground hover:text-red-400"
          >
            Cancelar
          </Button>
        )}
      </div>
    </li>
  );
}
