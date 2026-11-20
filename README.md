# Botivate Chatbot Service

Standalone AI assistant backend (admin-only) for the Botivate Checklist app.
Split out of `checklist-backend-final` so it runs in its own Docker container with
its own pinned Node version, and can be deployed / rolled back independently of the
main backend that runs under PM2.

- Runtime: Node 20 (pinned in `Dockerfile`), Express 5, OpenAI SDK, PostgreSQL (`pg`)
- Note: this is **Node.js, not Python**. The host's Python/Node version no longer matters.

## Structure

```
src/
  server.js                 Express app, CORS, /health, mounts /api/chatbot
  routes/chatbotRoutes.js   All endpoints (admin only)
  controllers/              HTTP handlers
  services/                 AI loop, tool definitions/executor, data + confirmation logic
  middleware/               session check (x-session-id) + admin role check
  config/                   chatbotDb (read/write pool), chatbotReadOnlyDb (read-only pool)
  scripts/createTestSession.js   creates a session row for manual testing
migrations/                 SQL for `chatbot_report_confirmations`
docs/DEPLOYMENT.md          EC2 + Docker + Vercel steps
```

## API

Base path `/api/chatbot`. Every request needs header `x-session-id` (a valid, active row in the
shared `sessions` table). The user must be active and have role `admin`, `div_admin` or `super_admin`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat` | Send a chat message |
| POST | `/confirm-work-report` | Confirm a drafted work report |
| POST | `/admin/export` | Full data behind an answer (PDF/Excel) |
| GET | `/my-tasks`, `/my-work-history` | Employee data |
| GET | `/admin/dashboard-summary`, `/task-analytics`, `/department-analytics`, `/employee-analytics`, `/work-reports`, `/work-reports/date-range` | Admin analytics |

`GET /health` (no auth) returns `{"status":"ok"}` when the DB is reachable, otherwise 503.

## Environment variables

See `.env.example`. Required: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `OPENAI_API_KEY`.
Optional: `PORT` (4001), `DB_PORT` (5432), `OPENAI_MODEL` (gpt-4o), `CORS_ORIGINS`.
The service refuses to start if `OPENAI_API_KEY` is missing.

## Database

Uses the **same PostgreSQL database** as the main backend (tables `users`, `sessions`, tasks...).
Run `migrations/20261114_create_chatbot_report_confirmations.sql` once. The data-analysis tools use a
separate pool with `default_transaction_read_only=on` and a 20s `statement_timeout`, so AI-generated
queries cannot write.

## Run locally

```bash
cp .env.example .env      # fill values
npm install
npm run dev               # http://localhost:4001
npm run test-session -- <username>   # prints a session id to use in x-session-id
```

## Run with Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
curl localhost:4001/health
```

## Version control / releases

- Branch `main` = production. Work in feature branches, merge via PR.
- Tag releases (`git tag v1.0.0 && git push --tags`); deploy a tag, roll back by deploying the previous tag.
- Image tag is controlled with `IMAGE_TAG` (default `latest`): `IMAGE_TAG=v1.0.0 docker compose up -d --build`.
- Never commit `.env`.

See `docs/DEPLOYMENT.md` for deployment.
