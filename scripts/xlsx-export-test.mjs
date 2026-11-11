import assert from "node:assert/strict";
import readXlsxFile from "read-excel-file/node";
import { createXlsx, createXlsxWorkbook } from "../src/infrastructure/xlsx.ts";

const rows = [
  ["recordType", "reference", "amount", "details"],
  ["PAYMENT", "00123", "12345678901234.56", { note: "=2+2 & <literal>" }],
];
const workbook = Buffer.from(createXlsx(rows, new Set([2])));
assert.equal(workbook.subarray(0, 2).toString("ascii"), "PK", "XLSX should be a ZIP-based workbook");
const [sheet] = await readXlsxFile(workbook);
assert.deepEqual(sheet.data, [
  ["recordType", "reference", "amount", "details"],
  ["PAYMENT", "00123", 12345678901234.56, '{"note":"=2+2 & <literal>"}'],
]);
const reportWorkbook = Buffer.from(createXlsxWorkbook([
  { name: "Station overview", rows: [["stationCode"], ["S001"]] },
  { name: "Sales by currency", rows: [["currencyCode", "sales"], ["MAD", "42.50"]], numericColumns: new Set([1]) },
]));
const reportSheets = await readXlsxFile(reportWorkbook);
assert.deepEqual(reportSheets.map(item => item.sheet), ["Station overview", "Sales by currency"]);
assert.deepEqual(reportSheets[1].data, [["currencyCode", "sales"], ["MAD", 42.5]]);
console.log("PASS single- and multi-sheet XLSX structure, numeric cells, leading-zero identifiers, JSON details, and literal formula-like text");
