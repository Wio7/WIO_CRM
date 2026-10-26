import type { ReactNode } from "react";
import Link from "next/link";

// Paginas legales publicas (privacidad, terminos, eliminacion de datos).
// Meta las exige para la app WIO.CRM y para la revision de Tech Provider,
// asi que no pasan por el login: el middleware solo protege las rutas del
// panel. Se mantienen sin dependencias externas para que carguen siempre.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-semibold">
            Wio CRM
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/privacidad" className="hover:text-foreground">Privacidad</Link>
            <Link href="/terminos" className="hover:text-foreground">Términos</Link>
            <Link href="/eliminar-datos" className="hover:text-foreground">Eliminar datos</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <article className="space-y-6 leading-relaxed [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_a]:underline">
          {children}
        </article>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">
          Wio CRM · Bryce Luis Alexander Bueno Sarmiento · RUC 10730253350 · Ica, Perú ·{" "}
          <a href="mailto:contacto@wiocompany.com" className="underline">contacto@wiocompany.com</a>
        </div>
      </footer>
    </div>
  );
}
