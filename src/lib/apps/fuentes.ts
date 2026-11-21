// Fuentes de las apps de área (estilo Golden Legal): IBM Plex Sans para el
// texto y Newsreader para los títulos. Se cargan solo en las apps, no en el ERP web.
//
// Desde el repo (src/fonts, Fontsource 5.3.0, licencia OFL en esa carpeta),
// no desde Google Fonts: el 2026-11-21 el build falló tres veces en el día
// porque no pudo bajar estas fuentes de fonts.gstatic.com, y un despliegue a
// producción no puede depender de eso. Mismos pesos y mismas variables CSS.
import localFont from "next/font/local";

export const fuenteSans = localFont({
  src: [
    { path: "../../fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-golden-sans",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

export const fuenteSerif = localFont({
  src: [
    { path: "../../fonts/newsreader-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../fonts/newsreader-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-golden-serif",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

/** Clases que declaran las dos variables de fuente (van en el layout y en el body). */
export const clasesFuentesGolden = `${fuenteSans.variable} ${fuenteSerif.variable}`;
