#!/usr/bin/env node
// ============================================================
// scripts/seed-golden-habitat.mjs
//
// One-off seed for a Golden Habitat Inmobiliaria account:
//   1. AI knowledge-base documents (brochure info + fichas técnicas),
//      pre-chunked so they're lexically searchable immediately —
//      no manual "Reindex" click required. Embeddings are left null;
//      an admin who later adds an embeddings key (Settings → AI
//      Assistant) can backfill them via the Reindex button.
//   2. Real-estate catalog: the 5 marketed projects from the brochure,
//      plus the 2 urbanizaciones (Menorca, Puesta del Sol / "Sol de
//      Ica") with their actual current-inventory units, taken
//      verbatim from each lot's ficha técnica.
//
// Source data note: the brochure markets a project called "Puesta
// del Sol" (Ica, viviendas desde 90 m², inicial S/17,000, contado
// S/170,000, financiado S/1,450 x 70 meses) whose specs line up
// closely with the "sol de ica" folder's units. This script assumes
// they're the same project (marketing name vs. internal folder
// name) and attaches those units to "Puesta del Sol" — correct this
// in the dashboard if that assumption is wrong. The "Menorca" units
// don't match any of the other four brochure projects by name or
// area, so they're seeded as their own standalone project instead
// of being merged into a guess.
//
// Requires SUPABASE_SERVICE_ROLE_KEY (bypasses RLS — this is meant
// to run once from a trusted machine, not in the app).
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=xxx \
//   node scripts/seed-golden-habitat.mjs <account_id>
// ============================================================

import { createClient } from "@supabase/supabase-js";

const accountId = process.argv[2];
if (!accountId) {
  console.error("Usage: node scripts/seed-golden-habitat.mjs <account_id>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.",
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

// Mirrors src/lib/ai/chunk.ts (paragraph-aware, greedily packed, hard
// split on oversized paragraphs) so seeded docs behave exactly like
// ones pasted through the Settings → Knowledge base UI.
function chunkText(content, maxChars = 1200) {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        const slice = para.slice(i, i + maxChars).trim();
        if (slice) chunks.push(slice);
      }
      continue;
    }
    if (current && current.length + 2 + para.length > maxChars) flush();
    current = current ? `${current}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

async function insertKnowledgeDoc(title, content) {
  const { data: doc, error } = await supabase
    .from("ai_knowledge_documents")
    .insert({ account_id: accountId, title, content })
    .select("id")
    .single();
  if (error) throw new Error(`[${title}] ${error.message}`);

  const chunks = chunkText(content);
  if (chunks.length > 0) {
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      account_id: accountId,
      chunk_index: i,
      content: c,
    }));
    const { error: chunkErr } = await supabase
      .from("ai_knowledge_chunks")
      .insert(rows);
    if (chunkErr) throw new Error(`[${title} chunks] ${chunkErr.message}`);
  }
  console.log(`  ✓ ${title} (${chunks.length} chunks)`);
}

async function insertProject(project) {
  const { data, error } = await supabase
    .from("real_estate_projects")
    .insert({ account_id: accountId, ...project })
    .select("id")
    .single();
  if (error) throw new Error(`[project ${project.name}] ${error.message}`);
  console.log(`  ✓ Proyecto: ${project.name}`);
  return data.id;
}

async function insertUnits(projectId, units) {
  const rows = units.map((u) => ({ account_id: accountId, project_id: projectId, ...u }));
  const { error } = await supabase.from("real_estate_units").insert(rows);
  if (error) throw new Error(`[units for ${projectId}] ${error.message}`);
  console.log(`    ✓ ${units.length} unidad(es)`);
}

// ============================================================
// 1. Knowledge base documents
// ============================================================

const DOC_INFO_GENERAL = `Golden Habitat Inmobiliaria — Información General

Historia:
Golden Habitat se define como una constructora inmobiliaria socialmente responsable, donde se prioriza las necesidades del cliente para cumplir con sus expectativas, ofreciendo los mejores lugares para vivir.

Misión:
Desarrollar promociones inmobiliarias que cubran una necesidad social tan importante como la del lote propio, generando valor de manera sostenible con un producto de calidad acorde a la demanda y a las necesidades de los clientes.

Visión:
Ser la promotora inmobiliaria de referencia en el sector inmobiliario del Perú, con presencia en todo el territorio nacional, basándose en un modelo profesional y en sólidos principios y valores.

Trayectoria:
Más de 5,000 familias ya hicieron realidad el sueño de su lote propio con Golden Habitat.

Contacto:
Teléfono / WhatsApp: 936 973 937

Promoción por compra:
Al adquirir un lote con Golden Habitat, el cliente puede elegir uno de los siguientes regalos como muestra de agradecimiento: Smart TV, Lavadora, Refrigeradora o Cocina.`;

const DOC_PROYECTOS = `Golden Habitat Inmobiliaria — Proyectos

1. Puesta del Sol (Ica)
Urbanización diseñada para quienes buscan comodidad, seguridad y una excelente ubicación en la ciudad de Ica. Casas desde 90 m², ideales para vivir con confort, cerca de centros comerciales y a solo minutos del centro de la ciudad.
- Inicial desde: S/ 17,000
- Precio al contado: S/ 170,000
- Precio financiado: S/ 1,450 / mes
- Financiamiento de hasta 70 meses
- Metraje: 90 m² (cuadrado)
- Amenidades: Pórtico de ingreso, áreas verdes, servicios básicos, pistas y veredas.

2. Vista Mar (Lurínchincha, km 200.5 Nueva Panamericana Sur)
Exclusivo proyecto premium con lotes frente al mar, entorno de tranquilidad y exclusividad, elegante boulevard y una espectacular piscina con vista al océano. Condominio Club House.
- Precio al contado: desde $ 28,000 (aprox.)
- Precio financiado: $ 480 / mes
- Amenidades: Pórtico de ingreso, áreas verdes, servicios básicos, pistas y veredas.

3. Los Eucaliptos (Ica)
Urbanización que integra de manera armónica la infraestructura urbana con un amplio entorno natural. Ubicado en una de las zonas de más alta plusvalía de Ica, con lotes desde 120 m². Cuenta con mini zoológico y casa club.
- Metraje: desde 120 m²
- Estado: proyecto con metraje vendido (agotado / alta demanda)
- Amenidades: Mini zoológico, casa club, servicios básicos, pistas y veredas.

4. Blue Village (Pisco, km 217 Nueva Panamericana Sur)
Proyecto inmobiliario rodeado de naturaleza y cerca de la Playa de Caucato, ideal para un estilo de vida tranquilo y confortable en familia.
- Precio al contado: S/ 16,500
- Precio financiado: S/ 392 / mes
- Financiamiento de hasta 70 meses
- Metraje: desde 120 m²
- Amenidades: Mini zoológico, casa club, servicios básicos, pistas y veredas.

5. Las Colinas del Este (Ica, cerca de la Plaza de los Aquijes)
Proyecto pensado para quienes buscan vivir rodeados de naturaleza sin alejarse de la ciudad. Lotes de campo desde 120 m², a solo 5 minutos de la Plaza de los Aquijes.
- Inicial desde: S/ 1,000
- Precio al contado: S/ 15,000
- Precio financiado: S/ 286 / mes
- Financiamiento de hasta 70 meses
- Metraje: desde 120 m²
- Amenidades: Pórtico de ingreso, áreas verdes, servicios básicos, pistas y veredas.`;

const DOC_VIVIENDAS = `Golden Habitat Inmobiliaria — Viviendas Disponibles Actualmente

Estas son las viviendas con ficha técnica confirmada, actualmente en venta.

--- Proyecto Puesta del Sol (urbanización "Sol de Ica") ---

MZ E Lote 30 (Lote 105) — Vivienda unifamiliar de 55.93 m² techado
- Área total: 105.00 m² | Área techada: 55.93 m² (53.27%) | Área no techada: 49.07 m² (46.73%)
- Ancho de fachada: 7.00 m | Perímetro: 34.13 ml | 1 piso con acabados
- Altura piso a techo: 2.60 m | Altura total: 2.95 m
- Ambientes: Cochera (20.65 m²), Sala-Comedor (16.65 m²), Cocina (6.42 m²), Servicio higiénico (3.80 m²), Dormitorio principal (7.68 m²), Dormitorio secundario (6.52 m²), Lavandería-patio (8.24 m²)
- Material: material noble (albañilería y concreto) | Servicios: luz, agua y desagüe tradicional | Ventilación: natural

MZ K2 Lote 4 — Vivienda unifamiliar de 50.00 m² techado
- Área total: 102.00 m² | Área techada: 50.00 m² (49.02%) | Área no techada: 52.00 m² (50.98%)
- Ancho de fachada: 6.00 m | Perímetro: 57.51 ml | 1 piso con acabados
- Altura piso a techo: 2.60 m | Altura total: 2.95 m
- Ambientes: Cochera (23.32 m²), Sala-Comedor (12.60 m²), Cocina (5.05 m²), Servicio higiénico (3.46 m²), Dormitorio principal (8.46 m²), Dormitorio secundario (7.04 m²), Patio-lavandería (6.27 m²)
- Material: material noble (albañilería y concreto) | Servicios: luz, agua y desagüe tradicional | Ventilación: natural

MZ D Lote 4 y MZ D Lote 5 — Vivienda unifamiliar de 90 m² (mismo diseño base que Menorca Lote 3), 2 unidades idénticas disponibles.

MZ E1 Lote 8 ("Vivienda Jade") — 109.14 m² de terreno.

--- Proyecto Menorca (urbanización en Ica) ---

MZ J Lote 3 — Vivienda unifamiliar de 50.00 m² techado
- Área total: 91.53 m² | Área techada: 50.00 m² (54.63%) | Área no techada: 41.53 m² (45.37%)
- Ancho de fachada: 6.00 m | Perímetro: 57.51 ml | 1 piso con acabados
- Altura piso a techo: 2.60 m | Altura total: 2.95 m
- Ambientes: Cochera (19.73 m²), Sala-Comedor (12.58 m²), Cocina (5.03 m²), Servicio higiénico (3.46 m²), Dormitorio principal (8.09 m²), Dormitorio secundario (7.04 m²), Patio-lavandería (6.27 m²)
- Material: material noble (albañilería y concreto) | Servicios: luz, agua y desagüe tradicional | Ventilación: natural

MZ J Lote 4 — Vivienda unifamiliar de 52.62 m² techado
- Área total: 90.08 m² | Área techada: 52.62 m² (58.41%) | Área no techada: 37.46 m² (41.59%)
- Ancho de fachada: 6.65 m | Perímetro: 33.60 ml | 1 piso con acabados
- Altura piso a techo: 2.60 m | Altura total: 2.95 m
- Ambientes: Cochera (18.23 m²), Sala-Comedor (13.55 m²), Cocina (5.34 m²), Servicio higiénico (3.46 m²), Dormitorio principal (9.35 m²), Dormitorio secundario (7.84 m²), Patio-lavandería (5.92 m²)
- Material: material noble (albañilería y concreto) | Servicios: luz, agua y desagüe tradicional | Ventilación: natural`;

// ============================================================
// 2. Real-estate catalog
// ============================================================

const BROCHURE_PROJECTS = [
  {
    name: "Puesta del Sol",
    city: "Ica",
    location: "Ica",
    description:
      'Urbanización diseñada para quienes buscan comodidad, seguridad y una excelente ubicación en la ciudad de Ica. Casas desde 90 m², cerca de centros comerciales y a minutos del centro de la ciudad. (Nombre de folleto — internamente también referida como "Sol de Ica"; las unidades reales en venta están cargadas bajo este proyecto.)',
    initial_from: 17000,
    price_cash: 170000,
    price_financed: 1450,
    financing_months: 70,
    monthly_payment: 1450,
    area_from: 90,
    amenities: ["Pórtico de ingreso", "Áreas verdes", "Servicios básicos", "Pistas y veredas"],
    status: "active",
  },
  {
    name: "Vista Mar",
    city: "Lurínchincha",
    location: "Km 200.5 Nueva Panamericana Sur",
    description:
      "Exclusivo proyecto premium con lotes frente al mar, elegante boulevard y piscina con vista al océano. Condominio Club House.",
    price_cash: 28000,
    monthly_payment: 480,
    amenities: ["Pórtico de ingreso", "Áreas verdes", "Servicios básicos", "Pistas y veredas"],
    status: "active",
  },
  {
    name: "Los Eucaliptos",
    city: "Ica",
    location: "Ica",
    description:
      "Urbanización que integra infraestructura urbana con entorno natural, en una de las zonas de más alta plusvalía de Ica. Mini zoológico y casa club. Metraje vendido.",
    area_from: 120,
    amenities: ["Mini zoológico", "Casa club", "Servicios básicos", "Pistas y veredas"],
    status: "sold_out",
  },
  {
    name: "Blue Village",
    city: "Pisco",
    location: "Km 217 Nueva Panamericana Sur, cerca playa Caucato",
    description:
      "Proyecto rodeado de naturaleza y cerca de la Playa de Caucato, estilo de vida tranquilo y confortable en familia.",
    price_cash: 16500,
    price_financed: 16500,
    monthly_payment: 392,
    financing_months: 70,
    area_from: 120,
    amenities: ["Mini zoológico", "Casa club", "Servicios básicos", "Pistas y veredas"],
    status: "active",
  },
  {
    name: "Las Colinas del Este",
    city: "Ica",
    location: "Cerca de la Plaza de los Aquijes",
    description:
      "Proyecto de lotes de campo para quienes buscan vivir rodeados de naturaleza sin alejarse de la ciudad, a 5 min de la Plaza de los Aquijes.",
    initial_from: 1000,
    price_cash: 15000,
    monthly_payment: 286,
    financing_months: 70,
    area_from: 120,
    amenities: ["Pórtico de ingreso", "Áreas verdes", "Servicios básicos", "Pistas y veredas"],
    status: "active",
  },
];

const PUESTA_DEL_SOL_UNITS = [
  {
    code: "MZ E LOTE 30",
    manzana: "MZ E",
    lote_number: 30,
    area_total: 105.0,
    area_techada: 55.93,
    area_no_techada: 49.07,
    rooms: [
      { name: "Cochera", area: 20.65 },
      { name: "Sala - Comedor", area: 16.65 },
      { name: "Cocina", area: 6.42 },
      { name: "Servicio higiénico", area: 3.8 },
      { name: "Dormitorio principal", area: 7.68 },
      { name: "Dormitorio secundario", area: 6.52 },
      { name: "Lavandería - patio", area: 8.24 },
    ],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
  {
    code: "MZ K2 LOTE 4",
    manzana: "MZ K2",
    lote_number: 4,
    area_total: 102.0,
    area_techada: 50.0,
    area_no_techada: 52.0,
    rooms: [
      { name: "Cochera", area: 23.32 },
      { name: "Sala - Comedor", area: 12.6 },
      { name: "Cocina", area: 5.05 },
      { name: "Servicio higiénico", area: 3.46 },
      { name: "Dormitorio principal", area: 8.46 },
      { name: "Dormitorio secundario", area: 7.04 },
      { name: "Patio - lavandería", area: 6.27 },
    ],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
  {
    code: "MZ D LOTE 4",
    manzana: "MZ D",
    lote_number: 4,
    area_total: 90.0,
    rooms: [],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
  {
    code: "MZ D LOTE 5",
    manzana: "MZ D",
    lote_number: 5,
    area_total: 90.0,
    rooms: [],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
  {
    code: "MZ E1 LOTE 8",
    manzana: "MZ E1",
    lote_number: 8,
    area_total: 109.14,
    rooms: [],
    floors: 1,
    status: "disponible",
  },
];

const MENORCA_UNITS = [
  {
    code: "MZ J LOTE 3",
    manzana: "MZ J",
    lote_number: 3,
    area_total: 91.53,
    area_techada: 50.0,
    area_no_techada: 41.53,
    rooms: [
      { name: "Cochera", area: 19.73 },
      { name: "Sala - Comedor", area: 12.58 },
      { name: "Cocina", area: 5.03 },
      { name: "Servicio higiénico", area: 3.46 },
      { name: "Dormitorio principal", area: 8.09 },
      { name: "Dormitorio secundario", area: 7.04 },
      { name: "Patio - lavandería", area: 6.27 },
    ],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
  {
    code: "MZ J LOTE 4",
    manzana: "MZ J",
    lote_number: 4,
    area_total: 90.08,
    area_techada: 52.62,
    area_no_techada: 37.46,
    rooms: [
      { name: "Cochera", area: 18.23 },
      { name: "Sala - Comedor", area: 13.55 },
      { name: "Cocina", area: 5.34 },
      { name: "Servicio higiénico", area: 3.46 },
      { name: "Dormitorio principal", area: 9.35 },
      { name: "Dormitorio secundario", area: 7.84 },
      { name: "Patio - lavandería", area: 5.92 },
    ],
    floors: 1,
    height_floor: 2.6,
    height_total: 2.95,
    material: "Material noble (albañilería y concreto)",
    services: "Luz, agua y desagüe tradicional",
    ventilation: "Natural",
    status: "disponible",
  },
];

// ============================================================
// Run
// ============================================================

async function main() {
  console.log(`Seeding Golden Habitat data for account ${accountId}...\n`);

  console.log("Knowledge base:");
  await insertKnowledgeDoc("Golden Habitat - Información General", DOC_INFO_GENERAL);
  await insertKnowledgeDoc("Golden Habitat - Proyectos", DOC_PROYECTOS);
  await insertKnowledgeDoc("Golden Habitat - Viviendas Disponibles", DOC_VIVIENDAS);

  console.log("\nProyectos y unidades:");
  for (const project of BROCHURE_PROJECTS) {
    const id = await insertProject(project);
    if (project.name === "Puesta del Sol") {
      await insertUnits(id, PUESTA_DEL_SOL_UNITS);
    }
  }
  const menorcaId = await insertProject({
    name: "Menorca",
    city: "Ica",
    location: "Ica",
    description:
      "Urbanización en Ica con viviendas unifamiliares de una planta, material noble. Inventario cargado desde fichas técnicas (MZ J Lote 3 y Lote 4).",
    area_from: 90,
    amenities: ["Servicios básicos", "Pistas y veredas"],
    status: "active",
  });
  await insertUnits(menorcaId, MENORCA_UNITS);

  console.log("\nDone. Unit prices were left blank (not specified in the fichas técnicas) —");
  console.log("set them per-unit from Proyectos → [unidad] → Editar before publishing.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
