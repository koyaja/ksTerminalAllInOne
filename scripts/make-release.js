#!/usr/bin/env node
'use strict';
// Prépare les fichiers d'une release GitHub signée.
//
//   node scripts/make-release.js --zip KSTermus-win-x64.zip --notes notes.md --key chemin/kstermus-update-signing.pem
//
// Produit dans dist/release/ :
//   KSTermus-win-x64-<version>.zip   (copie de l'archive)
//   update.json                      (manifeste signé, lu par l'application)
//   notes.md                         (texte de la release)
// La version vient de package.json. La clé privée ne doit JAMAIS être commitée.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signManifest, verifyManifest, PUBLIC_KEY } = require('../src/main/updater');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['zip', 'key']) if (!args[k]) { console.error(`--${k} manquant`); process.exit(2); }

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const notes = args.notes ? fs.readFileSync(args.notes, 'utf8').trim() : `KSTermus ${version}`;
const key = fs.readFileSync(args.key, 'utf8');
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim();
if (pub !== PUBLIC_KEY.trim()) { console.error('Cette clé ne correspond pas à la clé publique intégrée à l\'application.'); process.exit(1); }

const outDir = path.join(root, 'dist', 'release');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const file = `KSTermus-win-x64-${version}.zip`;
fs.copyFileSync(args.zip, path.join(outDir, file));
const buf = fs.readFileSync(path.join(outDir, file));
const manifest = { version, file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), notes, date: new Date().toISOString() };
manifest.sig = signManifest(manifest, key);
verifyManifest(manifest);
fs.writeFileSync(path.join(outDir, 'update.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(outDir, 'notes.md'), notes + '\n');
console.log(`Release v${version} prête dans ${outDir}`);
console.log(`  ${file}  ${(buf.length / 1048576).toFixed(1)} Mo  sha256=${manifest.sha256}`);
console.log('  update.json (signé)');
console.log(`\nPublier : gh release create v${version} dist/release/${file} dist/release/update.json --title "KSTermus ${version}" --notes-file dist/release/notes.md`);
