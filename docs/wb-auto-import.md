# Автоматический импорт отчётов из Wildberries

## Цель
Отчёты в WB Analytics должны строиться на реальных данных из WB Partners, а не на ручных записях. Система автоматически подтягивает ежедневную финансовую сводку по кабинетам и показывает её в истории/отчётах.

## Решения (Decision Log)

| Вопрос | Решение | Почему |
|--------|---------|--------|
| Источник данных | WB API `reportDetailByPeriod` (отчёт о продажах по реализации) | Официальная статистика WB, в ней уже есть выручка и артикулы |
| Частота | Cron раз в час | Хватит, чтобы не упереться в лимиты WB и при этом быть в актуальном состоянии |
| Детализация | Одна сводная строка на `дату + кабинет` | Пользователю нужна сводка, а не каждый заказ |
| Хранение | Отдельная таблица `wb_sales` | Не ломаем существующую `history`, можно сравнивать ручные и WB-данные |
| Объединение с ручными записями | `wb_sales` имеет приоритет над `history` за тот же день/кабинет | WB — первичный источник |
| Сопоставление товаров | По `supplierArticle` из WB ↔ полю `article` в `catalog` | Артикул — естественный ключ |
| Рекламный бюджет | Автоматически из WB Adverts API (`/api/advert/v2/adverts` + `/adv/v3/fullstats`) | Расходы попадают в `wb_advert_stats` и вычитаются из прибыли |
| Тип кабинета (ИУ / обычный) | Визуальная метка + фильтр, комиссию админ вводит вручную | ИУ — индивидуальный предприниматель, от типа зависит только комиссия |
| Выкуп % | Read-only в админке, значение берётся из WB API (`fetchBuyout`) | Пользователь хочет видеть реальный % выкупа |
| Комиссия WB | Админ вводит вручную в карточке кабинета | WB API даёт среднюю комиссию по категориям, но пользователю нужна точная |
| WB API токен | Хранится в поле `cabs.wb_token`, вводится в карточке кабинета | Удобнее, чем править `.env.docker` при каждой смене токена |
| Необходимые scope токена | **Statistics** — импорт продаж (`reportDetailByPeriod`)<br>**Adverts** — импорт рекламных кампаний<br>**Common API** — комиссия/выкуп | Без нужного scope WB вернёт `401 token scope not allowed` |

## Архитектура

### База данных
1. `catalog` имеет поле `article TEXT`.
2. `cabs` имеет поля:
   - `buyout INTEGER` — % выкупа (read-only, из WB API),
   - `cab_type TEXT` — `regular` или `iu` (на экране «Обычный» / «ИУ»),
   - `commission NUMERIC` — комиссия WB % (ручной ввод),
   - `wb_store_id TEXT` — ID кабинета в WB,
   - `wb_token TEXT` — JWT-токен из WB Partners (вводится в админке).
3. Таблица `wb_sales`:
   ```sql
   id SERIAL PRIMARY KEY,
   cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
   date DATE NOT NULL,
   rev NUMERIC DEFAULT 0,
   ads NUMERIC DEFAULT 0,
   cost NUMERIC DEFAULT 0,
   comm NUMERIC DEFAULT 0,
   cab_comm NUMERIC DEFAULT 0,
   log_f NUMERIC DEFAULT 0,
   log_r NUMERIC DEFAULT 0,
   ret NUMERIC DEFAULT 0,
   profit NUMERIC DEFAULT 0,
   margin NUMERIC DEFAULT 0,
   drr NUMERIC DEFAULT 0,
   source TEXT DEFAULT 'wb',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   updated_at TIMESTAMPTZ DEFAULT NOW(),
   UNIQUE(cab_id, date)
   ```

### Backend
1. `backend/wb.js`:
   - `fetchReportDetailByPeriod(token, dateFrom, dateTo)` — запрос к WB Statistics API v5 (`/api/v5/supplier/reportDetailByPeriod`).
   - `importCabSales(pool, cab, dateFrom, dateTo)` — сначала вызывает `importCabAds`, суммирует рекламу по датам, затем парсит отчёт о продажах, считает cost/comm/logF/logR/cab_comm/profit/margin/drr, upsert в `wb_sales`.
   - `fetchBuyout(token, days)` — приближённый % выкупа из WB.
   - `getCabToken(cab)` — сначала берёт `cab.wb_token`, fallback на переменную `WB_TOKENS`.
   - `fetchAdverts(token)` — список кампаний: `GET https://advert-api.wildberries.ru/api/advert/v2/adverts`.
   - `fetchAdvertStats(token, ids, dateFrom, dateTo)` — статистика кампаний: `GET https://advert-api.wildberries.ru/adv/v3/fullstats?ids=...&beginDate=...&endDate=...`.
   - `importCabAds(pool, cab, dateFrom, dateTo)` — сохраняет расходы по кампаниям в `wb_advert_stats` (в KZT).
   - `seedDemoAds(pool, cab, days)` — генерирует фейковые рекламные строки для демонстрации UI.
2. `backend/index.js`:
   - `POST /api/wb/import/:cabId?dateFrom=...&dateTo=...` — ручной импорт за период (по умолчанию последние 7 дней).
   - `POST /api/wb/import-all?dateFrom=...&dateTo=...` — импорт для всех кабинетов с `wb_store_id`.
   - `GET /api/wb/adverts/:cabId?dateFrom=...&dateTo=...` — просмотр сохранённых рекламных кампаний.
   - `POST /api/wb/seed-demo/:cabId?days=...` — демо-продажи.
   - `POST /api/wb/seed-demo-ads/:cabId?days=...` — демо-рекламные кампании.
   - Cron-задача раз в час: для каждого кабинета с `wb_store_id` импортировать «вчера».
   - При выдаче `GET /api/history` объединять с `wb_sales`: сначала `wb_sales`, затем `history` за дни, отсутствующие в `wb_sales`.

### Расчёты
- `rev` — сумма `retail_amount` (или `retail_price * qty`) из отчёта WB.
- `cost` — `SUM(qty * catalog.cost)` по совпавшим `article`.
- `comm` — `SUM(qty * catalog.cost * catalog.comm / 100)`.
- `cab_comm` — `rev * cabs.commission / 100`.
- `log_f` — по формуле объёма WB, коэффициента склада и выкупа.
- `log_r` — логистика возвратов по формуле.
- `netRev = rev * buyout`
- `profit = netRev - cost - ads - comm - cab_comm - log_f - log_r`
- `margin = profit / netRev * 100`
- `drr = ads / netRev * 100`

### Frontend
1. Админ-панель → Товары: добавить поле «Артикул WB» (`article`).
2. Админ-панель → Кабинеты:
   - поле «Тип кабинета» (`regular` / `ИУ`),
   - поле «Комиссия WB %» (ручной ввод),
   - поле «Выкуп %» (read-only, из WB API),
   - поле «WB store ID»,
   - поле «WB API токен» (password-поле, сохраняется в БД),
   - кнопка «Импорт WB за период» с полями дат,
   - кнопка «Синхронизировать выкуп с WB».
3. История/Отчёты: помечать WB-записи значком/подписью.

## Этапы реализации
1. Миграция БД: `catalog.article` + `wb_sales` + `cabs.cab_type/commission/wb_store_id/wb_token`.
2. Backend: запрос `reportDetailByPeriod` (v5), парсинг, upsert `wb_sales`.
3. Backend: endpoints импорта и cron раз в час.
4. Backend: объединение `history + wb_sales` в отчётах.
5. Frontend: поле артикула в каталоге, тип кабинета, комиссия, токен, импорт в админке.
6. Проверка: ручной импорт + cron + отчёты. Для реального импорта токен должен иметь scope **Statistics**.

## Риски
- WB API может не отдавать данные за текущий день сразу.
- `supplierArticle` в WB может не совпадать с артикулами в каталоге.
- Лимиты WB API (статистика ограничена по количеству запросов).
