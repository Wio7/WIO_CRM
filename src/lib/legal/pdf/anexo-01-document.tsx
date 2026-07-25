import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles, fullName } from './shared-styles'
import type { Anexo01Data, BuyerData, RealEstateUnit } from '@/types'

function BuyerBlock({ title, buyer }: { title: string; buyer: BuyerData }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.row}>
        <Text style={styles.label}>Nombre completo:</Text>
        <Text style={styles.value}>{fullName(buyer)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>DNI:</Text>
        <Text style={styles.value}>{buyer.dni || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Estado civil:</Text>
        <Text style={styles.value}>{buyer.estado_civil || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Nacionalidad:</Text>
        <Text style={styles.value}>{buyer.nacionalidad || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Ocupación:</Text>
        <Text style={styles.value}>{buyer.ocupacion || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Profesión:</Text>
        <Text style={styles.value}>{buyer.profesion || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Dirección:</Text>
        <Text style={styles.value}>{buyer.direccion || '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Provincia / Depto:</Text>
        <Text style={styles.value}>
          {[buyer.provincia, buyer.departamento].filter(Boolean).join(' / ') || '—'}
        </Text>
      </View>
    </View>
  )
}

export function Anexo01Document({
  data,
  units,
  projectName,
  reservationDate,
}: {
  data: Anexo01Data
  units: RealEstateUnit[]
  projectName: string
  reservationDate: string
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>ANEXO 01</Text>
        <Text style={styles.subtitle}>Datos del Comprador y del Inmueble</Text>

        <BuyerBlock title="Comprador" buyer={data.comprador} />

        {data.tiene_conyuge && data.conyuge && (
          <BuyerBlock title="Cónyuge / Copropietario" buyer={data.conyuge} />
        )}

        <Text style={styles.sectionTitle}>Inmueble(s) Seleccionado(s)</Text>
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.tableCellHeader, { width: '30%' }]}>Código</Text>
            <Text style={[styles.tableCellHeader, { width: '25%' }]}>Proyecto</Text>
            <Text style={[styles.tableCellHeader, { width: '20%' }]}>Área total</Text>
            <Text style={[styles.tableCellHeader, { width: '25%' }]}>Precio</Text>
          </View>
          {units.map((u) => (
            <View style={styles.tableRow} key={u.id}>
              <Text style={[styles.tableCell, { width: '30%' }]}>{u.code}</Text>
              <Text style={[styles.tableCell, { width: '25%' }]}>{projectName}</Text>
              <Text style={[styles.tableCell, { width: '20%' }]}>
                {u.area_total ? `${u.area_total} m²` : '—'}
              </Text>
              <Text style={[styles.tableCell, { width: '25%' }]}>
                {u.price != null ? `${u.currency} ${u.price.toLocaleString()}` : '—'}
              </Text>
            </View>
          ))}
        </View>

        {data.inmuebles_adicionales.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Inmuebles Adicionales</Text>
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.tableCellHeader, { width: '25%' }]}>Tipo</Text>
                <Text style={[styles.tableCellHeader, { width: '20%' }]}>Área</Text>
                <Text style={[styles.tableCellHeader, { width: '55%' }]}>Descripción</Text>
              </View>
              {data.inmuebles_adicionales.map((a, i) => (
                <View style={styles.tableRow} key={i}>
                  <Text style={[styles.tableCell, { width: '25%' }]}>{a.type}</Text>
                  <Text style={[styles.tableCell, { width: '20%' }]}>
                    {a.area ? `${a.area} m²` : '—'}
                  </Text>
                  <Text style={[styles.tableCell, { width: '55%' }]}>{a.description || '—'}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={{ marginTop: 20, fontSize: 9, color: '#6b7280' }}>
          Documento generado el {reservationDate}. Forma parte integrante del contrato de
          reserva/compraventa suscrito entre las partes.
        </Text>

        <View style={styles.signatureRow}>
          <View style={styles.signatureBlock}>
            <Text>Comprador</Text>
          </View>
          {data.tiene_conyuge && (
            <View style={styles.signatureBlock}>
              <Text>Cónyuge</Text>
            </View>
          )}
          <View style={styles.signatureBlock}>
            <Text>Vendedor</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
