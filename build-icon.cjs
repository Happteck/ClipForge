// electron-builder afterPack hook: stamps the ClipForge icon onto the app exe
// (done here because electron-builder's own signing tools need admin symlinks on this PC).
const path = require('path');
exports.default = async function (ctx) {
  const { rcedit } = await import('rcedit');
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  await rcedit(exe, { icon: path.join(ctx.packager.projectDir, 'icon.ico') });
};
