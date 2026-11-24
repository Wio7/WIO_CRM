// Colores por área para tarjetas e íconos (claro y oscuro).
export type Tone = "sky" | "emerald" | "amber" | "violet" | "rose";

export const TONES: Record<Tone, { icon: string; card: string }> = {
  sky: { icon: "bg-sky-500 text-white", card: "max-lg:border-sky-500/25 max-lg:bg-sky-500/10" },
  emerald: { icon: "bg-emerald-600 text-white", card: "max-lg:border-emerald-500/25 max-lg:bg-emerald-500/10" },
  amber: { icon: "bg-amber-500 text-black", card: "max-lg:border-amber-500/25 max-lg:bg-amber-500/10" },
  violet: { icon: "bg-violet-600 text-white", card: "max-lg:border-violet-500/25 max-lg:bg-violet-500/10" },
  rose: { icon: "bg-rose-600 text-white", card: "max-lg:border-rose-500/25 max-lg:bg-rose-500/10" },
};
