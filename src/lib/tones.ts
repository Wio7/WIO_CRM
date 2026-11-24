// Tonos por área: solo azules y negro (en cuentas con marca propia, sus colores de siempre).
export type Tone = "sky" | "emerald" | "amber" | "violet" | "rose";

const azul = "bg-blue-600 text-white";
const negro = "bg-[#0a0d14] text-white dark-tono";
const marino = "bg-blue-900 text-white";

export const TONES: Record<Tone, { icon: string; card: string }> = {
  sky: { icon: azul, card: "wio-tarjeta" },
  emerald: { icon: marino, card: "wio-tarjeta" },
  amber: { icon: negro, card: "wio-tarjeta" },
  violet: { icon: azul, card: "wio-tarjeta" },
  rose: { icon: marino, card: "wio-tarjeta" },
};
