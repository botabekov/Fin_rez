(function () {
  'use strict';

  const borderEdge = { style: 'thin', color: { argb: 'FFABB5BF' } };
  const border = { top: borderEdge, bottom: borderEdge, left: borderEdge, right: borderEdge };
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD8EBF1' } };

  function hasValue(value) {
    return value != null && String(value).trim() !== '';
  }

  function tableColumns(header, rows, omitEmptyColumn = -1) {
    const lastColumn = rows.reduce((width, row) => Math.max(width, row.length), header.length);
    const columns = [];
    for (let index = 0; index < lastColumn; index++) {
      const label = String(header[index] ?? '').replace(/_x000d_/gi, '');
      if ((!hasValue(label) || index === omitEmptyColumn) && !rows.some(row => hasValue(row[index]))) continue;
      const normalized = label.trim().toLowerCase();
      const description = /^(наименование|инструмент|направление|перевод|адрес|тип)/.test(normalized);
      const numeric = /^(количество|кол-во|сумма|объем|объём|коэффициент|комиссии|себестоимость|прибыль|остаток|балансовая стоимость|средняя цена|цена)/.test(normalized);
      let width = 12;
      if (normalized.startsWith('наименование')) width = 32;
      else if (description) width = 19;
      else if (normalized.startsWith('isin')) width = 17;
      else if (normalized === '№') width = 5;
      else if (numeric) width = 15;

      if (!description) {
        for (const row of rows) width = Math.max(width, String(row[index] ?? '').length + 3);
      }
      columns.push({ index, label, description, numeric, width });
    }
    return columns;
  }

  function wrappedLines(text, width) {
    const limit = Math.max(3, Math.floor(width * 0.95) - 1);
    let lines = 0;
    for (const paragraph of text.split(/\r?\n/)) {
      let used = 0;
      lines++;
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (used && used + word.length + 1 > limit) {
          lines++;
          used = 0;
        }
        if (word.length > limit) lines += Math.ceil(word.length / limit) - 1;
        used = (used ? used + 1 : 0) + ((word.length - 1) % limit) + 1;
      }
    }
    return lines;
  }

  function writeTableRow(sheet, rowNumber, columns, source, heading = false) {
    const row = sheet.getRow(rowNumber);
    let lineCount = 1;
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      const value = heading ? column.label : source[column.index];
      if (hasValue(value)) cell.value = value;
      const wrapText = heading || column.description;
      cell.font = { name: 'Calibri', size: 10, bold: heading, color: { argb: 'FF152434' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: heading ? 'center' : column.numeric ? 'right' : column.description ? 'left' : 'center',
        wrapText
      };
      cell.border = border;
      if (heading) cell.fill = headerFill;
      if (typeof value === 'number' && Number.isFinite(value) && column.numeric) {
        cell.numFmt = Number.isInteger(value) ? '0' : '0.###############';
      }
      if (wrapText) lineCount = Math.max(lineCount, wrappedLines(String(value ?? ''), column.width));
    });
    row.height = Math.min(409, Math.max(heading ? 30 : 16, 14 * lineCount + 4));
  }

  function writeNote(sheet, rowNumber, endColumn, text) {
    if (endColumn > 1) sheet.mergeCells(rowNumber, 1, rowNumber, endColumn);
    const cell = sheet.getCell(rowNumber, 1);
    cell.value = text;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF152434' } };
    sheet.getRow(rowNumber).height = 19;
  }

  function writeProfitTotals(sheet, startRow, profitColumn, rows, movementColumns) {
    if (profitColumn < 2) return startRow;
    const totals = new Map();
    for (const row of rows) {
      const currency = String(row[movementColumns.currency] ?? '').trim().toUpperCase();
      const amount = row[movementColumns.profit];
      if (!currency || !hasValue(amount)) continue;
      const cents = Math.round(Number(String(amount).replace(/\s/g, '').replace(',', '.')) * 100);
      if (Number.isFinite(cents)) totals.set(currency, (totals.get(currency) || 0) + cents);
    }
    let rowNumber = startRow;
    for (const [currency, cents] of totals) {
      if (profitColumn > 2) sheet.mergeCells(rowNumber, 1, rowNumber, profitColumn - 1);
      const label = sheet.getCell(rowNumber, 1);
      label.value = 'Итого · ' + currency;
      label.alignment = { horizontal: 'right', vertical: 'middle' };
      const amount = sheet.getCell(rowNumber, profitColumn);
      amount.value = cents / 100;
      amount.numFmt = '#,##0.00';
      amount.alignment = { horizontal: 'right', vertical: 'middle' };
      amount.font = label.font = { name: 'Calibri', size: 10, bold: true };
      if (cents !== 0) {
        amount.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cents < 0 ? 'FFFDE9DA' : 'FFE7F0D9' } };
        amount.font = { ...amount.font, color: { argb: cents < 0 ? 'FF922626' : 'FF205B34' } };
      }
      sheet.getRow(rowNumber++).height = 17;
    }
    return rowNumber;
  }

  function writeMovement(book, rows, options) {
    const [header, ...body] = rows;
    const ids = options.movementColumns;
    const columns = tableColumns(header, body, ids.profitKzt);
    const sheet = book.addWorksheet('Движение', { views: [{ zoomScale: 75 }] });
    sheet.columns = columns.map(({ width }) => ({ width }));
    writeNote(sheet, 1, columns.length, 'Фин рез: ' + options.periodLabel);
    if (options.asOf) writeNote(sheet, 2, columns.length, 'По состоянию на: ' + options.asOf);
    const groups = new Map();
    for (const row of body) {
      const isin = String(row[ids.isin] ?? '').trim().toUpperCase();
      const name = row[ids.name];
      const key = JSON.stringify([isin, isin ? options.tickerFromName(name) : name]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const profitColumn = columns.findIndex(column => column.index === ids.profit) + 1;
    let nextRow = 4;
    for (const group of groups.values()) {
      writeTableRow(sheet, nextRow++, columns, null, true);
      for (const row of group) writeTableRow(sheet, nextRow++, columns, row);
      nextRow = writeProfitTotals(sheet, nextRow, profitColumn, group, ids) + 1;
    }
  }

  function writeTable(book, name, rows, asOf) {
    const [header, ...body] = rows;
    const columns = tableColumns(header, body);
    const sheet = book.addWorksheet(name);
    sheet.columns = columns.map(({ width }) => ({ width }));
    const headerRow = asOf ? 2 : 1;
    if (asOf) writeNote(sheet, 1, columns.length, 'По состоянию на: ' + asOf);
    writeTableRow(sheet, headerRow, columns, null, true);
    body.forEach((row, index) => writeTableRow(sheet, headerRow + 1 + index, columns, row));
  }

  function buildWorkbook(Workbook, options) {
    const book = new Workbook();
    if (options.movement) writeMovement(book, options.movement, options);
    if (options.dividends) writeTable(book, 'Дивиденды', options.dividends);
    if (options.repo) writeTable(book, 'РЕПО', options.repo);
    if (options.balances) writeTable(book, 'Остатки ЦБ', options.balances, options.balanceDate);
    return book;
  }

  let library;
  function loadLibrary() {
    if (!library) {
      library = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
        script.onload = () => window.ExcelJS?.Workbook ? resolve(window.ExcelJS) : reject(new Error('ExcelJS is unavailable'));
        script.onerror = () => reject(new Error('ExcelJS failed to load'));
        document.head.appendChild(script);
      }).catch(error => {
        library = null;
        throw error;
      });
    }
    return library;
  }

  window.downloadFormattedFinRez = async function (options, fileName) {
    const ExcelJS = await loadLibrary();
    const bytes = await buildWorkbook(ExcelJS.Workbook, options).xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();
