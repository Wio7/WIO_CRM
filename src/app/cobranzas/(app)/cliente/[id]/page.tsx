"use client";

import { useParams } from "next/navigation";

import { ClienteView } from "@/components/cobranzas/cliente-view";

export default function ClientePage() {
  const { id } = useParams<{ id: string }>();
  return <ClienteView key={id} contactId={id} />;
}
