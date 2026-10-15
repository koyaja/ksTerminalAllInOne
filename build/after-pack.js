'use strict';
// Hook electron-builder : injecte l'icône et les informations de version dans KSTermus.exe
// sans passer par rcedit/wine (fonctionne aussi depuis Linux).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PELibrary = await import('pe-library');
  const { productName, version, description } = { ...context.packager.appInfo, description: context.packager.appInfo.description };
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const root = context.packager.projectDir;

  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map(i => i.data));

  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = versions[0];
  if (vi) {
    const [maj, min, pat] = version.split('.').map(n => parseInt(n, 10) || 0);
    vi.setFileVersion(maj, min, pat, 0, 1033);
    vi.setProductVersion(maj, min, pat, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: productName,
      FileDescription: productName,
      CompanyName: 'CYBERISK',
      LegalCopyright: `© ${new Date().getFullYear()} CYBERISK`,
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
      Comments: description || ''
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • icône + version injectées dans ${path.basename(exePath)}`);
};
