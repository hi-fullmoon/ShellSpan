import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  parseArchiveEntries,
  parseDelimitedTable,
  parseJsonTable,
  parseOfficePreview,
} from '@/lib/sftp/sftp-rich-preview';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('SFTP rich preview parsers', () => {
  it('parses quoted CSV cells into a tabular preview', () => {
    const result = parseDelimitedTable('name,note\nAda,"hello, world"\nLin,"two\nlines"', ',');

    expect(result.columns).toEqual(['name', 'note']);
    expect(result.rows).toEqual([
      ['Ada', 'hello, world'],
      ['Lin', 'two\nlines'],
    ]);
  });

  it('turns arrays of JSON objects into columns', () => {
    const result = parseJsonTable('[{"name":"api","healthy":true},{"name":"db","latency":12}]', 'json');

    expect(result?.columns).toEqual(['name', 'healthy', 'latency']);
    expect(result?.rows).toEqual([
      ['api', 'true', ''],
      ['db', '', '12'],
    ]);
  });

  it('lists ZIP entries without extracting their contents', () => {
    const archive = zipSync({
      'notes.txt': strToU8('hello'),
      'assets/icon.svg': strToU8('<svg/>'),
    });

    expect(parseArchiveEntries(toBase64(archive), 'zip')).toEqual([
      expect.objectContaining({ name: 'notes.txt', size: 5, isDirectory: false }),
      expect.objectContaining({ name: 'assets/icon.svg', size: 6, isDirectory: false }),
    ]);
  });

  it('extracts readable paragraphs from DOCX packages', () => {
    const documentXml = `<?xml version="1.0"?>
      <w:document xmlns:w="urn:w"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Status</w:t></w:r></w:p>
        <w:p><w:r><w:t>All systems operational.</w:t></w:r></w:p>
      </w:body></w:document>`;
    const archive = zipSync({ 'word/document.xml': strToU8(documentXml) });

    expect(parseOfficePreview(toBase64(archive), 'docx')).toEqual({
      kind: 'document',
      blocks: [
        { kind: 'heading', text: 'Status' },
        { kind: 'paragraph', text: 'All systems operational.' },
      ],
    });
  });

  it('turns extracted legacy DOC text into document blocks', () => {
    expect(parseOfficePreview('Overtime request\nName\tAda\nApproved', 'doc')).toEqual({
      kind: 'document',
      blocks: [
        { kind: 'heading', text: 'Overtime request' },
        { kind: 'paragraph', text: 'Name\tAda' },
        { kind: 'paragraph', text: 'Approved' },
      ],
    });
  });

  it('extracts cells and sheet names from XLSX packages', () => {
    const workbookXml = '<workbook xmlns="urn:x"><sheets><sheet name="Servers"/></sheets></workbook>';
    const sharedXml = '<sst xmlns="urn:x"><si><t>host</t></si><si><t>web-01</t></si></sst>';
    const sheetXml = '<worksheet xmlns="urn:x"><sheetData><row><c r="A1" t="s"><v>0</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>22</v></c></row></sheetData></worksheet>';
    const archive = zipSync({
      'xl/workbook.xml': strToU8(workbookXml),
      'xl/sharedStrings.xml': strToU8(sharedXml),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    });

    expect(parseOfficePreview(toBase64(archive), 'xlsx')).toEqual({
      kind: 'spreadsheet',
      sheets: [{
        name: 'Servers',
        columns: ['A', 'B'],
        rows: [['host', ''], ['web-01', '22']],
        omittedRows: false,
      }],
    });
  });

  it('extracts text in slide order from PPTX packages', () => {
    const slide = (title: string) => `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:sp></p:sld>`;
    const archive = zipSync({
      'ppt/slides/slide2.xml': strToU8(slide('Second')),
      'ppt/slides/slide1.xml': strToU8(slide('First')),
    });

    expect(parseOfficePreview(toBase64(archive), 'pptx')).toEqual({
      kind: 'presentation',
      slides: [
        { number: 1, lines: ['First'] },
        { number: 2, lines: ['Second'] },
      ],
    });
  });

  it('aborts office archives whose actual decompressed size exceeds the part limit even with a forged header', () => {
    // 2.2 MB of repeated text compresses to a few kilobytes in DEFLATE.
    const hugeBody = 'A'.repeat(2_200_000);
    const documentXml = `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${hugeBody}</w:t></w:r></w:p></w:body></w:document>`;
    const archive = zipSync({ 'word/document.xml': strToU8(documentXml) }, { level: 9 });
    // Forge the uncompressed-size field in both local file header (offset 22)
    // and central directory header (signature 0x02014b50, offset +24) to 16 bytes.
    const forged = archive.slice();
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    view.setUint32(22, 16, true);
    for (let i = 0; i <= forged.length - 46; i += 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 16, true);
      }
    }

    expect(() => parseOfficePreview(toBase64(forged), 'docx')).toThrow(/exceeded safe extraction limit/i);
  });

  it('preserves implicit XLSX columns and skips columns past the 64-column cap instead of overwriting column 64', () => {
    const workbookXml = '<workbook xmlns="urn:x"><sheets><sheet name="Wide"/></sheets></workbook>';
    const sheetXml = '<worksheet xmlns="urn:x"><sheetData><row>'
      + '<c><v>first</v></c><c r="123"><v>second</v></c>'
      + '<c r="BL1"><v>col-64</v></c><c r="BM1"><v>col-65-ignored</v></c>'
      + '</row></sheetData></worksheet>';
    const archive = zipSync({
      'xl/workbook.xml': strToU8(workbookXml),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    });

    const parsed = parseOfficePreview(toBase64(archive), 'xlsx');
    expect(parsed?.kind).toBe('spreadsheet');
    if (parsed?.kind === 'spreadsheet') {
      const row = parsed.sheets[0]!.rows[0]!;
      expect(row[0]).toBe('first');
      expect(row[1]).toBe('second');
      expect(row[63]).toBe('col-64');
      expect(row).toHaveLength(64);
    }
  });
});
