"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";

const UnreadContext = createContext({ chats: 0, notifications: 0 });

/** Una sola suscripción en vivo para el menú, la barra inferior y el inicio. */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const chats = useTotalUnread();
  const notifications = useUnreadNotifications();
  return <UnreadContext.Provider value={{ chats, notifications }}>{children}</UnreadContext.Provider>;
}

export const useUnread = () => useContext(UnreadContext);
