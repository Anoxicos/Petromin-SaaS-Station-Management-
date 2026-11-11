(function (root) {
  function cellText(value) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();
  }

  function importRowsFromMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 2 || !Array.isArray(matrix[0])) {
      throw new Error("The first worksheet needs a header and at least one data row.");
    }
    if (matrix.slice(1).some(values => !Array.isArray(values))) throw new Error("Each worksheet row must contain cells.");
    const headers = matrix[0].map(cellText);
    if (new Set(headers).size !== headers.length || headers.some(value => !value)) {
      throw new Error("Headers must be non-empty and unique.");
    }
    return matrix.slice(1).filter(values => Array.isArray(values) && values.some(value => cellText(value))).map((values, index) => {
      if (values.length > headers.length && values.slice(headers.length).some(value => cellText(value))) {
        throw new Error(`Row ${index + 2} has more cells than the header.`);
      }
      const normalized = headers.map((_, column) => cellText(values[column]));
      return Object.fromEntries(headers.map((header, column) => [header, normalized[column]]));
    });
  }

  function csvRows(text) {
    const source = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false, quoteClosed = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { quoted = false; quoteClosed = true; }
        else field += ch;
      } else if (quoteClosed && ch === ",") {
        row.push(field); field = ""; quoteClosed = false;
      } else if (quoteClosed && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        row.push(field); if (row.some(value => value.trim())) rows.push(row);
        row = []; field = ""; quoteClosed = false;
      } else if (quoteClosed && /\s/.test(ch)) {
        // Ignore legal formatting whitespace between a closing quote and delimiter.
      } else if (quoteClosed) {
        throw new Error("CSV has unexpected text after a quoted field.");
      } else if (ch === '"' && field === "") {
        quoted = true;
      } else if (ch === '"') {
        throw new Error("CSV has a quote inside an unquoted field.");
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        row.push(field); if (row.some(value => value.trim())) rows.push(row);
        row = []; field = "";
      } else {
        field += ch;
      }
    }
    if (quoted) throw new Error("CSV has an unclosed quoted field.");
    row.push(field); if (row.some(value => value.trim())) rows.push(row);
    return importRowsFromMatrix(rows);
  }

  root.stationImportParser = { importRowsFromMatrix, csvRows };
})(globalThis);
