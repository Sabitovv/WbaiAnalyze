# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # start dev server (Vite HMR)
npm run build     # production build to dist/
npm run preview   # serve production build locally
npm run lint      # ESLint over all .js/.jsx files
```

No test suite is configured.

## Architecture

Single-file React 19 application (`src/App.jsx`) — no routing, no state library, no CSS modules. All styling is inline using CSS custom properties (e.g. `var(--color-text-success)`) for theming.

**Domain:** Daily profit calculator for sellers on the Wildberries (WB) Kazakhstan marketplace. Calculates net profit from revenue, ad spend, per-product COGS, WB commission, delivery logistics, and returns.

**Key data structures in App.jsx:**
- `CATALOG` — hardcoded product list with cost (`c`), WB commission rate (`comm`), and box dimensions (`w/d/h` in cm) used for logistics volume calculation.
- `CABS` — list of seller cabinet names (seller accounts on WB).
- `rows` — array of line items the user adds per product; each row has `{id, product, qty, cost, comm}`.
- `history` — in-memory array of saved daily records (lost on page refresh — no persistence).

**Core calculation (`calc` useMemo):** Takes revenue, ads, and all product rows, then computes cost of goods, WB commission, forward logistics (`logF` — volume-based RUB cost × storage coefficient × RUB/KZT rate), return logistics (`logR`), and loss from unredeemed orders (`ret = rev × (1 − buyoutRate)`). All monetary values are in KZT (Kazakhstani tenge).

**Logistics formula (`logRub`):** Converts box dimensions to liters, then applies WB's tiered per-liter RUB rate (see function at top of App.jsx). Returns `null` when dimensions are unknown (some CATALOG entries have `w:0`).

**Exchange rate fetch:** On mount, calls the Anthropic Messages API directly from the browser (`https://api.anthropic.com/v1/messages`) using model `claude-sonnet-4-6` with the `web_search_20250305` tool to fetch the official NBK (National Bank of Kazakhstan) RUB/KZT rate. The API key must be supplied — currently the fetch has no `x-api-key` header, so it will fail without one. The user can always override the rate manually.

**Three components:**
- `App` — all state and layout
- `ProdRow` — single product line item (select + inputs + computed logistics per unit)
- `ResultPanel` — profit breakdown display with color-coded margin/DRR indicators
