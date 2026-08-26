// Writes a 2-tab .xlsx migration report (no external library — an XLSX is a zip of XML).
//  Tab 1 "Summary": grouped counts by outcome/reason.
//  Tab 2 "All Discounts": every code with status + reason (filter the reason column).
import fs from 'node:fs';
import zlib from 'node:zlib';

// Map one report row -> { result, category, reason }
// NOTE: r.status holds the INTENDED status (published/draft) even for rows that failed to create,
// so we key off migrated_ok/notes first to decide the real outcome.
function classifyRow(r) {
  const ok = (r.migrated_ok || '');
  const s = (r.status || '').toLowerCase();
  const n = (r.notes || '').toLowerCase();

  // Duplicate code — the code already exists in OS (same code appears twice in Shopify: a real
  // coded discount + a codeless twin; or a re-run). The code IS live via the other one.
  if (n.includes('already exists') || ok.includes('already in OS')) {
    return { result: 'Duplicate', category: 'Duplicate code — already in OS (via its twin)', reason: 'Code already exists in OS' };
  }
  // Sets deferred by --skip-sets (multi-code / gift-card sets).
  if (n.includes('deferred') || n.includes('discount set')) {
    return { result: 'Skipped', category: 'Skipped — multi-code set (deferred by --skip-sets)', reason: r.notes || 'Multi-code set deferred' };
  }
  // Actually created in OS this run (or previously migrated in a resumed run).
  if (ok.startsWith('YES') || n.includes('already in ledger')) {
    if (s === 'draft') {
      if (n.includes('no customer selected')) return { result: 'Draft', category: 'Draft — no customer selected in Shopify', reason: 'Customer-specific but no customer selected in Shopify' };
      if (n.includes('no phone')) return { result: 'Draft', category: 'Draft — customer has no phone', reason: 'Customer-specific: customer has no phone in Shopify' };
      if (n.includes('exhausted') || n.includes('used up')) return { result: 'Draft', category: 'Draft — already used up in Shopify', reason: r.notes || 'Already used up in Shopify' };
      if (n.includes('collection')) return { result: 'Draft', category: 'Draft — collection not in OS', reason: 'Collection not present in OS catalog' };
      if (n.includes('codeless')) return { result: 'Draft', category: 'Draft — codeless (no code in Shopify)', reason: 'No code in Shopify (title used as code)' };
      return { result: 'Draft', category: 'Draft — other', reason: r.notes || 'Draft' };
    }
    return { result: 'Published', category: 'Migrated successfully (published)', reason: 'Created with all correct values' };
  }
  // Not migrated
  if (n.includes('could not map') || n.includes('unsupported')) return { result: 'Not migrated', category: 'Not migrated — unsupported discount type', reason: r.notes || 'Unsupported discount type' };
  if (n.includes('free shipping')) return { result: 'Not migrated', category: 'Not migrated — free shipping not supported', reason: 'Free shipping not supported' };
  return { result: 'Failed', category: 'Failed (error during create)', reason: r.notes || 'Failed' };
}

export function writeXlsxReport(reportRows, outPath) {
  // ---- Tab 2 rows + per-row classification ----
  const detailCols = ['code', 'title', 'customer', 'used', 'limit', 'collection', 'result', 'reason'];
  const tab2 = [detailCols];
  const counts = {};
  for (const r of reportRows) {
    const c = classifyRow(r);
    counts[c.category] = (counts[c.category] || 0) + 1;
    tab2.push([r.code, r.title, r.customer, r.used, r.limit, r.collection, c.result, c.reason]);
  }
  // ---- Tab 1 summary (sorted, most common first) ----
  const tab1 = [['Category', 'Count']];
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) tab1.push([k, v]);
  tab1.push(['TOTAL', reportRows.length]);

  writeWorkbook(outPath, [{ name: 'Summary', rows: tab1 }, { name: 'All Discounts', rows: tab2 }]);
  return { total: reportRows.length, counts };
}

// ---------- minimal XLSX (zip of XML) ----------
function writeWorkbook(outPath, sheets) {
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const sheetXml = (rows) => {
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach((row, r) => {
      x += `<row r="${r + 1}">`;
      row.forEach((cell, c) => {
        const ref = colLetter(c) + (r + 1);
        if (cell === '' || cell == null) { x += `<c r="${ref}"/>`; return; }
        if (typeof cell === 'number' || (/^-?\d+$/.test(String(cell)) && String(cell).length < 15)) x += `<c r="${ref}"><v>${cell}</v></c>`;
        else x += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell)}</t></is></c>`;
      });
      x += '</row>';
    });
    return x + '</sheetData></worksheet>';
  };
  const sheetEntries = sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const relEntries = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const ctOverrides = sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${ctOverrides}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries}</Relationships>`,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });

  // ---- zip (deflate) with CRC32 ----
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const local = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central); const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  fs.writeFileSync(outPath, Buffer.concat([localBuf, centralBuf, eocd]));
}
