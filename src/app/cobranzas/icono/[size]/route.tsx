import { ImageResponse } from "next/og";

const TAMANOS = [180, 192, 512];

// Mismo dibujo que el ícono de dentro de la app (HandCoins de lucide, dorado
// sobre vino). Cuadrado completo: el celular le pone sus propias esquinas.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f1428"/><stop offset="1" stop-color="#3d060e"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><g transform="translate(100 100) scale(13)" fill="none" stroke="#e6c877" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17"/><path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 16 6 6"/><circle cx="16" cy="9" r="2.9"/><circle cx="6" cy="5" r="3"/></g></svg>`;
const SRC = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;

// Se genera aquí para no guardar binarios; es público (ver isAppPublicPath).
export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  const px = Number(size);
  if (!TAMANOS.includes(px)) return new Response("No encontrado", { status: 404 });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SRC} width={px} height={px} alt="" />
      </div>
    ),
    { width: px, height: px },
  );
}
