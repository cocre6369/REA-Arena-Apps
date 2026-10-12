# Chroma Studio — early image-editor prototype

Chroma Studio is an original, independent image editor. It is **not** Adobe Photoshop or a complete drop-in replacement. The number of commands in the UI is not a parity claim: several are simplified, some approximate results, and a few are incomplete. No Adobe binary, decompiled output, imagery, icons or fonts are shipped.

## Get it

- **Windows x64:** on this repository's **Actions → Chroma Studio Windows download** page, open the latest successful run for this branch and download the `Chroma-Studio-Windows-x64` artifact. Extract the ZIP. Run `Chroma Studio-0.1.1-portable.exe` without installing, or use `Chroma Studio-0.1.1-Setup.exe`. The executable is unsigned; Windows may ask you to confirm you trust it. A built artifact is only available after the workflow completes successfully.
- **Browser preview:** from the repository root run `node apps/studio/tools/serve.cjs`; open `http://localhost:4173`. Local files stay in your browser unless you use Electron's file dialogs.
- **Build yourself on Windows:** `cd apps/studio && npm ci && npm run dist` (Node 22 recommended). Electron Builder writes executables to `dist/`.

## What works now

Canvas-based raster editing with layers, visibility, opacity, many canvas blend modes and a native `.csp` JSON project file. Open common browser-supported image formats, **place an image as a layer**, and export PNG/JPEG/WebP/BMP or basic 8-bit RGB PSD. The restored toolbar exposes 37 tools: brush/pencil/eraser, move, marquee/lasso/wand/quick selection, colour picker, fill, gradient, crop, text, paths, geometric shapes and simplified retouch tools. There are colour adjustments (levels/curves/hue-saturation and others), filter categories (blur/sharpen/noise/distort/render etc.), a histogram, guides, navigator, channels and a basic history UI. Many retouch and path operations are simple approximations.

### Working with masks

1. Select a layer, then click **Mask** in the Layers panel, or use **Layer → Layer Mask → Reveal All / Hide All / From Selection / From Layer Transparency**.
2. Click the **mask thumbnail** to edit it; it gets a blue outline. With the mask selected, **Brush reveals** and **Eraser hides** using the brush's size, hardness and opacity. A selection limits where the stroke applies. Click the **layer thumbnail** or the **Edit pixels** button to switch back. Changing to a non-painting tool also exits mask editing.
3. **Alt-click the mask thumbnail** to enable/disable it. The Layer menu provides invert, feather, load as selection, apply and delete. Mask edits, inversion and selection operations can be undone. Mask thumbnails and the status bar identify the active target.
4. Masks are stored as alpha in native `.csp` projects. This is a basic raster-mask workflow, not a full professional masking system: mask previews while dragging are approximate; applying a mask to a group or adjustment layer requires rasterizing first. Save a copy before important changes.

## Known gaps — do not rely on this for professional work

- No Photoshop feature parity: no smart objects, colour-managed CMYK/16/32-bit workflow, RAW development, non-destructive smart filters, full vector/path engine, advanced selection refinement, content-aware generation, linked assets, GPU acceleration, plugins, scripting, or production-print export.
- PSD support is limited to simple 8-bit files and does not round-trip every layer type, effect, adjustment or metadata. Keep a copy of your source files.
- Large documents and costly filters run on the UI thread and can stall it; history and native JSON saves can use significant memory.
- Several command names and icons represent simplified behaviours rather than exact equivalents. Export and reopen a copy before committing important edits.
- The Windows executables are unsigned. There is no updater. The 0.1.0 artifact lacked toolbar modules and should not be used; download the latest successful 0.1.1 run instead. A successful package build does not prove Windows runtime behaviour.

## Legal and identity

This is an independent app, with its own branding and artwork. Similar functionality can raise questions beyond copyright (such as trademarks, patents, licences and contractual terms); no blanket claim of legality is made. `docs/00-legal-and-scope.md` describes the repo's clean-room approach. Chroma Studio is not affiliated with Adobe.
