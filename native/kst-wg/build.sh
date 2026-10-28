#!/bin/sh
# Compile kst-wg (Linux + Windows, x64) et le pair de test.
# Dépendances : wireguard-go et ses modules. Si proxy.golang.org est inaccessible,
# cloner les miroirs GitHub (golang/crypto, golang/net, golang/sys, golang/time,
# google/btree, WireGuard/wireguard-go, google/gvisor@39ed1f5ac29c) et ajouter des
# directives `replace` vers ces dossiers (voir README, section VPN).
set -e
cd "$(dirname "$0")"
export CGO_ENABLED=0
MF=""; [ -f go.offline.mod ] && MF="-modfile=go.offline.mod"
GOOS=linux   GOARCH=amd64 go build $MF -trimpath -ldflags="-s -w" -o kst-wg-linux-x64 .
GOOS=windows GOARCH=amd64 go build $MF -trimpath -ldflags="-s -w" -o kst-wg-win32-x64.exe .
GOOS=darwin  GOARCH=arm64 go build $MF -trimpath -ldflags="-s -w" -o kst-wg-darwin-arm64 .
GOOS=darwin  GOARCH=amd64 go build $MF -trimpath -ldflags="-s -w" -o kst-wg-darwin-x64 .
MF=""; [ -f go.offline.mod ] && MF="-modfile=go.offline.mod"
GOOS=linux   GOARCH=amd64 go build $MF -trimpath -ldflags="-s -w" -o testpeer-linux-x64 ./testpeer
ls -la kst-wg-* testpeer-*
