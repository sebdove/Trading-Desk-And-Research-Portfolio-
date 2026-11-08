// File storage for one bot: state.json, equity.json (account value history) and bars/<symbol>.json (for the dashboard).
const fs = require('fs'), path = require('path');
const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const { writeAtomic } = require('./atomic');   // retries while Windows has the file open

function fileStore(dir) {
  fs.mkdirSync(path.join(dir, 'bars'), { recursive: true });
  const eqFile = path.join(dir, 'equity.json');
  return {
    dir, file: path.join(dir, 'state.json'),
    load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return null } },
    save(s) { writeAtomic(this.file, JSON.stringify(s, null, 2)) },
    appendEquity(t, eq) {
      let a = []; try { a = JSON.parse(fs.readFileSync(eqFile, 'utf8')) } catch {}
      if (a.length && a[a.length - 1][0] === t) a[a.length - 1][1] = eq; else a.push([t, +eq.toFixed(2)]);
      writeAtomic(eqFile, JSON.stringify(a.slice(-5000)));
    },
    saveBars(sym, S) { writeAtomic(path.join(dir, 'bars', safe(sym) + '.json'), JSON.stringify(S)) },
  };
}
function readDir(dir) {
  const r = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } };
  return { state: r('state.json'), equity: r('equity.json') || [], bars: sym => r(path.join('bars', safe(sym) + '.json')) };
}
module.exports = { fileStore, readDir };
