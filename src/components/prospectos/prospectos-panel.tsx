"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy, ExternalLink, Link2, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Ondas } from "@/components/layout/ondas";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Prospecto {
  id: string;
  creado: string;
  empresa: string;
  estado: string;
  notas: string;
  nombre: string;
  cargo?: string;
  whatsapp: string;
  ciudad?: string;
  rubro: { emoji: string; texto: string };
  temperatura: { emoji: string; texto: string };
  ofrecer: { id: string; emoji: string; texto: string; puntos: number; motivos: string[] }[];
  secciones: { emoji: string; titulo: string; filas: { titulo: string; texto: string }[] }[];
}
interface Datos {
  prospectos: Prospecto[];
  estados: [string, string][];
  rubros: [string, string, string][];
  formulario: string;
}

const GRUPOS: { id: string; label: string; es: (p: Prospecto) => boolean }[] = [
  { id: "todos", label: "Todos", es: () => true },
  { id: "nuevos", label: "Nuevos", es: (p) => p.estado === "nuevo" },
  { id: "curso", label: "En curso", es: (p) => ["contactado", "reunion", "propuesta"].includes(p.estado) },
  { id: "cerrados", label: "Cerrados", es: (p) => p.estado === "cerrado" },
];
const campo = "w-full rounded-xl border border-border bg-background px-3 py-3 text-base";
const fecha = (f: string) =>
  new Date(f).toLocaleString("es-PE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" });

async function copiar(texto: string, ok: string) {
  try {
    await navigator.clipboard.writeText(texto);
    toast.success(ok);
  } catch {
    toast.error("No se pudo copiar");
  }
}

export function ProspectosPanel() {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState("");
  const [grupo, setGrupo] = useState("todos");
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/prospectos", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setDatos(j);
      setError("");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "No se pudo cargar");
    }
  }, []);
  useEffect(() => {
     
    void cargar();
  }, [cargar]);

  if (error) {
    return (
      <div className="mx-auto mt-16 max-w-sm space-y-4 text-center">
        <p className="text-4xl" aria-hidden>📡</p>
        <p role="alert">{error}</p>
        <Button onClick={cargar}>Reintentar</Button>
      </div>
    );
  }
  if (!datos) return <p className="p-6 text-muted-foreground">Cargando prospectos…</p>;

  const es = GRUPOS.find((g) => g.id === grupo)!.es;
  const lista = datos.prospectos.filter((p) => es(p) && `${p.empresa} ${p.nombre}`.toLowerCase().includes(busca.toLowerCase()));
  const actual = datos.prospectos.find((p) => p.id === sel);

  const guardar = async (p: Prospecto, cambio: { estado?: string; notas?: string }) => {
    const nuevo = { id: p.id, estado: p.estado, notas: p.notas, ...cambio };
    try {
      const r = await fetch("/api/admin/prospectos", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(nuevo) });
      if (!r.ok) throw new Error();
      setDatos((d) => d && { ...d, prospectos: d.prospectos.map((x) => (x.id === p.id ? { ...x, ...nuevo } : x)) });
      toast.success("Guardado");
    } catch {
      toast.error("No se guardó. Prueba otra vez.");
    }
  };

  return (
    <div className="mx-auto max-w-7xl gap-6 lg:grid lg:grid-cols-[380px_minmax(0,1fr)]">
      <div className={cn("space-y-4", actual && "hidden lg:block")}>
        <section className="wio-banda">
          <Ondas />
          <h1 className="text-2xl font-bold">Prospectos</h1>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {GRUPOS.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={grupo === g.id}
                onClick={() => setGrupo(g.id)}
                className={cn("min-h-16 rounded-2xl text-xs font-medium", grupo === g.id ? "bg-white text-[#0a0d14]" : "bg-white/15")}
              >
                <span className="block text-2xl leading-tight font-bold">{datos.prospectos.filter(g.es).length}</span>
                {g.label}
              </button>
            ))}
          </div>
        </section>
        <CrearEnlace datos={datos} />
        <input type="search" aria-label="Buscar" placeholder="Buscar empresa o persona" value={busca} onChange={(e) => setBusca(e.target.value)} className={campo} />
        <ul className="space-y-3">
          {lista.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSel(p.id)}
                className={cn("flex w-full gap-3 rounded-2xl border border-border bg-card p-4 text-left", p.id === sel && "ring-2 ring-primary")}
              >
                <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-3xl" aria-hidden>{p.rubro.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-lg leading-tight font-semibold break-words">{p.empresa}</span>
                  <span className="block text-sm text-muted-foreground">{p.nombre} · {fecha(p.creado)}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <Chip fuerte>{datos.estados.find((e) => e[0] === p.estado)?.[1]}</Chip>
                    <Chip>{p.temperatura.emoji} {p.temperatura.texto}</Chip>
                    {p.ofrecer.slice(0, 2).map((o) => <Chip key={o.id}>{o.emoji} {o.texto}</Chip>)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {lista.length === 0 && (
          <p className="py-10 text-center text-muted-foreground">
            <span className="block text-5xl" aria-hidden>🦉</span>
            {datos.prospectos.length ? "Nada coincide." : "Aún no hay respuestas. Crea un enlace y envíalo."}
          </p>
        )}
      </div>

      {actual ? (
        <Detalle key={actual.id} p={actual} estados={datos.estados} onBack={() => setSel(null)} onSave={(c) => guardar(actual, c)} />
      ) : (
        <p className="hidden pt-24 text-center text-muted-foreground lg:block">
          <span className="block text-5xl" aria-hidden>🦉</span>Elige un prospecto.
        </p>
      )}
    </div>
  );
}

function Chip({ children, fuerte }: { children: React.ReactNode; fuerte?: boolean }) {
  return <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", fuerte ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>{children}</span>;
}

function CrearEnlace({ datos }: { datos: Datos }) {
  const [empresa, setEmpresa] = useState("");
  const [rubro, setRubro] = useState("");
  const url = new URL(datos.formulario);
  if (rubro) url.searchParams.set("r", rubro);
  if (empresa.trim()) url.searchParams.set("e", empresa.trim());
  return (
    <details className="rounded-2xl border border-border bg-card">
      <summary className="flex min-h-14 cursor-pointer items-center gap-2 px-4 font-semibold"><Link2 className="size-5" aria-hidden /> Enlace para un cliente</summary>
      <div className="space-y-3 px-4 pb-4">
        <input aria-label="Empresa (opcional)" placeholder="Empresa (opcional)" maxLength={120} value={empresa} onChange={(e) => setEmpresa(e.target.value)} className={campo} />
        <select aria-label="Rubro" value={rubro} onChange={(e) => setRubro(e.target.value)} className={campo}>
          <option value="">Que elija su rubro</option>
          {datos.rubros.map(([id, emoji, texto]) => <option key={id} value={id}>{emoji} {texto}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-12" onClick={() => copiar(url.href, "Enlace copiado")}><Copy aria-hidden /> Copiar</Button>
          <a href={url.href} target="_blank" rel="noopener noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium"><ExternalLink className="size-4" aria-hidden /> Ver</a>
        </div>
      </div>
    </details>
  );
}

function Detalle({ p, estados, onBack, onSave }: { p: Prospecto; estados: [string, string][]; onBack: () => void; onSave: (c: { estado?: string; notas?: string }) => void }) {
  const [notas, setNotas] = useState(p.notas);
  const wa = `https://wa.me/${p.whatsapp}?text=${encodeURIComponent(`Hola ${p.nombre.split(" ")[0]}, soy Bryce de Wio Company. Gracias por llenar el formulario de ${p.empresa}.`)}`;
  const resumen = [
    `PROSPECTO: ${p.empresa}`,
    "",
    "RECOMENDACIÓN",
    ...p.ofrecer.map((o) => `- ${o.texto} (${o.puntos}/100): ${o.motivos.join("; ")}`),
    "",
    "RESPUESTAS",
    ...p.secciones.flatMap((s) => s.filas.map((f) => `- ${f.titulo}: ${f.texto}`)),
    ...(notas ? ["", "NOTAS", notas] : []),
  ].join("\n");
  const caja = "rounded-2xl border border-border bg-card p-4";

  return (
    <section className="space-y-3">
      <Button variant="outline" className="h-11 lg:hidden" onClick={onBack}><ArrowLeft aria-hidden /> Volver</Button>
      <div className={caja}>
        <h2 className="text-2xl leading-tight font-bold break-words">{p.rubro.emoji} {p.empresa}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{[p.nombre, p.cargo, p.ciudad, fecha(p.creado)].filter(Boolean).join(" · ")}</p>
        <div className="mt-2 flex flex-wrap gap-1.5"><Chip>{p.temperatura.emoji} {p.temperatura.texto}</Chip><Chip>{p.rubro.texto}</Chip></div>
        <div className="mt-4 grid grid-cols-2 gap-2 lg:max-w-md">
          <a href={wa} target="_blank" rel="noopener noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground"><MessageCircle className="size-5" aria-hidden /> WhatsApp</a>
          <Button variant="outline" className="h-12" onClick={() => copiar(resumen, "Resumen copiado")}><Copy aria-hidden /> Resumen</Button>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        <div className="space-y-3">
          <div className={caja}>
            <h3 className="text-lg font-semibold">🎯 Qué ofrecerle</h3>
            {p.ofrecer.map((o) => (
              <div key={o.id} className="mt-3">
                <p className="flex justify-between font-semibold"><span>{o.emoji} {o.texto}</span><span>{o.puntos}</span></p>
                <div className="my-1.5 h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-gradient-to-r from-[#0b2a66] to-[#2f74ee]" style={{ width: `${o.puntos}%` }} /></div>
                <p className="text-sm text-muted-foreground">{o.motivos.join(" · ")}</p>
              </div>
            ))}
          </div>
          <div className={caja}>
            <h3 className="mb-3 text-lg font-semibold">📍 Etapa</h3>
            <div className="flex flex-wrap gap-2">
              {estados.map(([id, texto]) => (
                <button key={id} type="button" aria-pressed={id === p.estado} onClick={() => onSave({ estado: id, notas })} className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold", id === p.estado ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{texto}</button>
              ))}
            </div>
            <label className="mt-4 mb-2 block font-semibold" htmlFor="notas-prospecto">📝 Notas</label>
            <textarea id="notas-prospecto" rows={4} maxLength={5000} value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
            <Button className="mt-2 h-11" onClick={() => onSave({ notas })}>Guardar notas</Button>
          </div>
        </div>
        <div className="space-y-3">
          {p.secciones.map((s) => (
            <div key={s.titulo} className={caja}>
              <h3 className="text-lg font-semibold">{s.emoji} {s.titulo}</h3>
              <dl>
                {s.filas.map((f) => (
                  <div key={f.titulo} className="mt-2.5"><dt className="text-sm text-muted-foreground">{f.titulo}</dt><dd className="font-medium break-words whitespace-pre-wrap">{f.texto}</dd></div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
