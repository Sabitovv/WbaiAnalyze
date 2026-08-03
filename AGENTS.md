# Agent Instructions

## Repo Shape
- Two separate npm projects, no root `package.json`: `backend/` and `my-react-app/` each use npm with `package-lock.json`.
- `backend/index.js` is the Express API entrypoint and also runs startup `CREATE TABLE`/`ALTER TABLE` compatibility migrations.
- `backend/migrate.js` is the baseline schema/seed script; Docker backend runs it before `node index.js` via `backend/entrypoint.sh`.
- `backend/wb.js` owns Wildberries API integration, logistics/rate helpers, import math, and token fallback from `WB_TOKENS`.
- `backend/scheduler.js` starts from `app.listen()` every 6 hours; `index.js` also starts product sync 5 minutes after boot and then daily.
- `my-react-app/src/App.jsx` contains almost all React screens/state/calculation logic; `src/api.js` is the `/api` fetch wrapper; styling is global `src/styles.css`.
- `my-react-app/CLAUDE.md` is stale for architecture details; trust current `App.jsx`, `api.js`, and backend routes instead.

## Commands
| Task | Command |
|------|---------|
| Install backend | `cd backend && npm ci` |
| Install frontend | `cd my-react-app && npm ci` |
| Full Docker stack | `docker-compose --env-file .env.docker up --build` |
| Backend migrate | `cd backend && node migrate.js` |
| Backend dev server | `cd backend && node index.js` |
| Frontend dev server | `cd my-react-app && npm run dev` |
| Frontend lint | `cd my-react-app && npm run lint` |
| Frontend focused lint | `cd my-react-app && npx eslint src/App.jsx` |
| Frontend build | `cd my-react-app && npm run build` |
| Frontend preview | `cd my-react-app && npm run preview` |

## Runtime And Env
- Docker exposes frontend/nginx at `localhost:3000`; `/api` proxies to backend service `backend:3001`.
- Docker exposes Postgres on host `localhost:5433` mapped to container `5432`; backend port `3001` is not published by Compose.
- For local backend against Docker DB use `DATABASE_URL=postgresql://sait_user:sait_pass@localhost:5433/sait_db` and `PGSSLMODE=disable`.
- Vite dev proxy sends frontend `/api` calls to `http://localhost:3001`, so local frontend requires local backend running separately.
- `.env.docker` and `backend/.env` may contain WB/API tokens; do not paste token values into logs, docs, commits, or responses.
- `WB_TOKENS` is JSON (`[{"id":"...","token":"..."}]`) and is only a fallback when `cabs.wb_token` is empty.

## Verification
- There is no configured automated test suite: `backend` has only a failing placeholder `npm test`, frontend has no test script.
- For frontend changes run `cd my-react-app && npm run lint` and `cd my-react-app && npm run build`.
- For backend/schema changes run against Postgres: `cd backend && node migrate.js`; then start `node index.js` only long enough to smoke routes because schedulers/background WB jobs start automatically.
- Manual smoke path after DB seed: login `admin` / `admin123`, create a calculator record, check history/report/admin views.

## Change Patterns
- Schema changes usually need both `backend/migrate.js` and startup compatibility SQL in `backend/index.js`.
- API changes usually need `backend/index.js`, `my-react-app/src/api.js`, and the relevant `App.jsx` screen/state update.
- Profit/logistics formula changes must keep frontend `logRub`/calculator math and backend `wb.js` import math in sync.
- Keep UI text and domain comments in Russian unless touching external/tooling docs.
- Do not introduce React Router, Redux/Zustand, TypeScript, CSS modules, or backend layering unless the task explicitly asks for a structural refactor.
- Auth is app-level only: frontend stores `wb_user` in `localStorage`; backend has no JWT/session middleware, so do not assume API routes are protected.

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: (the agent model's name and attribution byline)
```
