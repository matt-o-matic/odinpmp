import ExcelJS from 'exceljs';

function scalar(value) { return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : String(value ?? ''); }
function csvCell(value) { const normalized = scalar(value); return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized; }
export function reportCsv(rows, columns) { return `${columns.map(csvCell).join(',')}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\n')}\n`; }

export async function reportXlsx(rows, columns, title = 'Odin report') {
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'OdinPMP'; workbook.created = new Date();
  const sheet = workbook.addWorksheet(String(title || 'Report').slice(0, 31));
  sheet.columns = columns.map((column) => ({ header: column, key: column, width: Math.max(12, Math.min(40, column.length + 4)) }));
  sheet.addRows(rows.map((row) => Object.fromEntries(columns.map((column) => [column, scalar(row[column])]))));
  sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: `${columnName(columns.length)}1` };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function columnName(index) { let value = ''; for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + (current - 1) % 26) + value; return value || 'A'; }
function pdfEscape(value) { return scalar(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replace(/[^\x20-\x7E]/g, '?'); }
export function reportPdf(rows, columns, title = 'Odin report') {
  const lines = [title, '', columns.join(' | '), ...rows.map((row) => columns.map((column) => scalar(row[column])).join(' | '))];
  const pages = []; for (let index = 0; index < lines.length; index += 48) pages.push(lines.slice(index, index + 48));
  const objects = [null]; const catalogId = objects.push('') - 1; const pagesId = objects.push('') - 1; const fontId = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') - 1; const pageIds = [];
  for (const pageLines of pages) {
    const stream = `BT\n/F1 9 Tf\n40 760 Td\n12 TL\n${pageLines.map((line, index) => `${index ? 'T* ' : ''}(${pdfEscape(line).slice(0, 120)}) Tj`).join('\n')}\nET`;
    const contentId = objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`) - 1;
    const pageId = objects.push('') - 1; pageIds.push(pageId); objects[pageId] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`; objects[pagesId] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let output = '%PDF-1.4\n'; const offsets = [0]; for (let id = 1; id < objects.length; id += 1) { offsets[id] = Buffer.byteLength(output); output += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

export async function formatReportExport({ columns, format, rows, title }) {
  if (format === 'json') return { buffer: Buffer.from(`${JSON.stringify(rows, null, 2)}\n`), contentType: 'application/json', extension: 'json' };
  if (format === 'csv') return { buffer: Buffer.from(reportCsv(rows, columns)), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
  if (format === 'xlsx') return { buffer: await reportXlsx(rows, columns, title), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
  return { buffer: reportPdf(rows, columns, title), contentType: 'application/pdf', extension: 'pdf' };
}
