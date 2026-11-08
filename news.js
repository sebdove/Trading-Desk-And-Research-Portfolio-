// Daily news check for the Bubble Watch, using the person's own Anthropic API key (optional).
// Claude searches the web for the latest news and research on each pillar, compares it with the data readings,
// and returns verdicts plus a small, capped "news tilt" that is shown beside the data score (never inside it).
'use strict';

const PILLAR_NAMES = { valuation: 'Valuation (overvaluation of the asset)', expansion: 'Expansion that outruns output', leverage: 'False momentum from "dumb money" leverage', fomo: 'Public FOMO',
  fragility: 'Backdoor fragility (hidden credit and financial stress)', benchmark: 'Valuation against benchmarks (equal weight, bonds, Nasdaq, small caps)', trend: 'Stretch above the long-run trend', killers: 'Momentum killers (what ends bubbles)' };
const VERDICTS = ['match', 'partly', 'ahead', 'contra', 'untest'];

async function callClaude({ apiKey, model, prompt, maxSearches = 8, maxTokens = 6000 }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, tools: maxSearches ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }] : undefined, messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error && j.error.message ? `Anthropic API: ${j.error.message}` : `Anthropic API HTTP ${r.status}`);
    if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue }   // long server-side search: let it carry on
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  throw new Error('the news check did not finish');
}
function parseJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/); const s = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(s);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// readings: compact snapshot of the latest data (built by the service from the page data)
function newsPrompt(readings, previous, today) {
  return `Today is ${today}. You keep a daily "news versus data" check for an S&P 500 bubble dashboard.

LATEST DATA READINGS (percentiles compare each indicator with every earlier month since 1871; 100 = most bubble-like on record):
${JSON.stringify(readings)}

YESTERDAY'S NEWS SUMMARY (update it; keep items that are still the latest word, replace stale ones):
${JSON.stringify(previous || {})}

TASK: Search the web for news and research from the last few weeks on each pillar below (US stocks, S&P 500, AI boom, Fed, rates, credit, margin debt, IPOs, concentration). Then, for each pillar, give:
- "verdict": "match" (news and data agree), "partly", "ahead" (the news describes something the data does not show yet), "contra" (news and data disagree), or "untest" (the data cannot measure it)
- "tilt": an integer from -2 to 2 for what the NEWS says: +2 strongly points to bubble or rising risk, -2 strongly against
- "summary": one or two plain sentences comparing news with the readings, citing numbers
- "items": up to 3 news items, each {"text": under 40 words, "source": outlet name, "date": "YYYY-MM-DD", "url": a real URL you found}
Pillars: ${Object.entries(PILLAR_NAMES).map(([k, v]) => `${k} = ${v}`).join('; ')}.
For "killers", also list "coming": the ids of momentum killers that the news says are likely within about three months but are off in the data, from: fed_hikes, curve_inv, bond_shock, credit_widen, trend_break, jobs_turn, fin_tight, earn_fall, inflation, lend_tight.
Also give "headline": one sentence on what changed since yesterday's summary (or "No material change").
Use only what you found; never invent sources, dates or numbers. Reply with only JSON:
{"asOf":"${today}","headline":"...","pillars":{"valuation":{"verdict":"match","tilt":2,"summary":"...","items":[{"text":"...","source":"...","date":"...","url":"..."}]}, "...":{}},"coming":["fed_hikes"]}`;
}
function clean(j, today) {
  const out = { asOf: String(j.asOf || today).slice(0, 10), headline: String(j.headline || '').slice(0, 400), pillars: {}, coming: [] };
  for (const k of Object.keys(PILLAR_NAMES)) {
    const p = (j.pillars || {})[k] || {};
    out.pillars[k] = { verdict: VERDICTS.includes(p.verdict) ? p.verdict : 'untest', tilt: clamp(Math.round(+p.tilt || 0), -2, 2), summary: String(p.summary || '').slice(0, 600),
      items: (Array.isArray(p.items) ? p.items : []).slice(0, 3).filter(x => x && /^https?:\/\//.test(x.url || '')).map(x => ({ text: String(x.text || '').slice(0, 300), source: String(x.source || '').slice(0, 80), date: String(x.date || '').slice(0, 10), url: String(x.url) })) };
  }
  out.coming = (Array.isArray(j.coming) ? j.coming : []).filter(x => typeof x === 'string').slice(0, 10);
  out.tilt = newsTilt(out);
  return out;
}
// news tilt: average pillar tilt (killers excluded) x 5, so at most +/-10 points beside the data score
function newsTilt(n) { const t = ['valuation', 'expansion', 'leverage', 'fomo', 'fragility', 'benchmark', 'trend'].map(k => (n.pillars[k] || {}).tilt || 0); return Math.round(t.reduce((s, x) => s + x, 0) / t.length * 5 * 10) / 10 }

async function updateNews({ apiKey, model, readings, previous, today }) {
  const text = await callClaude({ apiKey, model, prompt: newsPrompt(readings, previous, today) });
  return clean(parseJson(text), today);
}
async function checkArticle({ apiKey, model, readings, text }) {
  const prompt = `You compare a news article or research note about the US stock market with a quantitative S&P 500 bubble dashboard.
DASHBOARD READINGS (${readings.month}). Percentiles compare each indicator with every earlier month; 100 = most bubble-like on record.
${JSON.stringify(readings)}
Extract up to 8 concrete claims the text makes about valuation, leverage, speculation, credit, concentration, the economy or policy. For each: "claim" (under 25 words), "pillar" (valuation, expansion, leverage, fomo, fragility, benchmark, trend, killers or other), "stance" ("bubble", "no_bubble" or "neutral"), "data" (what the readings say, citing numbers, under 40 words), "verdict" ("matches", "partly", "contradicts" or "untestable"). Then "overall" ("matches", "mixed", "contradicts" or "off_topic") and a two-sentence "summary". Use only the readings given. Reply with only JSON: {"overall":"mixed","summary":"...","claims":[{"claim":"...","pillar":"...","stance":"...","data":"...","verdict":"..."}]}
TEXT:
"""
${String(text).slice(0, 20000)}
"""`;
  return parseJson(await callClaude({ apiKey, model, prompt, maxSearches: 0, maxTokens: 3000 }));
}

module.exports = { updateNews, checkArticle, newsTilt, clean, PILLAR_NAMES, parseJson };
