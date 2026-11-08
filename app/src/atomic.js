// Write a file safely on Windows: write a temp file, then rename it over the old one. Windows refuses the rename
// (EPERM / EBUSY / EACCES) while another process — the dashboard, an antivirus scan, a backup tool — has the file open,
// so retry for up to ~2 seconds, then fall back to copying over it. (1.8.0 gave up on the first refusal.)
const fs = require('fs');
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} };
function writeAtomic(f, data) {
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, data);
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(tmp, f); return } catch (e) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; pause(100) }
  }
  fs.copyFileSync(tmp, f); try { fs.unlinkSync(tmp) } catch {}
}
module.exports = { writeAtomic };
