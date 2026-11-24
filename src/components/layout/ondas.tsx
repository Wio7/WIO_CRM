import { useId } from "react";

/** Ondas de la web del club: 7 líneas suaves dentro de un círculo (SVG propio, solo decorativo). */
const ONDAS: string[] = ["M-10 25.1 L0 28.0 L10 30.9 L20 33.6 L30 35.6 L40 36.7 L50 37.0 L60 36.2 L70 34.5 L80 32.1 L90 29.3 L100 26.3 L110 23.5 L120 21.2 L130 19.6 L140 19.0 L150 19.4 L160 20.7 L170 22.8 L180 25.5 L190 28.5 L200 31.4 L210 33.9","M-10 54.4 L0 57.1 L10 59.2 L20 60.6 L30 61.0 L40 60.4 L50 58.9 L60 56.6 L70 53.9 L80 50.9 L90 48.0 L100 45.6 L110 43.9 L120 43.1 L130 43.2 L140 44.3 L150 46.3 L160 48.9 L170 51.9 L180 54.8 L190 57.4 L200 59.5 L210 60.7","M-10 82.9 L0 84.4 L10 85.0 L20 84.6 L30 83.3 L40 81.1 L50 78.4 L60 75.5 L70 72.6 L80 70.0 L90 68.2 L100 67.1 L110 67.1 L120 68.0 L130 69.9 L140 72.4 L150 75.3 L160 78.2 L170 81.0 L180 83.1 L190 84.5 L200 85.0 L210 84.5","M-10 109.0 L0 108.8 L10 107.6 L20 105.6 L30 103.0 L40 100.1 L50 97.1 L60 94.5 L70 92.5 L80 91.3 L90 91.0 L100 91.8 L110 93.4 L120 95.8 L130 98.7 L140 101.6 L150 104.4 L160 106.8 L170 108.3 L180 109.0 L190 108.7 L200 107.4 L210 105.3","M-10 131.9 L0 130.1 L10 127.6 L20 124.7 L30 121.7 L40 119.0 L50 116.8 L60 115.4 L70 115.0 L80 115.6 L90 117.0 L100 119.3 L110 122.1 L120 125.0 L130 127.9 L140 130.4 L150 132.1 L160 132.9 L170 132.8 L180 131.7 L190 129.7 L200 127.2 L210 124.2","M-10 152.1 L0 149.3 L10 146.3 L20 143.5 L30 141.2 L40 139.6 L50 139.0 L60 139.4 L70 140.7 L80 142.8 L90 145.5 L100 148.5 L110 151.4 L120 153.9 L130 155.8 L140 156.8 L150 156.9 L160 156.0 L170 154.2 L180 151.7 L190 148.8 L200 145.8 L210 143.1","M-10 170.9 L0 168.0 L10 165.6 L20 163.9 L30 163.1 L40 163.2 L50 164.3 L60 166.3 L70 168.9 L80 171.9 L90 174.8 L100 177.4 L110 179.5 L120 180.7 L130 181.0 L140 180.2 L150 178.6 L160 176.2 L170 173.4 L180 170.4 L190 167.6 L200 165.3 L210 163.7"];

/**
 * Motivo decorativo de las bandas oscuras: círculo de color de detalle con ondas claras.
 * Colores por variables (--tb-detalle, --tb-sobre-banda). Siempre aria-hidden.
 */
export function Ondas({ className }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clip = `tb-ondas-${uid}`;
  return (
    <svg viewBox="0 0 200 200" className={className ? `tb-ondas ${className}` : "tb-ondas"} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <circle cx="100" cy="100" r="96" />
        </clipPath>
      </defs>
      <circle cx="100" cy="100" r="96" style={{ fill: "var(--tb-detalle)" }} />
      <g clipPath={`url(#${clip})`} fill="none" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" style={{ stroke: "var(--tb-sobre-banda)" }}>
        {ONDAS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
