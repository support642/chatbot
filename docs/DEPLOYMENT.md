# Deployment (AWS EC2 + Docker, frontend on Vercel)

The main backend keeps running under PM2 on port 5050. This service runs in Docker on port 4001
on the same (or a separate) EC2 instance. They do not share runtimes.

## 1. One-time EC2 setup

```bash
# Amazon Linux 2023
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER      # re-login afterwards
sudo mkdir -p /usr/local/lib/docker/cli-plugins
# docker compose plugin: https://docs.docker.com/compose/install/linux/
```

Security group: open inbound TCP **4001** (restrict the source if possible).
If the RDS security group is restricted by IP/SG, allow this EC2 instance.

## 2. Database migrations (once, in this order)

Check first (must return no rows):
`SELECT user_name, COUNT(*) FROM users WHERE user_name IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`

```bash
for f in 20261113_users_user_name_unique 20261114_create_chatbot_report_confirmations 20261120_create_chatbot_settings; do
  psql "host=$DB_HOST user=$DB_USER dbname=$DB_NAME sslmode=require" -v ON_ERROR_STOP=1 -f migrations/$f.sql
done
```

## 3. Deploy

```bash
git clone <chatbot-service repo url> ~/chatbot-service && cd ~/chatbot-service
cp .env.example .env && nano .env          # fill secrets; set SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
docker compose up -d --build
curl localhost:4001/health                 # {"status":"ok"}
```

## 4. Update / rollback

```bash
cd ~/chatbot-service
git fetch --tags && git checkout v1.1.0    # or: git pull origin main
docker compose up -d --build
# rollback
git checkout v1.0.0 && docker compose up -d --build
```

Logs: `docker compose logs -f --tail=200`. Restart: `docker compose restart`.
The container has `restart: unless-stopped`, so it survives reboots.

## 5. Connect the frontend (Vercel)

Vercel is HTTPS, the EC2 endpoint is plain HTTP, so the browser would block direct calls (mixed content).
Use a Vercel rewrite, same pattern as the existing `/api` one, in `checklist-frontend/vercel.json`:

```json
{ "source": "/chatbot-api/:path*", "destination": "http://<EC2_IP>:4001/api/chatbot/:path*" }
```

Place it **before** the `/(.*)` catch-all rule. Then in Vercel -> Project -> Settings -> Environment Variables set:

```
VITE_CHATBOT_API_BASE_URL=/chatbot-api
```

and redeploy the frontend. For local frontend dev, `.env` uses `VITE_CHATBOT_API_BASE_URL=http://localhost:4001/api/chatbot`.

## 6. Add the OpenAI key

Log in as a super admin -> Settings -> **AI Key** -> paste the key -> Save. No restart needed.

## 7. Remove the chatbot from the main backend (after verifying)

The main backend (`checklist-backend-final`) does not mount chatbot routes in `server.js`, so nothing
runs there. Once this service is live you can delete the chatbot files from that repo
(`*chatbot*`, `scripts/createChatbotDevSession.js`, the `openai` dependency) to avoid two copies drifting.
