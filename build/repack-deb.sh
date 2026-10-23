#!/bin/sh
# Re-empaquette les .deb produits par electron-builder (fpm) au format dpkg-deb standard :
# apt récent refuse les en-têtes « ar » de style GNU (« debian-binary/ », mode 644)
# avec « Invalid archive member header ».
set -e
for deb in dist/*.deb; do
  [ -f "$deb" ] || continue
  tmp=$(mktemp -d)
  dpkg-deb -R "$deb" "$tmp/pkg"
  dpkg-deb --root-owner-group -Zxz --build "$tmp/pkg" "$deb.new" >/dev/null
  mv "$deb.new" "$deb"
  rm -rf "$tmp"
  echo "  • .deb ré-empaqueté (format dpkg-deb) : $deb"
done
