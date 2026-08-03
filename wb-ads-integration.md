# Интеграция рекламных расходов WB Adverts API

## Goal
Автоматически подтягивать рекламные расходы по кампаниям из WB Adverts API и учитывать их в поле `ads` отчётов WB Analytics.

## Tasks
- [ ] Add `wb_advert_stats` table (campaign-level daily stats).
- [ ] Add WB Adverts API helpers in `backend/wb.js`: fetch campaign list and `/adv/v2/fullstats`.
- [ ] Add `importCabAds(pool, cab, dateFrom, dateTo)` to store daily campaign costs in KZT.
- [ ] Update `importCabSales` flow to call ad import and sum `ads` per date.
- [ ] Convert WB sales `rev` and ad costs from RUB to KZT using exchange rate.
- [ ] Update `GET /api/history` and reports to show campaign-level ad breakdown.
- [ ] Add frontend admin view: campaign list and daily ad spend per cabinet.
- [ ] Update cron to import ads together with sales.
- [ ] Verify locally with current token (expect 401/403 if token lacks Adverts scope).

## Done When
- `POST /api/wb/import/:cabId` pulls both sales and ad campaign data.
- `wb_sales.ads` equals the sum of daily ad spend for that cabinet/date.
- Frontend shows campaign-level breakdown and total ad spend.
