// Extracts the text of one Word document (.docx), Excel workbook (.xlsx), PowerPoint deck (.pptx)
// or PDF in a worker thread, so vault-text.js can
// end it when a hostile file takes too long or too much memory, without stalling Odin. Posts back
// { ok: true, text } or { ok: false, code, message }.
import { StringDecoder } from 'node:string_decoder';
import { parentPort, workerData } from 'node:worker_threads';
import { Parser } from 'htmlparser2';
import JSZip from 'jszip';
import { getDocumentProxy } from 'unpdf';

const { bytes, kind, maxChars, maxPages } = workerData;

const refusal = (code, message) => Object.assign(new Error(message), { code, refusal: true });
const tidy = (text) => text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Password-protected Office files are OLE containers, not zips; so are old .doc files.
const isOle = (data) => data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));

// Paragraph text from word/document.xml, streamed so a zip bomb never sits in memory. Paragraphs
// and table rows end lines; cells in a row are joined with " | ".
async function docxText() {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    if (isOle(bytes)) throw refusal('encrypted', 'This Word document is password-protected or in the old .doc format, so its text cannot be read.');
    throw refusal('corrupt', 'This Word document is damaged or is not really a .docx file, so its text cannot be read.');
  }
  const part = zip.file('word/document.xml');
  if (!part) throw refusal('corrupt', 'This Word document is damaged or is not really a .docx file, so its text cannot be read.');
  const pieces = [];
  const stack = [];
  let length = 0;
  let fallback = 0;
  let cells = 0;
  const add = (text) => { pieces.push(text); length += text.length; };
  const parser = new Parser({
    onopentag(name) {
      const parent = stack.at(-1);
      stack.push(name);
      // Drawings come twice, as the shape and as an older fallback copy; read the shape only.
      if (name === 'mc:Fallback') fallback += 1;
      if (name === 'w:tc') cells += 1;
      if (fallback || parent !== 'w:r') return;
      if (name === 'w:tab') add('\t');
      else if (name === 'w:br' || name === 'w:cr') add(cells ? ' ' : '\n');
      else if (name === 'w:noBreakHyphen') add('-');
    },
    ontext(text) {
      if (!fallback && stack.at(-1) === 'w:t') add(text);
    },
    onclosetag(name) {
      stack.pop();
      if (name === 'mc:Fallback') fallback -= 1;
      if (name === 'w:tc') cells -= 1;
      if (fallback) return;
      if (name === 'w:tc') add(' | ');
      else if (name === 'w:tr') {
        if (pieces.at(-1) === ' | ') pieces.pop();
        add('\n');
      } else if (name === 'w:p') add(cells ? ' ' : '\n');
    },
  }, { decodeEntities: true, xmlMode: true });
  let truncated = false;
  await new Promise((resolve, reject) => {
    const stream = part.nodeStream('nodebuffer');
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk) => {
      parser.write(decoder.write(chunk));
      if (length > maxChars) { truncated = true; stream.destroy(); resolve(); }
    });
    stream.on('end', () => { parser.write(decoder.end()); parser.end(); resolve(); });
    stream.on('error', () => reject(refusal('corrupt', 'This Word document is damaged, so its text cannot be read.')));
  });
  const text = tidy(pieces.join('').slice(0, maxChars));
  if (!text) throw refusal('no_text', 'This Word document has no text in it (it may be only images), so there is nothing to read.');
  return truncated ? `${text}\n\n[Odin read only the first ${maxChars.toLocaleString('en-US')} characters of this document.]` : text;
}

// Each page's text under a "--- Page n of N ---" line, so the reader can cite pages.
async function pdfText() {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (error) {
    if (error?.name === 'PasswordException') throw refusal('encrypted', 'This PDF is password-protected, so its text cannot be read.');
    throw refusal('corrupt', 'This PDF is damaged or is not really a PDF, so its text cannot be read.');
  }
  const total = pdf.numPages;
  const pages = [];
  let length = 0;
  let found = false;
  for (let number = 1; number <= Math.min(total, maxPages) && length <= maxChars; number += 1) {
    let text;
    try {
      const content = await (await pdf.getPage(number)).getTextContent();
      text = tidy(content.items.filter((item) => item.str != null).map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''));
      found ||= Boolean(text);
    } catch {
      text = '[This page could not be read.]';
    }
    const page = `--- Page ${number} of ${total} ---\n${text}`;
    pages.push(page);
    length += page.length + 2;
  }
  if (!found) throw refusal('no_text', 'This PDF has no text layer (it is probably scanned pages), so there is no text to read.');
  const text = pages.join('\n\n').slice(0, maxChars);
  return pages.length < total || length > maxChars ? `${text}\n\n[Odin read only part of this PDF: up to page ${pages.length} of ${total}.]` : text;
}

const KIND_NAMES = { docx: 'Word document', pdf: 'PDF', pptx: 'PowerPoint deck', xlsx: 'Excel workbook' };
// A part of an Office zip larger than this, uncompressed, is not read: a zip bomb stops here.
const MAX_PART_BYTES = 64 * 1024 * 1024;

async function officeZip(label) {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    if (isOle(bytes)) throw refusal('encrypted', `This ${label} is password-protected or in an old binary format, so its text cannot be read.`);
    throw refusal('corrupt', `This ${label} is damaged, so its text cannot be read.`);
  }
}

async function partText(zip, name) {
  const part = name ? zip.file(name) : null;
  if (!part) return null;
  if (Number(part._data?.uncompressedSize ?? 0) > MAX_PART_BYTES) throw refusal('too_complex', 'Part of this file is too large to read.');
  return part.async('string');
}

// Runs htmlparser2 over XML: `on.open(name, attributes)`, `on.text(text)` and `on.close(name)`.
// Element names come without their namespace prefix, since a valid file may use any prefix
// (`<rel:Relationship>`, `<d:p>`). The relationship id (`r:id` under any prefix) is passed as
// `relationshipId`, apart from an element's own `id`: the `id` attribute whose prefix is declared
// as the relationships namespace, or, in a file that doesn't declare it, a prefixed `id` that is
// not a namespace declaration (`xmlns:id`).
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const localName = (name) => name.slice(name.indexOf(':') + 1);
const prefixOf = (name) => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '');
function walkXml(xml, on) {
  // Namespace declarations in scope, innermost last: [{ prefix: uri }].
  const scopes = [];
  const namespaceOf = (prefix) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) if (prefix in scopes[index]) return scopes[index][prefix];
    return null;
  };
  const parser = new Parser({
    onclosetag: (name) => {
      scopes.pop();
      on.close?.(localName(name));
    },
    onopentag: (name, attributes) => {
      const declared = {};
      for (const [key, value] of Object.entries(attributes)) if (prefixOf(key) === 'xmlns') declared[localName(key)] = value;
      scopes.push(declared);
      const ids = Object.entries(attributes).filter(([key]) => prefixOf(key) && prefixOf(key) !== 'xmlns' && localName(key) === 'id');
      const relationshipId = (ids.find(([key]) => namespaceOf(prefixOf(key)) === RELATIONSHIPS_NS) ?? ids[0])?.[1];
      on.open?.(localName(name), { ...attributes, relationshipId });
    },
    ontext: (text) => on.text?.(text),
  }, { decodeEntities: true, xmlMode: true });
  parser.write(xml ?? '');
  parser.end();
}

const byNumber = (pattern) => (left, right) => Number(left.match(pattern)?.[1] ?? 0) - Number(right.match(pattern)?.[1] ?? 0);

// Each sheet under a "--- Sheet: Name ---" line, one row per line with its cells joined by " | ".
async function xlsxText() {
  const zip = await officeZip('Excel workbook');
  const shared = [];
  let current = null;
  let phonetic = 0;
  walkXml(await partText(zip, 'xl/sharedStrings.xml'), {
    close: (name) => {
      if (name === 'rPh') phonetic -= 1;
      if (name === 'si') { shared.push(current ?? ''); current = null; }
    },
    open: (name) => {
      if (name === 'si') current = '';
      if (name === 'rPh') phonetic += 1;
    },
    text: (text) => { if (current !== null && !phonetic) current += text; },
  });
  // Sheet names in workbook order, and the part each one is stored in.
  const relations = new Map();
  walkXml(await partText(zip, 'xl/_rels/workbook.xml.rels'), {
    open: (name, attributes) => { if (name === 'Relationship') relations.set(attributes.Id, String(attributes.Target ?? '').replace(/^\/?(xl\/)?/, 'xl/')); },
  });
  let sheets = [];
  walkXml(await partText(zip, 'xl/workbook.xml'), {
    open: (name, attributes) => { if (name === 'sheet') sheets.push({ name: attributes.name || `Sheet ${sheets.length + 1}`, part: relations.get(attributes.relationshipId) }); },
  });
  if (!sheets.length || sheets.some((sheet) => !sheet.part)) {
    sheets = Object.keys(zip.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).sort(byNumber(/sheet(\d+)\.xml$/))
      .map((part) => ({ name: `Sheet ${part.match(/sheet(\d+)\.xml$/)[1]}`, part }));
  }
  const out = [];
  let length = 0;
  for (const sheet of sheets) {
    if (length > maxChars) break;
    const rows = [];
    let row = null;
    let cell = null;
    walkXml(await partText(zip, sheet.part), {
      close: (name) => {
        if (name === 'c' && cell) {
          const value = cell.type === 's' ? shared[Number(cell.value)] ?? '' : cell.value;
          if (String(value).trim()) row.push(String(value).trim());
          cell = null;
        } else if (name === 'row' && row) {
          if (row.length) {
            rows.push(row.join(' | '));
            length += rows.at(-1).length + 1;
          }
          row = null;
        } else if (cell && (name === 'v' || name === 't')) cell.reading = false;
      },
      open: (name, attributes) => {
        if (name === 'row') row = [];
        else if (name === 'c' && row) cell = { reading: false, type: attributes.t ?? '', value: '' };
        else if (cell && (name === 'v' || name === 't')) cell.reading = true;
      },
      text: (text) => { if (cell?.reading) cell.value += text; },
    });
    if (rows.length) out.push(`--- Sheet: ${sheet.name} ---\n${rows.join('\n')}`);
  }
  const text = tidy(out.join('\n\n')).slice(0, maxChars);
  if (!text) throw refusal('no_text', 'This Excel workbook has no text or numbers in it, so there is nothing to read.');
  return length > maxChars ? `${text}\n\n[Odin read only the first ${maxChars.toLocaleString('en-US')} characters of this workbook.]` : text;
}

// The paragraphs of one slide or notes part, one per line.
function slideParagraphs(xml) {
  const lines = [];
  let current = null;
  walkXml(xml, {
    close: (name) => {
      if (name === 'p' && current !== null) {
        if (current.trim()) lines.push(current.trim());
        current = null;
      }
    },
    open: (name) => {
      if (name === 'p') current = '';
      else if (name === 'br' && current !== null) current += ' ';
    },
    text: (text) => { if (current !== null) current += text; },
  });
  return lines;
}

// Each slide under a "--- Slide n of N ---" line, its paragraphs one per line, then its speaker notes.
// A part's relationships ({ Id: { target, type } }), with each target resolved against the part's
// folder, as in `ppt/slides/_rels/slide1.xml.rels` for `ppt/slides/slide1.xml`.
async function relationshipsOf(zip, partName) {
  const folder = partName.slice(0, partName.lastIndexOf('/') + 1);
  const relations = {};
  walkXml(await partText(zip, `${folder}_rels/${partName.slice(folder.length)}.rels`), {
    open: (name, attributes) => {
      if (name !== 'Relationship' || attributes.TargetMode === 'External') return;
      const target = String(attributes.Target ?? '');
      const parts = (target.startsWith('/') ? target.slice(1) : `${folder}${target}`).split('/');
      const resolved = [];
      for (const part of parts) {
        if (part === '..') resolved.pop();
        else if (part && part !== '.') resolved.push(part);
      }
      relations[attributes.Id] = { target: resolved.join('/'), type: String(attributes.Type ?? '') };
    },
  });
  return relations;
}

// The slides in the deck's order (presentation.xml's slide list), or by file number when the deck
// has no usable list.
async function slideOrder(zip) {
  const relations = await relationshipsOf(zip, 'ppt/presentation.xml');
  const ordered = [];
  walkXml(await partText(zip, 'ppt/presentation.xml'), {
    open: (name, attributes) => {
      const target = name === 'sldId' ? relations[attributes.relationshipId]?.target : null;
      if (target && zip.file(target) && !ordered.includes(target)) ordered.push(target);
    },
  });
  if (ordered.length) return ordered;
  return Object.keys(zip.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).sort(byNumber(/slide(\d+)\.xml$/));
}

async function pptxText() {
  const zip = await officeZip('PowerPoint deck');
  const names = await slideOrder(zip);
  const out = [];
  let length = 0;
  let found = false;
  for (const [index, name] of names.entries()) {
    if (length > maxChars) break;
    const lines = slideParagraphs(await partText(zip, name));
    // The slide's own notes part, found through its relationships (numbers need not match), and
    // without the slide-number placeholder notes repeat.
    const notesPart = Object.values(await relationshipsOf(zip, name)).find((relation) => relation.type.endsWith('/notesSlide'))?.target;
    const notes = slideParagraphs(notesPart ? await partText(zip, notesPart) : null).filter((line) => !/^\d+$/.test(line));
    found ||= lines.length > 0 || notes.length > 0;
    const page = [`--- Slide ${index + 1} of ${names.length} ---`, ...lines, ...(notes.length ? ['Notes:', ...notes] : [])].join('\n');
    out.push(page);
    length += page.length + 2;
  }
  if (!found) throw refusal('no_text', 'This PowerPoint deck has no text in it (it may be only images), so there is nothing to read.');
  const text = tidy(out.join('\n\n')).slice(0, maxChars);
  return length > maxChars ? `${text}\n\n[Odin read only the first ${maxChars.toLocaleString('en-US')} characters of this deck.]` : text;
}

const EXTRACTORS = { docx: docxText, pdf: pdfText, pptx: pptxText, xlsx: xlsxText };

try {
  parentPort.postMessage({ ok: true, text: await EXTRACTORS[kind]() });
} catch (error) {
  parentPort.postMessage(error?.refusal
    ? { code: error.code, message: error.message, ok: false }
    : { code: 'corrupt', message: `This ${KIND_NAMES[kind] ?? 'file'} could not be read.`, ok: false });
}
