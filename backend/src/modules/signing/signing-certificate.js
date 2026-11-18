// The completion certificate: a plain PDF built from the stored record each time it is asked
// for. The record (package, evidence and sealed manifest) is the proof; the certificate is a
// readable copy of it. Text only, Helvetica, Latin-1: other characters print as "?". No PDF
// library is needed for this.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const LINE_HEIGHT = 14;
const WRAP = 92;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - (MARGIN * 2)) / LINE_HEIGHT);

function latin1(text) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function escapePdf(text) {
  return latin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(line, width = WRAP) {
  const text = latin1(line);
  if (text.length <= width) return [text];
  const out = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= width / 2) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = `    ${rest.slice(cut).trimStart()}`;
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/** A PDF of `lines` ({ text, bold? } or a string; '' for a blank line), as a Buffer. */
export function renderTextPdf({ lines, title = 'Certificate' }) {
  const rows = lines.flatMap((line) => {
    const entry = typeof line === 'string' ? { text: line } : line;
    return wrap(entry.text).map((text) => ({ bold: Boolean(entry.bold), text }));
  });
  const pages = [];
  for (let index = 0; index < Math.max(rows.length, 1); index += LINES_PER_PAGE) pages.push(rows.slice(index, index + LINES_PER_PAGE));

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesId = add(null);
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  for (const page of pages) {
    const commands = ['BT', `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`, `${LINE_HEIGHT} TL`];
    for (const row of page) commands.push(`/${row.bold ? 'F2' : 'F1'} 10 Tf`, `(${escapePdf(row.text)}) Tj`, 'T*');
    commands.push('ET');
    const stream = Buffer.from(commands.join('\n'), 'latin1');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Title (${escapePdf(title)}) /Producer (Odin) >>`);

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const KIND_LABELS = { acceptance: 'Document acceptance', signoff: 'Sign-off' };

/** The certificate's lines for a completed request, as presented by the signing service. */
export function certificateLines({ detail, projectName = '', subjectName = '' }) {
  const { documents, request, signatures, signers } = detail;
  const signatureBySigner = new Map(signatures.map((signature) => [signature.signerId, signature]));
  const lines = [
    { bold: true, text: `${KIND_LABELS[request.kind] ?? 'Signature'} certificate` },
    '',
    `Title: ${request.title}`,
    `Project: ${projectName}`,
    `Subject: ${subjectName}`,
    `Request: ${request.id}`,
    `Requested: ${request.createdAt}`,
    `Completed: ${request.endedAt ?? ''}`,
    '',
    { bold: true, text: 'Statement signed' },
    request.statement,
    '',
    { bold: true, text: documents.length ? 'Documents' : 'Documents: none' },
  ];
  for (const document of documents) {
    lines.push(`${document.position + 1}. ${document.fileName} (version ${document.version}, ${document.fileSize} bytes, ${document.contentType})`);
    lines.push(`   SHA-256: ${document.sha256}`);
  }
  lines.push('', { bold: true, text: 'Signers' });
  for (const signer of signers) {
    if (signer.status === 'signed') {
      const signature = signatureBySigner.get(signer.id);
      lines.push(`${signer.signedName ?? signer.name}${signer.signedTitle ? `, ${signer.signedTitle}` : ''}${signer.signedOrganization ? `, ${signer.signedOrganization}` : ''} <${signer.email}>`);
      lines.push(`   Signed ${signer.signedAt}, verified by a code sent to that address`);
      if (signature) lines.push(`   Evidence SHA-256: ${signature.evidenceHash}`);
    } else if (signer.status === 'removed') {
      lines.push(`${signer.name} <${signer.email}>: removed ${signer.removedAt}${signer.removalReason ? ` (${signer.removalReason})` : ''}`);
    }
  }
  lines.push(
    '',
    { bold: true, text: 'Record' },
    `Package SHA-256: ${request.packageHash}`,
    `Manifest SHA-256: ${request.manifestHash ?? ''}`,
    `Seal (HMAC-SHA256, key ${request.sealKeyId ?? ''}): ${request.seal ?? ''}`,
    '',
    'Each signer typed their name and agreed to sign electronically after entering a one-time code emailed to them.',
    'Odin keeps each signature\'s evidence and the sealed manifest; any change to a signed document changes its hash.',
  );
  return lines;
}
