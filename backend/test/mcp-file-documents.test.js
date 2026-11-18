import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import JSZip from 'jszip';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { DOCUMENT_TEXT_LIMITS, extractDocumentText } from '../src/modules/vault/vault-text.js';
import { isReadableFile } from '../src/modules/vault/vault.service.js';

// PDFs and Word documents read as text through the vault's text route: built here, small, by
// hand (a PDF with one text object per line) and with jszip (a .docx). Extraction runs in a
// worker with time, page and length limits; a file it cannot read is refused with a 422.

const TENANT_ID = 'tenant-acme';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// pages: one array of lines per page, or null for a page with only a drawn shape (no text layer).
function pdfWith(pages, { encrypt = false } = {}) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const stream = lines ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(' ')} ET` : '0 0 1 rg 72 72 200 200 re f';
    kids.push(`${objects.length} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  // Standard security with a user password the empty one does not match.
  if (encrypt) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  const security = encrypt ? ` /Encrypt ${objects.length - 1} 0 R /ID [<${'33'.repeat(16)}> <${'33'.repeat(16)}>]` : '';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R${security} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const paragraph = (text) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function docxWith(body) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ compression: 'DEFLATE', type: 'nodebuffer' });
}

async function fixture(t) {
  const user = { authMethod: 'basic', email: 'user-member@acme.example', id: 'user-member', memberships: [{ role: 'user', tenantId: TENANT_ID }], name: 'Member', password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } };
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }], users: [user] });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: user.id, role: 'user' }] },
    projects: [{ epics: [], id: 'project-1', name: 'project-1', status: 'In Progress', tenantId: TENANT_ID }],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-file-documents-fixture', secret: 'disposable-file-documents-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, projectRepository, sessionsRepository, tokenService,
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const token = tokenService.signSessionToken({ email: user.email, id: user.id, name: user.name, preferences: {}, role: 'user', tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
  // Saved straight to the repository, past the upload route's body limit, as mail attachments are.
  const save = (bytes, fileName, fileType) => projectRepository.saveFile({
    fileContentsBase64: Buffer.from(bytes).toString('base64'), fileDescription: '', fileName, fileType,
    inlineImage: false, projectId: 'project-1', targetId: 'project-1', targetType: 'project', tenantId: TENANT_ID, user: { id: user.id, name: user.name },
  });
  async function read(file, query = '') {
    const response = await fetch(`${origin}/api/projects/project-1/files/${file.id}/text${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  return { read, save };
}

test('a PDF reads page by page, a window at a time', { timeout: 60_000 }, async (t) => {
  const { read, save } = await fixture(t);
  const file = await save(pdfWith([['Statement of work', 'Cutover on 1 December'], ['Risks: the vendor is late']]), 'sow.pdf', 'application/pdf');
  assert.equal(isReadableFile(file), true);
  const whole = await read(file);
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  const text = '--- Page 1 of 2 ---\nStatement of work\nCutover on 1 December\n\n--- Page 2 of 2 ---\nRisks: the vendor is late';
  assert.deepEqual(whole.body.text, { content: text, end: text.length, nextOffset: null, offset: 0, totalChars: text.length });

  const first = await read(file, '?maxChars=20');
  assert.deepEqual([first.body.text.content, first.body.text.nextOffset], ['--- Page 1 of 2 ---\n', 20]);
  const rest = await read(file, `?offset=${first.body.text.nextOffset}`);
  assert.equal(first.body.text.content + rest.body.text.content, text);
  assert.equal(rest.body.text.nextOffset, null);
});

test('a Word document reads as paragraphs and table rows', { timeout: 60_000 }, async (t) => {
  const { read, save } = await fixture(t);
  const body = [
    paragraph('Launch &amp; cutover plan'),
    '<w:p><w:r><w:t>Owner:</w:t></w:r><w:r><w:tab/><w:t>Grace</w:t></w:r><w:r><w:br/><w:t>Backup: Ada</w:t></w:r></w:p>',
    `<w:tbl><w:tr><w:tc>${paragraph('Task')}</w:tc><w:tc>${paragraph('Due')}</w:tc></w:tr><w:tr><w:tc>${paragraph('Cutover')}${paragraph('(overnight)')}</w:tc><w:tc>${paragraph('1 Dec')}</w:tc></w:tr></w:tbl>`,
    // A text box comes twice, as the shape and as an older fallback copy.
    '<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>Go/no-go on 28 Nov</w:t></mc:Choice><mc:Fallback><w:t>Go/no-go on 28 Nov</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    '<w:p><w:del><w:r><w:delText>Deleted words</w:delText></w:r></w:del><w:r><w:t>Signed off</w:t></w:r></w:p>',
  ].join('');
  const file = await save(await docxWith(body), 'plan.docx', DOCX_TYPE);
  const result = await read(file);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.text.content, 'Launch & cutover plan\nOwner: Grace\nBackup: Ada\nTask | Due\nCutover (overnight) | 1 Dec\nGo/no-go on 28 Nov\nSigned off');
  // Known by its name when stored without the Word type.
  assert.equal((await read(await save(await docxWith(paragraph('Named only')), 'named.docx', 'application/octet-stream'))).body.text.content, 'Named only');
});

test('a scanned, password-protected or damaged document is refused with a reason, not a crash', { timeout: 60_000 }, async (t) => {
  const { read, save } = await fixture(t);
  const cases = [
    [pdfWith([null]), 'scan.pdf', 'application/pdf', /no text layer/],
    [pdfWith([['Secret']], { encrypt: true }), 'locked.pdf', 'application/pdf', /password-protected/],
    [Buffer.from('%PDF-1.7\nnot really a PDF'), 'broken.pdf', 'application/pdf', /damaged/],
    [await docxWith('<w:p/>'), 'empty.docx', DOCX_TYPE, /no text/],
    [Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]), 'locked.docx', DOCX_TYPE, /password-protected or in the old \.doc format/],
    [Buffer.from('PK\u0003\u0004 not a zip'), 'broken.docx', DOCX_TYPE, /damaged/],
  ];
  for (const [bytes, fileName, fileType, reason] of cases) {
    const refused = await read(await save(bytes, fileName, fileType));
    assert.equal(refused.status, 422, `${fileName}: ${JSON.stringify(refused.body)}`);
    assert.match(JSON.stringify(refused.body), reason, fileName);
  }
});

test('a document over the size cap is refused before it is parsed', { timeout: 60_000 }, async (t) => {
  const { read, save } = await fixture(t);
  const big = Buffer.concat([pdfWith([['Big']]), Buffer.alloc(DOCUMENT_TEXT_LIMITS.bytes, 0x20)]);
  assert.equal((await read(await save(big, 'big.pdf', 'application/pdf'))).status, 413);
});

test('extraction stops at its page, length and time limits', { timeout: 60_000 }, async () => {
  const limits = (overrides) => ({ ...DOCUMENT_TEXT_LIMITS, ...overrides });
  const paged = await extractDocumentText('pdf', pdfWith([['One'], ['Two'], ['Three']]), limits({ pages: 2 }));
  assert.equal(paged, '--- Page 1 of 3 ---\nOne\n\n--- Page 2 of 3 ---\nTwo\n\n[Odin read only part of this PDF: up to page 2 of 3.]');
  const long = await extractDocumentText('docx', await docxWith(paragraph('word '.repeat(400))), limits({ chars: 100 }));
  assert.match(long, /^(word ){19}word\n\n\[Odin read only the first 100 characters of this document\.\]$/);
  await assert.rejects(extractDocumentText('pdf', pdfWith([['Slow']]), limits({ timeoutMs: 1 })), (error) => error.statusCode === 422 && error.details.code === 'too_slow');
});
