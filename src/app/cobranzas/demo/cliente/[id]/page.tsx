"use client";

import { useParams } from "next/navigation";

import { FichaDemo } from "@/components/cobranzas/demo-vistas";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <FichaDemo contactId={id} />;
}
