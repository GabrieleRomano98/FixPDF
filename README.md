# PDF Highlight Fixer (GitHub Pages site)

A static, client-side website that fixes PDFs where highlighter marks render
as **opaque solid bands** instead of translucent highlights (a common issue
with PDFs exported from Google Docs/Slides).

Everything runs in the browser using [pdf-lib](https://pdf-lib.js.org/) — no
server, no upload. Drop a PDF in, get a fixed PDF back.

## Why this happens

The highlighter rectangles reference an `ExtGState` resource via the
`/Name gs` content-stream operator (intended to use `Multiply` blend mode so
text stays visible under the highlight color). Some exporters forget to
actually *define* that `ExtGState` object on the page, so viewers fall back
to fully opaque rendering. This tool detects `gs` operators referencing
undefined `ExtGState` resources and adds sensible definitions
(`Multiply` blend, or an explicit alpha decoded from the resource name like
`pgf@ca0.30`). It never touches text or drawing operators, so selectable
text is preserved.

This is a browser port of the original `fix_pdf_highlights_v2.py` script.

## Deploying with GitHub Pages

1. Push this repo (with the `docs/` folder) to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Select branch `release/18` (or your default branch) and folder **`/docs`**.
5. Save. GitHub will publish the site at
   `https://<owner>.github.io/<repo>/` within a minute or two.

## Local preview

No build step is required — just open `index.html` in a browser, or serve
the folder locally, e.g.:

```powershell
cd docs
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Files

- `index.html` — page markup/UI
- `style.css` — styling
- `app.js` — the PDF-fixing logic (pdf-lib) + drag-and-drop UI wiring
