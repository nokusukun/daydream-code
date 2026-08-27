# app icon

`3-facet.svg` is the current mark, shipped as `icon.svg` / `icon.png` / `icon.icns`.
The other three numbered SVGs are the candidates it was chosen from; `index.html`
is the contact sheet that compares all four at 128 / 64 / 32 / 16.

The mark is the `◈` the master thread already wears in the rail. Its soft,
light-mode tile uses a warm porcelain ground, a cool slate facet, and one muted
blue center. The accent stays contained to the center so the mark keeps the
restrained color strategy used by the rest of the app.

```
ground  #FAF8F3 → #E7EAF0      mark #5A6575      accent #82ACE3
canvas 1024, squircle inset 96 (832 body, r=186), specular top edge
```

Regenerate the raster set after editing the SVG:

```sh
mkdir icon.iconset
for s in 16 32 64 128 256 512 1024; do rsvg-convert -w $s -h $s 3-facet.svg -o /tmp/i-$s.png; done
cp /tmp/i-16.png icon.iconset/icon_16x16.png;      cp /tmp/i-32.png  icon.iconset/icon_16x16@2x.png
cp /tmp/i-32.png icon.iconset/icon_32x32.png;      cp /tmp/i-64.png  icon.iconset/icon_32x32@2x.png
cp /tmp/i-128.png icon.iconset/icon_128x128.png;   cp /tmp/i-256.png icon.iconset/icon_128x128@2x.png
cp /tmp/i-256.png icon.iconset/icon_256x256.png;   cp /tmp/i-512.png icon.iconset/icon_256x256@2x.png
cp /tmp/i-512.png icon.iconset/icon_512x512.png;   cp /tmp/i-1024.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns && rm -rf icon.iconset
cp /tmp/i-1024.png icon.png && cp 3-facet.svg icon.svg
```

`icon.icns` is unused until there is a packaging step; the Dock icon is set at
runtime from `icon.png` in `electron/main.ts`.
