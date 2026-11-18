import assert from 'node:assert/strict';
import test from 'node:test';

import JSZip from 'jszip';

import { extractDocumentText } from '../src/modules/vault/vault-text.js';
import { documentKind, isReadableFile } from '../src/modules/vault/vault.service.js';

// Excel workbooks and PowerPoint decks read as text, as Word documents and PDFs do: built here
// with jszip, small and by hand.

async function workbook() {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; risks" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>Line item</t></si><si><t>Cost</t></si><si><r><t>Payroll </t></r><r><t>sync</t></r><rPh><t>ignored</t></rPh></si><si><t>Vendor may slip</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>4200</v></c></row><row r="3"></row></sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1" t="inlineStr"><is><t>High</t></is></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

const NOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SLIDE_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const slideXml = (...paragraphs) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

// A deck without a slide list: slides read by file number, and notes found through each slide's
// relationships.
async function deck() {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml('Kickoff', 'Goals for Q3'));
  zip.file('ppt/slides/slide2.xml', slideXml('Payroll cutoff moves to the 25th'));
  zip.file('ppt/slides/_rels/slide2.xml.rels', `<Relationships><Relationship Id="rId2" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide2.xml"/></Relationships>`);
  zip.file('ppt/slides/slide10.xml', slideXml('Questions'));
  zip.file('ppt/notesSlides/notesSlide2.xml', slideXml('Confirm with finance', '2'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

// A deck whose slide list orders slides unlike their file numbers, and whose notes parts are
// numbered unlike their slides, as decks edited over time are.
async function reorderedDeck() {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="rId3" Type="${SLIDE_TYPE}" Target="slides/slide2.xml"/><Relationship Id="rId9" Type="${SLIDE_TYPE}" Target="slides/slide7.xml"/></Relationships>`);
  zip.file('ppt/slides/slide7.xml', slideXml('Budget'));
  zip.file('ppt/slides/_rels/slide7.xml.rels', `<Relationships><Relationship Id="rId1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide1.xml"/></Relationships>`);
  zip.file('ppt/notesSlides/notesSlide1.xml', slideXml('Payroll cutoff is the 20th.'));
  zip.file('ppt/slides/slide2.xml', slideXml('Timeline'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Excel and PowerPoint files are documents Odin reads, by type or by name', () => {
  assert.equal(documentKind({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'x' }), 'xlsx');
  assert.equal(documentKind({ contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: 'x' }), 'pptx');
  assert.equal(documentKind({ contentType: 'application/octet-stream', fileName: 'Budget.XLSX' }), 'xlsx');
  assert.equal(documentKind({ contentType: '', fileName: 'deck.pptx' }), 'pptx');
  assert.equal(documentKind({ contentType: '', fileName: 'old.xls' }), null, 'old binary formats are not read');
  assert.equal(isReadableFile({ contentType: '', fileName: 'deck.pptx' }), true);
});

test('a workbook reads sheet by sheet, one row per line', { timeout: 60_000 }, async () => {
  const text = await extractDocumentText('xlsx', await workbook());
  assert.equal(text, '--- Sheet: Budget ---\nLine item | Cost\nPayroll sync | 4200\n\n--- Sheet: Notes & risks ---\nVendor may slip | High');
});

test('a deck reads slide by slide in order, with its speaker notes', { timeout: 60_000 }, async () => {
  const text = await extractDocumentText('pptx', await deck());
  assert.equal(text, [
    '--- Slide 1 of 3 ---\nKickoff\nGoals for Q3',
    '--- Slide 2 of 3 ---\nPayroll cutoff moves to the 25th\nNotes:\nConfirm with finance',
    '--- Slide 3 of 3 ---\nQuestions',
  ].join('\n\n'));
});

test('a deck reads in its own slide order, and each slide\u2019s notes follow its relationships, whatever the parts are numbered', { timeout: 60_000 }, async () => {
  const text = await extractDocumentText('pptx', await reorderedDeck());
  assert.equal(text, '--- Slide 1 of 2 ---\nBudget\nNotes:\nPayroll cutoff is the 20th.\n\n--- Slide 2 of 2 ---\nTimeline');
});

// The same deck written with other namespace prefixes, all valid: relationships, the slide list
// and the text paragraphs.
async function prefixedDeck() {
  const zip = new JSZip();
  const rels = (entries) => `<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</rel:Relationships>`;
  const slide = (...paragraphs) => `<pml:sld xmlns:pml="p" xmlns:d="a"><pml:cSld><pml:spTree><pml:sp><pml:txBody>${paragraphs.map((text) => `<d:p><d:r><d:t>${text}</d:t></d:r></d:p>`).join('')}</pml:txBody></pml:sp></pml:spTree></pml:cSld></pml:sld>`;
  zip.file('ppt/presentation.xml', '<pml:presentation xmlns:pml="p" xmlns:rr="r"><pml:sldIdLst><pml:sldId id="256" rr:id="rId9"/><pml:sldId id="257" rr:id="rId3"/></pml:sldIdLst></pml:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', rels(`<rel:Relationship Id="rId3" Type="${SLIDE_TYPE}" Target="slides/slide2.xml"/><rel:Relationship Id="rId9" Type="${SLIDE_TYPE}" Target="slides/slide7.xml"/>`));
  zip.file('ppt/slides/slide7.xml', slide('Budget'));
  zip.file('ppt/slides/_rels/slide7.xml.rels', rels(`<rel:Relationship Id="rId1" Type="${NOTES_TYPE}" Target="../notesSlides/notesSlide7.xml"/>`));
  zip.file('ppt/notesSlides/notesSlide7.xml', slide('Payroll cutoff is the 20th.'));
  zip.file('ppt/slides/slide2.xml', slide('Timeline'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('a deck written with other namespace prefixes reads the same', { timeout: 60_000 }, async () => {
  const text = await extractDocumentText('pptx', await prefixedDeck());
  assert.equal(text, '--- Slide 1 of 2 ---\nBudget\nNotes:\nPayroll cutoff is the 20th.\n\n--- Slide 2 of 2 ---\nTimeline');
});

test('a namespace declared as id on a slide or sheet is not taken for its relationship id', { timeout: 60_000 }, async () => {
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="p" xmlns:r="${relationships}"><p:sldIdLst><p:sldId id="256" xmlns:id="urn:other" r:id="rId9"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="rId3" Type="${SLIDE_TYPE}" Target="slides/slide2.xml"/><Relationship Id="rId9" Type="${SLIDE_TYPE}" Target="slides/slide7.xml"/></Relationships>`);
  zip.file('ppt/slides/slide7.xml', slideXml('Budget'));
  zip.file('ppt/slides/slide2.xml', slideXml('Timeline'));
  assert.equal(await extractDocumentText('pptx', await zip.generateAsync({ type: 'nodebuffer' })), '--- Slide 1 of 2 ---\nBudget\n\n--- Slide 2 of 2 ---\nTimeline');

  const book = new JSZip();
  book.file('xl/workbook.xml', `<workbook xmlns:r="${relationships}"><sheets><sheet name="Second" sheetId="2" xmlns:id="urn:other" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  book.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
  book.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="inlineStr"><is><t>one</t></is></c></row></sheetData></worksheet>');
  book.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row><c t="inlineStr"><is><t>two</t></is></c></row></sheetData></worksheet>');
  assert.equal(await extractDocumentText('xlsx', await book.generateAsync({ type: 'nodebuffer' })), '--- Sheet: Second ---\ntwo\n\n--- Sheet: First ---\none');
});

test('a damaged or empty Office file is refused with a reason', { timeout: 60_000 }, async () => {
  await assert.rejects(extractDocumentText('xlsx', Buffer.from('not a zip')), (error) => error.statusCode === 422 && error.details.code === 'corrupt');
  const empty = await new JSZip().generateAsync({ type: 'nodebuffer' });
  await assert.rejects(extractDocumentText('pptx', empty), (error) => error.statusCode === 422 && error.details.code === 'no_text');
});
