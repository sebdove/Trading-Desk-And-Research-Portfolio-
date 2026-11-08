const { series } = require('./synth');
// Feed that reveals history one bar at a time, like a live exchange would.
class MockFeed {
  constructor(data, bench) { this.data = data; this.bench = bench; this.t = null }
  at(t) { this.t = t; return this }
  cut(S) { let n = 0; while (n < S.t.length && S.t[n] <= this.t) n++; const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(0, n); return o }
  async load() { const series = {}; for (const [s, S] of Object.entries(this.data)) series[s] = this.cut(S); return { series, bench: this.cut(this.bench), barTime: this.t } }
}
const memStore = () => ({ s: null, load() { return this.s && JSON.parse(JSON.stringify(this.s)) }, save(x) { this.s = JSON.parse(JSON.stringify(x)) } });
function market(n, tf, k = 8) { const data = {}; for (let i = 0; i < k; i++) data['S' + i] = series(i + 11, n, tf, { price: 20 + 7 * i, q: 3e6 * (1 + i), vol: tf < 86400 ? 0.012 : 0.02 }); return { data, bench: series(77, n, tf, { drift: 0.0005, q: 5e8 }) } }
module.exports = { MockFeed, memStore, market };
