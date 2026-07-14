# ── KKSS icon pipelines ─────────────────────────────────────────────────────
# 1. Shell toolbar icons: tikz-ui/*.tex → svg-ui/*.svg →
#    ../app/renderer/shell/shellIcons.ts (monochrome, currentColor-based).
#    Same pipeline, preamble, and visual language as the cad/ and mesh/
#    submodules' icons/ directories; open.tex is copied verbatim from mesh.
# 2. Application icon: tikz-app/kkss.tex → app/icon*.png (colored, used by
#    electron-builder and the Linux window icon).
# 3. Docs OS glyphs: tikz-os/*.tex → ../doc/public/os/*.svg (colored badges for
#    the download page; `make os`, not part of the default `all`).
# Needs pdflatex + pdftocairo (poppler); dvisvgm is a drop-in for pdftocairo.
UI_TEXDIR := tikz-ui
UI_BUILDDIR := build-ui
UI_SVGDIR := svg-ui

UI_TEX := $(wildcard $(UI_TEXDIR)/*.tex)
UI_SVG := $(patsubst $(UI_TEXDIR)/%.tex,$(UI_SVGDIR)/%.svg,$(UI_TEX))

APP_TEXDIR := tikz-app
APP_BUILDDIR := build-app
APP_OUTDIR := app

# 3. Docs download-page OS glyphs: tikz-os/*.tex → ../doc/public/os/*.svg
#    (colored badges — generic penguin / four-pane window / whole apple, NOT
#    brand logos). Committed SVGs; regenerate with `make os`.
OS_TEXDIR := tikz-os
OS_BUILDDIR := build-os
OS_SVGDIR := ../doc/public/os
OS_TEX := $(wildcard $(OS_TEXDIR)/*.tex)
OS_SVG := $(patsubst $(OS_TEXDIR)/%.tex,$(OS_SVGDIR)/%.svg,$(OS_TEX))

.PHONY: all ui ts app os clean
all: ts app
ui: $(UI_SVG)
os: $(OS_SVG)

$(UI_SVGDIR)/%.svg: $(UI_TEXDIR)/%.tex
	@mkdir -p $(UI_BUILDDIR) $(UI_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(UI_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(UI_BUILDDIR)/$*.pdf $(UI_SVGDIR)/$*.svg

# Regenerates ../app/renderer/shell/shellIcons.ts from svg-ui/*.svg — run
# after `make ui` whenever a tikz-ui/*.tex source changes. Pure Node, no
# LaTeX needed as long as svg-ui/*.svg is already up to date (it's committed).
ts: ui
	node build-toolbar-icons.mjs

# App icon renders: 1024 (source of truth), 512 (electron-builder input —
# it derives .ico/.icns from this), 256 (Linux window icon, copied to out/).
app: $(APP_BUILDDIR)/kkss.pdf
	@mkdir -p $(APP_OUTDIR)
	pdftocairo -png -transp -singlefile -scale-to 1024 $(APP_BUILDDIR)/kkss.pdf $(APP_OUTDIR)/icon-1024
	pdftocairo -png -transp -singlefile -scale-to 512 $(APP_BUILDDIR)/kkss.pdf $(APP_OUTDIR)/icon
	pdftocairo -png -transp -singlefile -scale-to 256 $(APP_BUILDDIR)/kkss.pdf $(APP_OUTDIR)/icon-256

$(APP_BUILDDIR)/kkss.pdf: $(APP_TEXDIR)/kkss.tex
	@mkdir -p $(APP_BUILDDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(APP_BUILDDIR) $< >/dev/null

# Colored SVG glyphs for the docs download table. No pdftocairo? dvisvgm (ships
# with TeX Live) converts the PDF directly: dvisvgm --pdf --no-fonts $*.pdf.
$(OS_SVGDIR)/%.svg: $(OS_TEXDIR)/%.tex
	@mkdir -p $(OS_BUILDDIR) $(OS_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(OS_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(OS_BUILDDIR)/$*.pdf $@

clean:
	rm -rf $(UI_BUILDDIR) $(UI_SVGDIR) $(APP_BUILDDIR) $(OS_BUILDDIR)
