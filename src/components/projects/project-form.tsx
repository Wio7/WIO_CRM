"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import type { ProjectStatus, RealEstateProject } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus, Trash2, X, ImagePlus } from "lucide-react";
import { toast } from "sonner";

interface ProjectFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  project?: RealEstateProject | null;
  onSaved: () => void;
}

export function ProjectForm({
  open,
  onOpenChange,
  accountId,
  project,
  onSaved,
}: ProjectFormProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [city, setCity] = useState("");
  const [description, setDescription] = useState("");
  const [initialFrom, setInitialFrom] = useState("");
  const [priceCash, setPriceCash] = useState("");
  const [priceFinanced, setPriceFinanced] = useState("");
  const [financingMonths, setFinancingMonths] = useState("");
  const [monthlyPayment, setMonthlyPayment] = useState("");
  const [areaFrom, setAreaFrom] = useState("");
  const [amenities, setAmenities] = useState<string[]>([]);
  const [amenityInput, setAmenityInput] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [showSeller, setShowSeller] = useState(false);
  const [sellerCompany, setSellerCompany] = useState("");
  const [sellerRepresentative, setSellerRepresentative] = useState("");
  const [sellerDni, setSellerDni] = useState("");
  const [sellerAddress, setSellerAddress] = useState("");

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (project) {
      setName(project.name);
      setLocation(project.location ?? "");
      setCity(project.city ?? "");
      setDescription(project.description ?? "");
      setInitialFrom(project.initial_from != null ? String(project.initial_from) : "");
      setPriceCash(project.price_cash != null ? String(project.price_cash) : "");
      setPriceFinanced(project.price_financed != null ? String(project.price_financed) : "");
      setFinancingMonths(project.financing_months != null ? String(project.financing_months) : "");
      setMonthlyPayment(project.monthly_payment != null ? String(project.monthly_payment) : "");
      setAreaFrom(project.area_from != null ? String(project.area_from) : "");
      setAmenities(project.amenities ?? []);
      setCoverImageUrl(project.cover_image_url ?? "");
      setStatus(project.status ?? "active");
      setSellerCompany(project.seller_company ?? "");
      setSellerRepresentative(project.seller_representative ?? "");
      setSellerDni(project.seller_dni ?? "");
      setSellerAddress(project.seller_address ?? "");
      setShowSeller(
        !!(project.seller_company || project.seller_representative || project.seller_dni),
      );
    } else {
      setName("");
      setLocation("");
      setCity("Ica");
      setDescription("");
      setInitialFrom("");
      setPriceCash("");
      setPriceFinanced("");
      setFinancingMonths("");
      setMonthlyPayment("");
      setAreaFrom("");
      setAmenities([]);
      setCoverImageUrl("");
      setStatus("active");
      setSellerCompany("");
      setSellerRepresentative("");
      setSellerDni("");
      setSellerAddress("");
      setShowSeller(false);
    }
    setAmenityInput("");
  }, [open, project]);

  function addAmenity() {
    const value = amenityInput.trim();
    if (!value || amenities.includes(value)) return;
    setAmenities((prev) => [...prev, value]);
    setAmenityInput("");
  }

  function removeAmenity(value: string) {
    setAmenities((prev) => prev.filter((a) => a !== value));
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error("La imagen no debe superar los 5 MB");
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("reservation-docs", file);
      setCoverImageUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir la imagen");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error("El nombre del proyecto es requerido");
      return;
    }
    setSaving(true);

    const payload = {
      name: name.trim(),
      location: location.trim() || null,
      city: city.trim() || null,
      description: description.trim() || null,
      initial_from: initialFrom ? parseFloat(initialFrom) : null,
      price_cash: priceCash ? parseFloat(priceCash) : null,
      price_financed: priceFinanced ? parseFloat(priceFinanced) : null,
      financing_months: financingMonths ? parseInt(financingMonths, 10) : null,
      monthly_payment: monthlyPayment ? parseFloat(monthlyPayment) : null,
      area_from: areaFrom ? parseFloat(areaFrom) : null,
      amenities,
      cover_image_url: coverImageUrl || null,
      status,
      seller_company: sellerCompany.trim() || null,
      seller_representative: sellerRepresentative.trim() || null,
      seller_dni: sellerDni.trim() || null,
      seller_address: sellerAddress.trim() || null,
    };

    if (project) {
      const { error } = await supabase
        .from("real_estate_projects")
        .update(payload)
        .eq("id", project.id);
      if (error) {
        toast.error("No se pudo guardar el proyecto");
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("real_estate_projects")
        .insert({ ...payload, account_id: accountId, created_by: user?.id ?? null });
      if (error) {
        toast.error("No se pudo crear el proyecto");
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(project ? "Proyecto actualizado" : "Proyecto creado");
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!project) return;
    setDeleting(true);
    const { error } = await supabase
      .from("real_estate_projects")
      .delete()
      .eq("id", project.id);
    setDeleting(false);
    if (error) {
      toast.error("No se pudo eliminar el proyecto");
      return;
    }
    toast.success("Proyecto eliminado");
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {project ? "Editar Proyecto" : "Nuevo Proyecto"}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Cover image */}
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Imagen de portada</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
              {coverImageUrl ? (
                <div className="relative overflow-hidden rounded-lg border border-border">
                  <img src={coverImageUrl} alt="" className="h-32 w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setCoverImageUrl("")}
                    className="absolute top-2 right-2 rounded-full bg-background/80 p-1 text-foreground hover:bg-background"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex h-24 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 text-sm text-muted-foreground hover:bg-muted"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  {uploading ? "Subiendo..." : "Subir imagen"}
                </button>
              )}
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Nombre</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Puesta del Sol"
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Ubicación</Label>
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Km 200.5 Panamericana Sur"
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Ciudad</Label>
                <Input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Descripción</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Inicial desde (S/)</Label>
                <Input
                  type="number"
                  value={initialFrom}
                  onChange={(e) => setInitialFrom(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Área desde (m²)</Label>
                <Input
                  type="number"
                  value={areaFrom}
                  onChange={(e) => setAreaFrom(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Precio al contado</Label>
                <Input
                  type="number"
                  value={priceCash}
                  onChange={(e) => setPriceCash(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Precio financiado</Label>
                <Input
                  type="number"
                  value={priceFinanced}
                  onChange={(e) => setPriceFinanced(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Cuota mensual</Label>
                <Input
                  type="number"
                  value={monthlyPayment}
                  onChange={(e) => setMonthlyPayment(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Meses de financiamiento</Label>
                <Input
                  type="number"
                  value={financingMonths}
                  onChange={(e) => setFinancingMonths(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            {/* Amenities */}
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Amenidades</Label>
              <div className="flex gap-2">
                <Input
                  value={amenityInput}
                  onChange={(e) => setAmenityInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAmenity();
                    }
                  }}
                  placeholder="Áreas verdes, pistas y veredas..."
                  className="border-border bg-muted text-foreground"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={addAmenity}
                  className="shrink-0 border-border"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {amenities.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {amenities.map((a) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
                    >
                      {a}
                      <button
                        type="button"
                        onClick={() => removeAmenity(a)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Estado</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ProjectStatus)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="active">Activo</option>
                <option value="sold_out">Agotado</option>
                <option value="coming_soon">Próximamente</option>
              </select>
            </div>

            {/* Seller info — collapsible, used by the legal-docs generator later */}
            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setShowSeller((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-foreground"
              >
                Datos del vendedor (para minutas)
                <span className="text-xs text-muted-foreground">
                  {showSeller ? "Ocultar" : "Mostrar"}
                </span>
              </button>
              {showSeller && (
                <div className="space-y-3 border-t border-border p-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">Empresa</Label>
                    <Input
                      value={sellerCompany}
                      onChange={(e) => setSellerCompany(e.target.value)}
                      placeholder="Golden Habitat Inmobiliaria"
                      className="border-border bg-muted text-foreground"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label className="text-muted-foreground">Representante legal</Label>
                      <Input
                        value={sellerRepresentative}
                        onChange={(e) => setSellerRepresentative(e.target.value)}
                        className="border-border bg-muted text-foreground"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label className="text-muted-foreground">DNI</Label>
                      <Input
                        value={sellerDni}
                        onChange={(e) => setSellerDni(e.target.value)}
                        className="border-border bg-muted text-foreground"
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">Dirección</Label>
                    <Input
                      value={sellerAddress}
                      onChange={(e) => setSellerAddress(e.target.value)}
                      className="border-border bg-muted text-foreground"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? "Guardando..." : project ? "Guardar cambios" : "Crear proyecto"}
              </Button>
            </div>

            {project &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">
                    ¿Eliminar este proyecto y todas sus unidades?
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? "Eliminando..." : "Confirmar"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  Eliminar proyecto
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
