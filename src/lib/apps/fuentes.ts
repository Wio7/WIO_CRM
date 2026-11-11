// Fuentes de las apps de área (estilo Golden Legal): IBM Plex Sans para el
// texto y Newsreader para los títulos. Se cargan solo en las apps, no en el ERP web.
import { IBM_Plex_Sans, Newsreader } from "next/font/google";

export const fuenteSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-golden-sans",
});

export const fuenteSerif = Newsreader({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-golden-serif",
});

/** Clases que declaran las dos variables de fuente (van en el layout y en el body). */
export const clasesFuentesGolden = `${fuenteSans.variable} ${fuenteSerif.variable}`;
