# PVSRA Vector Desk

A Windows desktop app that runs four trading bots side by side (crypto, Bitcoin trend, S&P 500 stocks and futures momentum), sharing one pot of money. Tested from January 2020 to November 2026.

- **Project page (the research and results):** https://sebdove.github.io/Trading-Desk-And-Research-Portfolio-/
- **Download the app:** [Releases](https://github.com/sebdove/Trading-Desk-And-Research-Portfolio-/releases/latest), `PVSRA-Bot-Desk-Setup-2.2.1.exe` (Windows 10 or 11)
- **Source code:** the [`app`](app) folder

## What's in this repository

| Path | What it is |
|---|---|
| `index.html` | The project page, served by GitHub Pages |
| `app/electron` | The desktop window, settings and the desk that shares money between bots |
| `app/src` | The bots, models, back-tests, broker connections and the dashboard |
| `app/test` | 75 automated tests, including live-equals-replay checks for every bot |
| `app/data` | S&P 500 list and Bubble Watch seed data |

## Safety

- Every bot starts on **paper** (no real money). Live trading has to be switched on deliberately: type LIVE and confirm.
- API keys are entered in the app and stored encrypted on your computer, never in config files.
- The dashboard is read-only and only listens on your own computer (127.0.0.1).
- The momentum bot and the new stock models are paper only.

The installer isn't code-signed, so Windows SmartScreen may ask you to confirm: **More info → Run anyway**.

## Run from source

Needs Node.js 20 or newer.

```
cd app
npm install
npm test        # 75 tests
npm run app     # start the desk
npm run dist    # build the Windows installer into app/dist
```

## Disclaimer

This is a research project, not financial advice. The results are back-tests: they use today's lists of coins and stocks, so the past looks a little better than it was, and future returns will differ. Use live trading at your own risk.
