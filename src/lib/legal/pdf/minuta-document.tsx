import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles, fullName } from './shared-styles'
import type { Anexo01Data, Anexo02Data, RealEstateProject, RealEstateUnit } from '@/types'
import { montoALetras } from '../numero-a-letras'

// The seller-side data (empresa, representante, DNI, dirección) is
// read straight off `project` — that's what makes the same template
// adapt automatically per project/city, instead of hardcoding an
// if/else on project name the way a naive multi-project contract
// generator would.
export function MinutaDocument({
  project,
  units,
  anexo01,
  anexo02,
  fechaMinuta,
  ciudad,
}: {
  project: RealEstateProject
  units: RealEstateUnit[]
  anexo01: Anexo01Data
  anexo02: Anexo02Data
  fechaMinuta: string
  ciudad: string
}) {
  const buyer = anexo01.comprador
  const unitCodes = units.map((u) => u.code).join(', ')

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>MINUTA DE COMPRAVENTA</Text>
        <Text style={styles.subtitle}>
          {project.name} — {ciudad}, {fechaMinuta}
        </Text>

        <Text style={styles.sectionTitle}>Comparecientes</Text>
        <Text style={styles.paragraph}>
          De una parte, {project.seller_company || project.name}, debidamente representada por
          su representante legal {project.seller_representative || '________________'},
          identificado con DNI N° {project.seller_dni || '________________'}, con domicilio en{' '}
          {project.seller_address || '________________'}, a quien en adelante se le denominará
          EL VENDEDOR; y de la otra parte, {fullName(buyer)}, identificado con DNI N°{' '}
          {buyer.dni || '________________'}, de estado civil {buyer.estado_civil || '________'},
          con domicilio en {buyer.direccion || '________________'}
          {anexo01.tiene_conyuge && anexo01.conyuge
            ? `, junto a su cónyuge ${fullName(anexo01.conyuge)}, identificado con DNI N° ${
                anexo01.conyuge.dni || '________________'
              },`
            : ''}{' '}
          a quien en adelante se le denominará EL COMPRADOR.
        </Text>

        <Text style={styles.sectionTitle}>Objeto del Contrato</Text>
        <Text style={styles.paragraph}>
          EL VENDEDOR transfiere a título de compraventa a favor de EL COMPRADOR, quien acepta,
          el/los inmueble(s) identificado(s) como {unitCodes}, del proyecto {project.name},
          ubicado en {project.location || project.city || ciudad}.
        </Text>

        <Text style={styles.sectionTitle}>Precio y Forma de Pago</Text>
        <Text style={styles.paragraph}>
          El precio total de venta es de {anexo02.precio_total.toLocaleString()}{' '}
          ({montoALetras(anexo02.precio_total, units[0]?.currency ?? 'PEN')}), de los cuales EL
          COMPRADOR ha entregado como cuota inicial la suma de{' '}
          {anexo02.cuota_inicial.toLocaleString()}, comprometiéndose a cancelar el saldo
          conforme al cronograma de cuotas detallado en el Anexo 02, que forma parte integrante
          de la presente minuta.
        </Text>

        <Text style={styles.sectionTitle}>Cláusulas Generales</Text>
        <Text style={styles.paragraph}>
          Ambas partes declaran conocer y aceptar los términos del Anexo 01 (datos del
          comprador e inmueble) y Anexo 02 (estructura de financiamiento), documentos que se
          adjuntan y forman parte inseparable de la presente minuta. El incumplimiento en el
          pago de dos o más cuotas consecutivas facultará a EL VENDEDOR a resolver el presente
          contrato conforme a ley.
        </Text>

        <Text style={{ marginTop: 10 }}>
          En señal de conformidad, las partes suscriben el presente documento en la ciudad de{' '}
          {ciudad}, a los {fechaMinuta}.
        </Text>

        <View style={styles.signatureRow}>
          <View style={styles.signatureBlock}>
            <Text>EL COMPRADOR</Text>
            <Text style={{ marginTop: 2 }}>DNI {buyer.dni || '—'}</Text>
          </View>
          {anexo01.tiene_conyuge && anexo01.conyuge && (
            <View style={styles.signatureBlock}>
              <Text>CÓNYUGE</Text>
              <Text style={{ marginTop: 2 }}>DNI {anexo01.conyuge.dni || '—'}</Text>
            </View>
          )}
          <View style={styles.signatureBlock}>
            <Text>EL VENDEDOR</Text>
            <Text style={{ marginTop: 2 }}>{project.seller_company || project.name}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
