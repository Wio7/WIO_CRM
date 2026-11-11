"use client";

// /collections/bandeja — traspasos que llegan a Cobranzas y los que envió.

import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";

import { HandoffInbox } from "@/components/handoffs/handoff-inbox";
import { buttonVariants } from "@/components/ui/button";
import { useCollectionsPaths } from "@/components/collections/base-path";

export default function CollectionsInboxPage() {
  const paths = useCollectionsPaths();
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Inbox className="h-6 w-6 text-primary" /> Bandeja de Cobranzas
        </h1>
        <Link href={paths.base} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <ArrowLeft className="h-4 w-4" /> Cobranzas
        </Link>
      </div>
      <HandoffInbox module="cobranzas" />
    </div>
  );
}
