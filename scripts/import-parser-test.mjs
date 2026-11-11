import assert from "node:assert/strict";
import readXlsxFile from "read-excel-file/node";
import { createXlsx } from "../src/infrastructure/xlsx.ts";
import "../src/ui/import-parser.js";

const { csvRows, importRowsFromMatrix } = globalThis.stationImportParser;
const parsedCsv = csvRows('\uFEFF"recordDate","description","amount"\r\n"2026-10-01","fuel, ""premium""",12.50\r\n"2026-10-02","two lines\nsecond line",-3.25\r\n');
assert.deepEqual(parsedCsv, [
  { recordDate: "2026-10-01", description: 'fuel, "premium"', amount: "12.50" },
  { recordDate: "2026-10-02", description: "two lines\nsecond line", amount: "-3.25" },
]);

const matrix = [["businessDate", "productCode", "quantity", "reason"], [new Date("2026-10-03T00:00:00.000Z"), "0012", 50.25, "Opening dip"]];
const originalFirstRow = [...matrix[0]];
assert.deepEqual(importRowsFromMatrix(matrix), [{ businessDate: "2026-10-03", productCode: "0012", quantity: "50.25", reason: "Opening dip" }]);
assert.deepEqual(matrix[0], originalFirstRow, "matrix parsing must not mutate the caller's data");

const workbook = Buffer.from(createXlsx([
  ["recordDate", "description", "amount"],
  ["2026-10-04", "fuel, premium", "12.50"],
], new Set([2])));
const [firstSheet] = await readXlsxFile(workbook);
assert.deepEqual(importRowsFromMatrix(firstSheet.data), [{ recordDate: "2026-10-04", description: "fuel, premium", amount: "12.5" }]);

assert.throws(() => csvRows('date,description\n2026-10-01,"unfinished'), /unclosed quoted field/);
assert.throws(() => csvRows('date,description\n2026-10-01,un"closed'), /quote inside an unquoted field/);
assert.throws(() => csvRows('date,description\n2026-10-01,"closed"oops'), /unexpected text after a quoted field/);
assert.throws(() => importRowsFromMatrix([["date", "date"], ["2026-10-01", "2026-10-02"]]), /non-empty and unique/);
assert.throws(() => importRowsFromMatrix([["date"], ["2026-10-01", "extra"]]), /more cells than the header/);
console.log("PASS CSV quoting/BOM/newlines, XLSX first-sheet mapping, leading-zero codes, row validation, and non-mutating normalization");
