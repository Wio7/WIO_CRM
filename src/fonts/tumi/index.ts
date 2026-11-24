// Letras de Club El Tumi servidas desde el repo (OFL, ver LICENSE-OFL.txt).
import localFont from "next/font/local";

export const serifWio = localFont({
  src: [
    { path: "./playfair-display-600.woff2", weight: "600", style: "normal" },
    { path: "./playfair-display-600-italic.woff2", weight: "600", style: "italic" },
  ],
  variable: "--font-wio-serif",
  display: "swap",
});

export const sansWio = localFont({
  src: [
    { path: "./poppins-400.woff2", weight: "400", style: "normal" },
    { path: "./poppins-500.woff2", weight: "500", style: "normal" },
    { path: "./poppins-600.woff2", weight: "600", style: "normal" },
    { path: "./poppins-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-wio-sans",
  display: "swap",
});
