"use client";

import { useState } from "react";
import { ImagePlus, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { buildProductRow, formatMoney, type ProductForm } from "@/lib/store/format";
import { MEDIA_MAX_BYTES_BY_KIND, uploadAccountMedia } from "@/lib/storage/upload-media";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StoreProduct } from "./types";

const EMPTY: ProductForm = {
  name: "",
  subtitle: "",
  description: "",
  price: "",
  includes: "",
  badge: "",
  sort: "0",
  image_url: "",
  active: true,
};

const toForm = (p: StoreProduct): ProductForm => ({
  name: p.name,
  subtitle: p.subtitle ?? "",
  description: p.description ?? "",
  price: String(p.price),
  includes: p.includes.join("\n"),
  badge: p.badge ?? "",
  sort: String(p.sort),
  image_url: p.image_url ?? "",
  active: p.active,
});

export function ProductsPanel({
  accountId,
  products,
  currency,
  canWrite,
  onReload,
}: {
  accountId: string;
  products: StoreProduct[];
  currency: string;
  canWrite: boolean;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState<StoreProduct | "nuevo" | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  function openForm(p: StoreProduct | "nuevo") {
    setForm(p === "nuevo" ? EMPTY : toForm(p));
    setEditing(p);
  }

  const set = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function onImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Elige una imagen.");
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) return toast.error("La imagen pesa más de 5 MB.");
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("chat-media", file);
      set("image_url", publicUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo subir la imagen.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    const built = buildProductRow(form);
    if (!built.ok) return toast.error(built.message);
    setSaving(true);
    const db = createClient().from("store_products");
    const { error } =
      editing && editing !== "nuevo"
        ? await db.update(built.row).eq("id", editing.id)
        : await db.insert({ ...built.row, account_id: accountId, currency });
    setSaving(false);
    if (error) return toast.error("No se pudo guardar: " + error.message);
    toast.success("Producto guardado");
    setEditing(null);
    onReload();
  }

  async function toggleActive(p: StoreProduct) {
    const { error } = await createClient().from("store_products").update({ active: !p.active }).eq("id", p.id);
    if (error) return toast.error("No se pudo cambiar: " + error.message);
    onReload();
  }

  return (
    <div className="space-y-4">
      {canWrite && (
        <Button onClick={() => openForm("nuevo")}>
          <Plus className="mr-1.5 h-4 w-4" /> Nuevo producto
        </Button>
      )}

      {products.length === 0 && (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Aún no hay productos. La tienda web no mostrará nada hasta que agregues el primero.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {products.map((p) => (
          <div key={p.id} className={cn("flex flex-col gap-2 rounded-xl border p-3", !p.active && "opacity-60")}>
            <div className="flex gap-3">
              {p.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.image_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ImagePlus className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{p.name}</p>
                {p.subtitle && <p className="truncate text-xs text-muted-foreground">{p.subtitle}</p>}
                <p className="mt-1 font-medium">{formatMoney(p.price, p.currency)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {p.badge && <Badge variant="secondary">{p.badge}</Badge>}
              <span className="text-muted-foreground">Orden {p.sort}</span>
              <span className="text-muted-foreground">· {p.includes.length} incluye</span>
              {!p.active && <Badge variant="outline">Desactivado</Badge>}
            </div>
            {canWrite && (
              <div className="mt-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => openForm(p)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggleActive(p)}>
                  {p.active ? "Desactivar" : "Activar"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "nuevo" ? "Nuevo producto" : "Editar producto"}</DialogTitle>
            <DialogDescription>Lo que cargues aquí es lo que la tienda web muestra y cobra.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="p-name">Nombre</Label>
              <Input id="p-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-sub">Subtítulo</Label>
              <Input id="p-sub" value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="p-price">Precio ({currency})</Label>
                <Input id="p-price" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="p-sort">Orden</Label>
                <Input id="p-sort" inputMode="numeric" value={form.sort} onChange={(e) => set("sort", e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-badge">Insignia (ej. Más vendido)</Label>
              <Input id="p-badge" value={form.badge} onChange={(e) => set("badge", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-desc">Descripción</Label>
              <Textarea id="p-desc" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-inc">Qué incluye (una línea por ítem)</Label>
              <Textarea id="p-inc" rows={4} value={form.includes} onChange={(e) => set("includes", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-img">Imagen</Label>
              <div className="flex items-center gap-3">
                {form.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.image_url} alt="" className="h-14 w-14 rounded-lg object-cover" />
                )}
                <Input id="p-img" type="file" accept="image/*" disabled={uploading} onChange={(e) => onImage(e.target.files?.[0])} />
                {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
              {form.image_url && (
                <button type="button" className="text-xs text-muted-foreground underline" onClick={() => set("image_url", "")}>
                  Quitar imagen
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
              Activo (visible en la tienda)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving || uploading}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
