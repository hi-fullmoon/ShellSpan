import { unzipSync } from 'fflate';
import { DOCUMENT_LIMITS, validateDocumentText } from './document-import';

export async function extractOffice(bytes: ArrayBuffer, extension: string): Promise<string> {
  // Inspect archive metadata without inflating entries before passing it to the parser.
  let expanded = 0;
  let entries = 0;
  unzipSync(new Uint8Array(bytes), { filter: file => {
    expanded += file.originalSize;
    if (++entries > 2048 || expanded > DOCUMENT_LIMITS.maxExpandedBytes) throw new Error('DOCUMENT_SIZE_LIMIT');
    return false;
  } });
  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    if (result.messages.some(message => message.type === 'error')) throw new Error('DOCUMENT_INVALID');
    return validateDocumentText(result.value);
  }
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const lines: string[] = [];
  let length = 0;
  let cells = 0;
  const append = (value: string) => {
    length += value.length + 1;
    if (length > DOCUMENT_LIMITS.maxCharacters) throw new Error('DOCUMENT_TEXT_LIMIT');
    lines.push(value);
  };
  let nonempty = false;
  for (const sheet of workbook.worksheets) {
    append(`[${sheet.name}]`);
    sheet.eachRow(row => {
      const values: string[] = [];
      row.eachCell(cell => {
        if (++cells > 50000) throw new Error('DOCUMENT_TEXT_LIMIT');
        // Keep actual cell addresses, cached formula results and rich text. Never execute formulas.
        const value = cell.value;
        const text = value && typeof value === 'object' && 'formula' in value
          ? `${value.formula}${value.result === undefined ? '' : ` = ${String(value.result)}`}`
          : cell.text;
        if (text.trim()) { nonempty = true; values.push(`${cell.address}: ${JSON.stringify(text)}`); }
      });
      if (values.length) append(values.join('\t'));
    });
  }
  if (!nonempty) throw new Error('DOCUMENT_EMPTY');
  return validateDocumentText(lines.join('\n'));
}
