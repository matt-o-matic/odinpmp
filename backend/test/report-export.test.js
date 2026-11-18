import assert from 'node:assert/strict';
import test from 'node:test';

import { formatReportExport, reportCsv, reportPdf } from '../src/modules/reporting/report-export.js';

test('report exports produce escaped CSV, real XLSX, valid PDF, and JSON bytes', async () => {
  const rows = [{ name: 'Launch, phase 1', status: 'On "track"' }]; const columns = ['name', 'status'];
  assert.match(reportCsv(rows, columns), /"Launch, phase 1","On ""track"""/);
  const xlsx = await formatReportExport({ columns, format: 'xlsx', rows, title: 'Delivery' }); assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK'); assert.match(xlsx.contentType, /spreadsheet/);
  const pdf = reportPdf(rows, columns, 'Delivery'); assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4'); assert.match(pdf.toString('ascii'), /\/Type \/Catalog/);
  const json = await formatReportExport({ columns, format: 'json', rows, title: 'Delivery' }); assert.deepEqual(JSON.parse(json.buffer.toString()), rows);
});
