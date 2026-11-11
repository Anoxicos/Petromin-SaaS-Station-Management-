import { strToU8, zipSync } from "fflate";

function xml(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export type XlsxSheet = {
  name: string;
  rows: readonly (readonly unknown[])[];
  numericColumns?: ReadonlySet<number>;
};

export function createXlsxWorkbook(sheets: readonly XlsxSheet[]): Uint8Array {
  if (!sheets.length) throw new Error("An Excel workbook needs at least one worksheet.");
  const names = new Set<string>();
  const prepared = sheets.map((sheet, index) => {
    const name = sheet.name.replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31) || `Sheet${index + 1}`;
    if (names.has(name.toLowerCase())) throw new Error("Worksheet names must be unique.");
    names.add(name.toLowerCase());
    const sheetRows = sheet.rows.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        const address = `${columnName(columnIndex)}${rowIndex + 1}`;
        if (value == null || value === "") return "";
        if (rowIndex > 0 && sheet.numericColumns?.has(columnIndex)) {
          const text = String(value);
          if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return `<c r="${address}"><v>${text}</v></c>`;
        }
        return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    return { name, xml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` };
  });
  const contentOverrides = prepared.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = prepared.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const relationships = prepared.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentOverrides}</Types>`),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`),
  };
  prepared.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${sheet.xml}`);
  });
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
}

export function createXlsx(rows: readonly (readonly unknown[])[], numericColumns: ReadonlySet<number> = new Set()): Uint8Array {
  return createXlsxWorkbook([{ name: "Report", rows, numericColumns }]);
}
