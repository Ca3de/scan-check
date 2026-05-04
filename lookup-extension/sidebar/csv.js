// Minimal RFC4180-ish CSV parser/serializer. Handles quoted fields, escaped
// quotes, embedded commas/newlines. No external dependencies.

(function (global) {
  'use strict';

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;

    // Strip BOM.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    while (i < text.length) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\r') {
        // Treat CR or CRLF as one line end.
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        if (text[i] === '\n') i++;
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      field += ch;
      i++;
    }

    // Flush trailing field.
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    // Drop trailing empty rows.
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
      rows.pop();
    }

    return rows;
  }

  function serializeCSV(rows) {
    return rows.map(r => r.map(serializeField).join(',')).join('\r\n');
  }

  function serializeField(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  global.CSVUtil = { parseCSV, serializeCSV };
})(window);
