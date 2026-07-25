// Shared @react-pdf/renderer StyleSheet for the three legal document
// templates — keeps typography/spacing consistent without repeating
// the same rules in every file.

import { StyleSheet } from '@react-pdf/renderer'

export const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
    lineHeight: 1.4,
    color: '#111827',
  },
  title: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    textAlign: 'center',
    marginBottom: 16,
    color: '#4b5563',
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginTop: 14,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  paragraph: {
    marginBottom: 6,
    textAlign: 'justify',
  },
  row: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  label: {
    fontFamily: 'Helvetica-Bold',
    width: 130,
  },
  value: {
    flex: 1,
  },
  table: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderBottomWidth: 1,
    borderBottomColor: '#d1d5db',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tableCell: {
    padding: 5,
    fontSize: 9,
  },
  tableCellHeader: {
    padding: 5,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
  },
  signatureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 60,
  },
  signatureBlock: {
    width: '30%',
    borderTopWidth: 1,
    borderTopColor: '#111827',
    paddingTop: 6,
    textAlign: 'center',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    fontSize: 8,
    color: '#9ca3af',
    textAlign: 'center',
  },
})

export function fullName(buyer: { nombre: string }): string {
  return buyer.nombre?.trim() || '(sin nombre)'
}
