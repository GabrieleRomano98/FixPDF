/* global PDFLib */
/**
 * fix_pdf_highlights.js
 *
 * Client-side port of fix_pdf_highlights_v2.py.
 *
 * Root cause: some PDF exporters (e.g. Google Docs/Slides) draw highlighter
 * rectangles that invoke an ExtGState resource via the `/Name gs` operator,
 * intending it to use Multiply blend mode (so highlight color doesn't hide
 * text). But the ExtGState object is sometimes never actually defined in
 * the page's /Resources /ExtGState dictionary, so viewers fall back to
 * fully opaque rendering -> solid highlight bands covering the text.
 *
 * Fix: for every page, find `/Name gs` references in the content stream
 * that aren't defined in that page's ExtGState resources, and add a
 * reasonable definition:
 *   - If the name encodes an explicit alpha (e.g. "pgf@ca0.30"), use it.
 *   - Otherwise, default to { ca: 1, CA: 1, BM: /Multiply }.
 *
 * This only edits /Resources /ExtGState dictionaries; it never touches or
 * removes content stream operators, so text remains selectable.
 */

const { PDFDocument, PDFName, PDFDict, PDFNumber, PDFRawStream, PDFArray, decodePDFRawStream } = PDFLib;

const GS_REF_RE = /\/([A-Za-z0-9@#._]+)\s+gs\b/g;
const ALPHA_IN_NAME_RE = /ca([0-9]*\.?[0-9]+)/i;

function getContentBytes(pdfDoc, page) {
  const contentsRef = page.node.get(PDFName.of('Contents'));
  const resolved = pdfDoc.context.lookup(contentsRef);

  const decode = (stream) => {
    if (stream instanceof PDFRawStream) {
      return decodePDFRawStream(stream).decode();
    }
    return new Uint8Array();
  };

  if (resolved instanceof PDFArray) {
    const parts = [];
    for (let i = 0; i < resolved.size(); i++) {
      const streamRef = resolved.get(i);
      const stream = pdfDoc.context.lookup(streamRef);
      parts.push(decode(stream));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  return decode(resolved);
}

function findReferencedGsNames(contentBytes) {
  const text = new TextDecoder('latin1').decode(contentBytes);
  const names = new Set();
  let match;
  GS_REF_RE.lastIndex = 0;
  while ((match = GS_REF_RE.exec(text)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function makeExtGStateForName(pdfDoc, name) {
  const m = ALPHA_IN_NAME_RE.exec(name);
  if (m) {
    const alpha = parseFloat(m[1]);
    // crude heuristic matching the python script: uppercase CA vs lowercase ca
    const isStrokeAlpha = name.includes('CA') && !name.includes('ca');
    const dict = PDFDict.withContext(pdfDoc.context);
    dict.set(PDFName.of('Type'), PDFName.of('ExtGState'));
    dict.set(PDFName.of(isStrokeAlpha ? 'CA' : 'ca'), PDFNumber.of(alpha));
    return dict;
  }

  const dict = PDFDict.withContext(pdfDoc.context);
  dict.set(PDFName.of('Type'), PDFName.of('ExtGState'));
  dict.set(PDFName.of('ca'), PDFNumber.of(1));
  dict.set(PDFName.of('CA'), PDFNumber.of(1));
  dict.set(PDFName.of('BM'), PDFName.of('Multiply'));
  return dict;
}

function fixPage(pdfDoc, page, seenExtGStateDicts) {
  let contentBytes;
  try {
    contentBytes = getContentBytes(pdfDoc, page);
  } catch (e) {
    return 0;
  }
  if (!contentBytes || contentBytes.length === 0) return 0;

  const referenced = findReferencedGsNames(contentBytes);
  if (referenced.length === 0) return 0;

  const resources = page.node.Resources();
  if (!resources) return 0;

  let extGState = resources.lookup(PDFName.of('ExtGState'), PDFDict);
  if (!extGState) {
    extGState = PDFDict.withContext(pdfDoc.context);
    resources.set(PDFName.of('ExtGState'), extGState);
  }

  // Avoid re-processing the exact same shared ExtGState dict twice (pages
  // in this kind of PDF commonly share one ExtGState object).
  if (seenExtGStateDicts.has(extGState)) {
    // Still need to know if new names are missing from it.
  }

  let added = 0;
  for (const name of referenced) {
    const key = PDFName.of(name);
    if (extGState.get(key)) continue;
    const gsDict = makeExtGStateForName(pdfDoc, name);
    extGState.set(key, pdfDoc.context.register(gsDict));
    added++;
  }
  seenExtGStateDicts.add(extGState);
  return added;
}

/**
 * Runs the fix over an entire PDF (as bytes/ArrayBuffer) and returns the
 * fixed PDF bytes plus a summary of what was changed.
 */
async function fixPdfHighlights(inputBytes) {
  const pdfDoc = await PDFDocument.load(inputBytes, { updateMetadata: false });

  let totalAdded = 0;
  let pagesTouched = 0;
  const seen = new Set();

  for (const page of pdfDoc.getPages()) {
    const added = fixPage(pdfDoc, page, seen);
    if (added > 0) {
      pagesTouched++;
      totalAdded += added;
    }
  }

  const outputBytes = await pdfDoc.save();
  return { outputBytes, totalAdded, pagesTouched, pageCount: pdfDoc.getPageCount() };
}

// ---- UI wiring ----

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const resultSummaryEl = document.getElementById('resultSummary');
const downloadLink = document.getElementById('downloadLink');
const downloadSound = document.getElementById('downloadSound');

downloadLink.addEventListener('click', () => {
  if (downloadSound) {
    downloadSound.currentTime = 0;
    downloadSound.play().catch((err) => console.warn('Could not play sound:', err));
  }
});

function setStatus(message, isError = false) {
  statusEl.hidden = !message;
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', isError);
}

function setResult(bytes, fileName, summary) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.download = fileName;
  resultSummaryEl.textContent = summary;
  resultEl.hidden = false;
}

async function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setStatus('Please choose a PDF file.', true);
    return;
  }

  resultEl.hidden = true;
  setStatus(`Processing "${file.name}"…`);

  try {
    const inputBytes = await file.arrayBuffer();
    const { outputBytes, totalAdded, pagesTouched, pageCount } = await fixPdfHighlights(inputBytes);

    const summary =
      totalAdded > 0
        ? `Fixed ${totalAdded} missing highlight setting(s) across ${pagesTouched} of ${pageCount} page(s).`
        : `No opaque-highlight issue was detected in this PDF's ${pageCount} page(s) — nothing to fix.`;

    setStatus('');
    const outName = file.name.replace(/\.pdf$/i, '') + '_fixed.pdf';
    setResult(outputBytes, outName, summary);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to process PDF: ${err.message || err}`, true);
  }
}

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  handleFile(file);
});
