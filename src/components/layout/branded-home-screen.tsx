"use client";

import { useEffect } from "react";

/**
 * iOS takes the Home Screen icon and name from the page at the moment the
 * user taps "Agregar a pantalla de inicio", not from the manifest. The root
 * layout ships Wio's; for an account with its own brand (Broker Home…) swap
 * them in the live <head> so the installed app carries that brand. The
 * originals come back if the account changes or the shell unmounts.
 */
export function BrandedHomeScreen({ name, logo }: { name: string; logo: string }) {
  useEffect(() => {
    const restore: Array<() => void> = [];

    const icon = document.head.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (icon) {
      const previous = icon.getAttribute("href");
      icon.setAttribute("href", logo);
      restore.push(() => (previous === null ? icon.removeAttribute("href") : icon.setAttribute("href", previous)));
    } else {
      const created = document.createElement("link");
      created.rel = "apple-touch-icon";
      created.href = logo;
      document.head.appendChild(created);
      restore.push(() => created.remove());
    }

    const title = document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    if (title) {
      const previous = title.getAttribute("content");
      title.setAttribute("content", name);
      restore.push(() => title.setAttribute("content", previous ?? ""));
    } else {
      const created = document.createElement("meta");
      created.name = "apple-mobile-web-app-title";
      created.content = name;
      document.head.appendChild(created);
      restore.push(() => created.remove());
    }

    return () => restore.forEach((undo) => undo());
  }, [name, logo]);

  return null;
}
