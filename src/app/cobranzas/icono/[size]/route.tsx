import { ImageResponse } from "next/og";

const TAMANOS = [180, 192, 512];

// Ícono de la app de Cobranzas (moneda dorada sobre verde). Se genera aquí
// para no guardar binarios; es público (ver isAppPublicPath).
export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  const px = Number(size);
  if (!TAMANOS.includes(px)) return new Response("No encontrado", { status: 404 });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b3d3a" }}>
        <div
          style={{
            width: px * 0.62, height: px * 0.62, borderRadius: "50%", background: "#e6c36a", display: "flex",
            alignItems: "center", justifyContent: "center", color: "#0b3d3a", fontSize: px * 0.4, fontWeight: 700,
          }}
        >
          $
        </div>
      </div>
    ),
    { width: px, height: px },
  );
}
