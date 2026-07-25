import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from './shared-styles'
import type { Anexo02Data } from '@/types'
import { montoALetras } from '../numero-a-letras'

const FINANCIAMIENTO_LABEL: Record<Anexo02Data['tipo_financiamiento'], string> = {
  contado: 'Pago al Contado',
  credito_directo: 'Crédito Directo (Inmobiliaria)',
  credito_hipotecario: 'Crédito Hipotecario (Banco + Inmobiliaria)',
}

export function Anexo02Document({
  data,
  currency,
  buyerName,
}: {
  data: Anexo02Data
  currency: string
  buyerName: string
}) {
  const cuotasTotal = data.cuotas.reduce((sum, c) => sum + c.monto, 0)
  const saldoFinanciar = data.precio_total - data.cuota_inicial

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>ANEXO 02</Text>
        <Text style={styles.subtitle}>Estructura de Financiamiento y Cronograma de Pagos</Text>

        <View style={styles.row}>
          <Text style={styles.label}>Comprador:</Text>
          <Text style={styles.value}>{buyerName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Precio total:</Text>
          <Text style={styles.value}>
            {currency} {data.precio_total.toLocaleString()}
          </Text>
        </View>
        <Text style={{ fontSize: 8, color: '#6b7280', marginBottom: 6 }}>
          Son: {montoALetras(data.precio_total, currency)}
        </Text>
        <View style={styles.row}>
          <Text style={styles.label}>Cuota inicial:</Text>
          <Text style={styles.value}>
            {currency} {data.cuota_inicial.toLocaleString()}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Saldo a financiar:</Text>
          <Text style={styles.value}>
            {currency} {saldoFinanciar.toLocaleString()}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Modalidad:</Text>
          <Text style={styles.value}>{FINANCIAMIENTO_LABEL[data.tipo_financiamiento]}</Text>
        </View>

        <Text style={styles.sectionTitle}>Cronograma de Cuotas</Text>
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.tableCellHeader, { width: '15%' }]}>N°</Text>
            <Text style={[styles.tableCellHeader, { width: '40%' }]}>Fecha límite</Text>
            <Text style={[styles.tableCellHeader, { width: '45%' }]}>Monto</Text>
          </View>
          {data.cuotas.map((c) => (
            <View style={styles.tableRow} key={c.numero}>
              <Text style={[styles.tableCell, { width: '15%' }]}>{c.numero}</Text>
              <Text style={[styles.tableCell, { width: '40%' }]}>{c.fecha_limite}</Text>
              <Text style={[styles.tableCell, { width: '45%' }]}>
                {currency} {c.monto.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </Text>
            </View>
          ))}
          <View style={[styles.tableRow, { backgroundColor: '#f9fafb' }]}>
            <Text style={[styles.tableCellHeader, { width: '55%' }]}>Total cuotas</Text>
            <Text style={[styles.tableCellHeader, { width: '45%' }]}>
              {currency} {cuotasTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </Text>
          </View>
        </View>

        <View style={styles.signatureRow}>
          <View style={styles.signatureBlock}>
            <Text>Comprador</Text>
          </View>
          <View style={styles.signatureBlock}>
            <Text>Vendedor</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
