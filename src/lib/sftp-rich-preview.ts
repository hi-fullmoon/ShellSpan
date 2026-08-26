import { strFromU8, unzipSync } from 'fflate';

export interface TabularPreview {
  columns: string[];
  rows: string[][];
  omittedRows: boolean;
}

export interface ArchivePreviewEntry {
  name: string;
  size: number;
  compressedSize?: number;
  isDirectory: boolean;
}

export interface DocumentPreviewBlock {
  kind: 'heading' | 'paragraph';
  text: string;
}

export interface SpreadsheetPreviewSheet {
  name: string;
  columns: string[];
  rows: string[][];
  omittedRows: boolean;
}

export interface PresentationPreviewSlide {
  number: number;
  lines: string[];
}

export type OfficePreview =
  | { kind: 'document'; blocks: DocumentPreviewBlock[] }
  | { kind: 'spreadsheet'; sheets: SpreadsheetPreviewSheet[] }
  | { kind: 'presentation'; slides: PresentationPreviewSlide[] };

const MAX_TABLE_ROWS = 300;
const MAX_TABLE_COLUMNS = 64;
const MAX_OFFICE_PART_SIZE = 2 * 1024 * 1024;
const MAX_OFFICE_EXTRACTED_SIZE = 12 * 1024 * 1024;

export function decodePreviewBase64(content: string): Uint8Array {
  const decoded = atob(content);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function formatCellValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectsToTable(items: unknown[]): TabularPreview | undefined {
  if (items.length === 0) return { columns: ['Value'], rows: [], omittedRows: false };
  if (!items.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    return {
      columns: ['Value'],
      rows: items.slice(0, MAX_TABLE_ROWS).map((item) => [formatCellValue(item)]),
      omittedRows: items.length > MAX_TABLE_ROWS,
    };
  }

  const columnSet = new Set<string>();
  for (const item of items.slice(0, MAX_TABLE_ROWS) as Record<string, unknown>[]) {
    for (const key of Object.keys(item)) {
      if (columnSet.size >= MAX_TABLE_COLUMNS) break;
      columnSet.add(key);
    }
  }
  const columns = Array.from(columnSet);
  return {
    columns,
    rows: (items.slice(0, MAX_TABLE_ROWS) as Record<string, unknown>[]).map((item) =>
      columns.map((column) => formatCellValue(item[column])),
    ),
    omittedRows: items.length > MAX_TABLE_ROWS,
  };
}

export function parseJsonTable(content: string, extension: string): TabularPreview | undefined {
  try {
    if (extension === 'jsonl' || extension === 'ndjson') {
      const values = content
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
      return objectsToTable(values);
    }
    const value = JSON.parse(content) as unknown;
    if (Array.isArray(value)) return objectsToTable(value);
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      return {
        columns: ['Key', 'Value'],
        rows: entries.slice(0, MAX_TABLE_ROWS).map(([key, item]) => [key, formatCellValue(item)]),
        omittedRows: entries.length > MAX_TABLE_ROWS,
      };
    }
    return { columns: ['Value'], rows: [[formatCellValue(value)]], omittedRows: false };
  } catch {
    return undefined;
  }
}

export function parseDelimitedTable(content: string, delimiter: ',' | '\t'): TabularPreview {
  const parsed: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let omittedRows = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      if (row.length < MAX_TABLE_COLUMNS) row.push(cell);
      cell = '';
    } else if (character === '\n') {
      if (row.length < MAX_TABLE_COLUMNS) row.push(cell.replace(/\r$/, ''));
      if (parsed.length <= MAX_TABLE_ROWS) parsed.push(row);
      else omittedRows = true;
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    if (row.length < MAX_TABLE_COLUMNS) row.push(cell.replace(/\r$/, ''));
    if (parsed.length <= MAX_TABLE_ROWS) parsed.push(row);
    else omittedRows = true;
  }

  const [header = [], ...rows] = parsed;
  const width = Math.max(header.length, ...rows.map((item) => item.length), 1);
  const columns = Array.from({ length: width }, (_, index) => header[index] || `Column ${index + 1}`);
  return {
    columns,
    rows: rows.slice(0, MAX_TABLE_ROWS).map((item) => columns.map((_, index) => item[index] ?? '')),
    omittedRows: omittedRows || rows.length > MAX_TABLE_ROWS,
  };
}

function readZipEntries(bytes: Uint8Array): ArchivePreviewEntry[] | undefined {
  if (bytes.length < 22) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return undefined;

  const totalEntries = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: ArchivePreviewEntry[] = [];
  for (let index = 0; index < totalEntries && entries.length < 2_000; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) break;
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    entries.push({
      name,
      size,
      compressedSize,
      isDirectory: name.endsWith('/'),
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? field.subarray(0, end) : field).trim();
}

function readTarEntries(bytes: Uint8Array): ArchivePreviewEntry[] | undefined {
  const entries: ArchivePreviewEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length && entries.length < 2_000) {
    const name = readTarString(bytes, offset, 100);
    if (!name) break;
    const prefix = readTarString(bytes, offset + 345, 155);
    const size = Number.parseInt(readTarString(bytes, offset + 124, 12).replace(/\0/g, '').trim(), 8) || 0;
    const type = bytes[offset + 156];
    const fullName = prefix ? `${prefix}/${name}` : name;
    entries.push({
      name: fullName,
      size,
      isDirectory: type === 53 || fullName.endsWith('/'),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries.length > 0 ? entries : undefined;
}

export function parseArchiveEntries(content: string, extension: string): ArchivePreviewEntry[] | undefined {
  if (!content) return undefined;
  const bytes = decodePreviewBase64(content);
  if (extension === 'zip') return readZipEntries(bytes);
  if (extension === 'tar') return readTarEntries(bytes);
  return undefined;
}

function parseXml(content: Uint8Array): Document {
  const document = new DOMParser().parseFromString(strFromU8(content), 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) throw new Error('Invalid XML');
  return document;
}

function elementsByLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function extractDocument(files: Record<string, Uint8Array>): OfficePreview | undefined {
  const source = files['word/document.xml'];
  if (!source) return undefined;
  const document = parseXml(source);
  const blocks = elementsByLocalName(document, 'p')
    .map((paragraph): DocumentPreviewBlock | undefined => {
      const text = elementsByLocalName(paragraph, 't').map((node) => node.textContent ?? '').join('');
      if (!text.trim()) return undefined;
      const style = elementsByLocalName(paragraph, 'pStyle')[0]?.getAttribute('w:val')
        ?? elementsByLocalName(paragraph, 'pStyle')[0]?.getAttribute('val')
        ?? '';
      return { kind: /^heading|^title/i.test(style) ? 'heading' : 'paragraph', text };
    })
    .filter((block): block is DocumentPreviewBlock => Boolean(block));
  return blocks.length > 0 ? { kind: 'document', blocks } : undefined;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function extractSpreadsheet(files: Record<string, Uint8Array>): OfficePreview | undefined {
  const sharedStrings = files['xl/sharedStrings.xml']
    ? elementsByLocalName(parseXml(files['xl/sharedStrings.xml']), 'si').map((node) =>
        elementsByLocalName(node, 't').map((text) => text.textContent ?? '').join(''),
      )
    : [];
  const workbook = files['xl/workbook.xml'] ? parseXml(files['xl/workbook.xml']) : undefined;
  const sheetNames = workbook
    ? elementsByLocalName(workbook, 'sheet').map((sheet, index) => sheet.getAttribute('name') || `Sheet ${index + 1}`)
    : [];
  const sheetFiles = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));

  const sheets = sheetFiles.map((name, sheetIndex): SpreadsheetPreviewSheet => {
    const document = parseXml(files[name]);
    const sourceRows = elementsByLocalName(document, 'row');
    const rows = sourceRows.slice(0, MAX_TABLE_ROWS + 1).map((row) => {
      const values: string[] = [];
      for (const cell of elementsByLocalName(row, 'c')) {
        const index = Math.min(MAX_TABLE_COLUMNS - 1, columnIndex(cell.getAttribute('r') ?? 'A1'));
        const type = cell.getAttribute('t');
        const raw = elementsByLocalName(cell, 'v')[0]?.textContent ?? '';
        const inline = elementsByLocalName(cell, 't').map((node) => node.textContent ?? '').join('');
        values[index] = type === 's' ? (sharedStrings[Number(raw)] ?? raw) : (type === 'inlineStr' ? inline : raw);
      }
      return values;
    });
    const width = Math.max(...rows.map((row) => row.length), 1);
    return {
      name: sheetNames[sheetIndex] || `Sheet ${sheetIndex + 1}`,
      columns: Array.from({ length: width }, (_, index) => {
        let value = index + 1;
        let label = '';
        while (value > 0) {
          value -= 1;
          label = String.fromCharCode(65 + (value % 26)) + label;
          value = Math.floor(value / 26);
        }
        return label;
      }),
      rows: rows.slice(0, MAX_TABLE_ROWS).map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')),
      omittedRows: sourceRows.length > MAX_TABLE_ROWS,
    };
  });
  return sheets.length > 0 ? { kind: 'spreadsheet', sheets } : undefined;
}

function extractPresentation(files: Record<string, Uint8Array>): OfficePreview | undefined {
  const slideFiles = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  const slides = slideFiles.map((name, index): PresentationPreviewSlide => {
    const document = parseXml(files[name]);
    const lines = elementsByLocalName(document, 'p')
      .map((paragraph) => elementsByLocalName(paragraph, 't').map((node) => node.textContent ?? '').join(''))
      .filter((line) => line.trim());
    return { number: index + 1, lines };
  });
  return slides.length > 0 ? { kind: 'presentation', slides } : undefined;
}

export function parseOfficePreview(content: string, extension: string): OfficePreview | undefined {
  if (!content) return undefined;
  if (extension === 'doc') {
    const paragraphs = content
      .split(/\r?\n/)
      .map((text) => text.trimEnd())
      .filter((text) => text.trim());
    if (paragraphs.length === 0) return undefined;
    return {
      kind: 'document',
      blocks: paragraphs.map((text, index) => ({
        kind: index === 0 ? 'heading' : 'paragraph',
        text,
      })),
    };
  }
  let extractedSize = 0;
  let selectedParts = 0;
  const files = unzipSync(decodePreviewBase64(content), {
    filter(file) {
      const needed = extension === 'docx'
        ? file.name === 'word/document.xml'
        : extension === 'xlsx'
          ? file.name === 'xl/workbook.xml'
            || file.name === 'xl/sharedStrings.xml'
            || /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name)
          : /^ppt\/slides\/slide\d+\.xml$/.test(file.name);
      if (!needed || file.originalSize > MAX_OFFICE_PART_SIZE || selectedParts >= 64) return false;
      if (extractedSize + file.originalSize > MAX_OFFICE_EXTRACTED_SIZE) return false;
      extractedSize += file.originalSize;
      selectedParts += 1;
      return true;
    },
  });
  if (extension === 'docx') return extractDocument(files);
  if (extension === 'xlsx') return extractSpreadsheet(files);
  if (extension === 'pptx') return extractPresentation(files);
  return undefined;
}
