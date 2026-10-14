# SlimeMarket — VPS Deploy Runbook

> **Target audience:** you have a fresh VPS, a domain, and real secrets ready.  
> **Time estimate:** 30–60 minutes first time; 2 minutes for subsequent deploys.  
> **Last updated:** 2026-10-11

---

## 0. What you need before starting

| Item | Why | Where to get |
|---|---|---|
| **VPS** (2 vCPU / 4 GB RAM / 40 GB SSD minimum) | Next.js build + Docker needs RAM; 2 GB swap is auto-created if RAM < 4 GB | Any Linux provider |
| **Domain** + DNS A record → VPS IP | HTTPS + CSRF origin check | Namecheap, Cloudflare, etc. |
| **Supabase Cloud project** | Migrations depend on `auth` schema + `supabase_realtime` pub; plain Postgres will **fail** | supabase.com (free tier is enough for launch) |
| **Upstash Redis** | Rate-limiting throws in production without it | upstash.com (free tier) |
| **Circle Console credentials** | API key, entity secret, wallet IDs, SMTP config for OTP | console.circle.com |
| **.env.production filled** | All secrets + public vars | Copy from `.env.example`, fill every `<placeholder>` |
| **Deployer private key** | Gas on Arc testnet/mainnet | `.secrets/deployer.key` (already created, gitignored) |

> ⚠️ **Do NOT use plain Postgres.** `supabase/migrations/` has 92 files that reference `auth.uid()`, `auth.users`, and `supabase_realtime`. A bare `postgres:16` container fails on migration `0001`. Use **Supabase Cloud** or the official `supabase/docker` self-hosted stack.

---

## 1. VPS provisioning (one-time)

### 1.1 Connect to your VPS

```bash
ssh root@<VPS_IP>
```

### 1.2 Run the setup script

```bash
# Option A: copy from your local machine
scp scripts/vps-setup.sh root@<VPS_IP>:/root/
ssh root@<VPS_IP> "bash /root/vps-setup.sh"

# Option B: paste it directly (the script is idempotent)
```

What it installs:
- Docker + Docker Compose plugin
- Nginx + Certbot
- UFW firewall (22, 80, 443 only)
- Swap file (2 GB if RAM < 4 GB)
- `deploy` user + logrotate + fail2ban

### 1.3 Verify Docker works

```bash
docker run --rm hello-world
docker compose version
```

---

## 2. Prepare the app on the VPS

### 2.1 Clone the repo

```bash
mkdir -p /opt/slimemarket
cd /opt/slimemarket
git clone https://github.com/YOUR_ORG/slimemarket-mvp.git .
# OR rsync from local if repo is private and you haven't added a deploy key yet
```

> **If the repo is private**, add a deploy key:
> ```bash
> ssh-keygen -t ed25519 -f /opt/slimemarket/.deploy_key -N ""
> cat /opt/slimemarket/.deploy_key.pub
> # Paste the public key in GitHub → Repo Settings → Deploy keys
> ```

### 2.2 Upload `.env.production`

This file is **gitignored** and lives on your local machine (filled with real values).

```bash
# From your LOCAL machine:
scp .env.production root@<VPS_IP>:/opt/slimemarket/.env.production
```

Double-check critical values:

```bash
ssh root@<VPS_IP> "cd /opt/slimemarket && grep -E '^(NEXT_PUBLIC_APP_URL|ESCROW_CONTRACT_ADDRESS|CIRCLE_API_KEY|SUPABASE_SECRET_KEY|ARC_RPC_URL)=' .env.production"
```

Every line must show a **real value**, not `<PLACEHOLDER>`.

### 2.3 Verify contract address consistency

```bash
node scripts/tools/check-contract-addresses.mjs
```

> `.env.local` and `.env.production` **must** point to the same escrow contract.  
> This script catches the #1 misconfiguration that kills a deploy.

---

## 3. Database (Supabase Cloud)

### 3.1 Create the project

1. Go to https://supabase.com/dashboard
2. New project → name it `slimemarket-prod`
3. Save the **Project URL**, **anon key**, and **service role key**
4. Put them in `.env.production` on the VPS

### 3.2 Apply migrations

On your **local machine** (where `supabase` CLI is installed):

```bash
# Link to the remote project
supabase link --project-ref <PROJECT_REF>

# Push all 92 migrations
supabase db push
```

> If you don't have the CLI: the migrations are in `supabase/migrations/`.  
> You can apply them with `psql` via the Supabase Dashboard SQL Editor, **in filename order**.  
> Do NOT skip the order — some migrations add columns that later ones depend on.

### 3.3 Seed the indexer state

After the app first starts, the indexer needs a starting block.  
If you're using the **existing testnet contract** (`0x86feedea…`):

```sql
INSERT INTO indexer_state (id, last_processed_block, updated_at)
VALUES ('market_escrow', 64889213, now())
ON CONFLICT (id) DO NOTHING;
```

If you deployed a **new contract**, use its `ESCROW_START_BLOCK`.

---

## 4. Reverse proxy + SSL

### 4.1 Copy the nginx config

```bash
cp /opt/slimemarket/nginx/slimemarket.conf /etc/nginx/sites-available/slimemarket
```

Edit it and replace `YOUR_DOMAIN.COM` with your real domain:

```bash
sed -i 's/YOUR_DOMAIN.COM/yourdomain.com/g' /etc/nginx/sites-available/slimemarket
ln -sf /etc/nginx/sites-available/slimemarket /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### 4.2 Obtain SSL certificate

```bash
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Follow the prompts. Certbot auto-edits the nginx config to add SSL lines.

### 4.3 Auto-renewal test

```bash
certbot renew --dry-run
```

Renewal is usually auto-enabled via systemd timer. Verify:

```bash
systemctl status certbot.timer
```

---

## 5. First deploy

```bash
cd /opt/slimemarket
bash scripts/deploy-vps.sh
```

The script:
1. Checks `.env.production` for missing placeholders
2. Builds the Docker image (`docker compose build web`)
3. Starts `web` + `scheduler` containers
4. Polls `/api/health` until it returns 200 or 503
5. Prints container status

Typical output:

```
[DEPLOY] Building Docker image (this may take 2–5 minutes)...
[DEPLOY] Bringing up web + scheduler...
[DEPLOY] Waiting for /api/health (max 120s)...
[DEPLOY] Health endpoint responded HTTP 200 after 18s.
[DEPLOY] Fetching health details...
{
  "name": "SlimeMarket API",
  "status": "ok",
  "version": "0.1.0",
  "chain": "arc-testnet",
  "chainId": 5042002,
  ...
}
```

### 5.1 If health stays DEGRADED

A `503` on first boot is **normal** if the indexer hasn't run yet.  
Wait 1 minute, then check again:

```bash
curl -s http://127.0.0.1:3000/api/health | jq .
```

If `checks.db` is red → Supabase URL/key is wrong.  
If `checks.redis` is red → Upstash URL/token is wrong.  
If `checks.escrow` is red → `ESCROW_CONTRACT_ADDRESS` is wrong or RPC unreachable.  
If `checks.circle` is red → `CIRCLE_API_KEY` is wrong or network issue.

### 5.2 Verify from the public internet

```bash
curl -s https://yourdomain.com/api/health | jq .
```

Should return the same JSON as above, plus `status: "ok"`.

---

## 6. Post-deploy checklist

| Step | Command / Action | Expected result |
|---|---|---|
| **Health** | `curl https://yourdomain.com/api/health` | `status: "ok"`, all 7 checks green |
| **WebSocket** | Open the app in browser, check Network → WS | No 403 on `_next/webpack-hmr` (dev only) |
| **Signup OTP** | Register a new user | Email arrives, PIN gate appears |
| **Onboarding** | Set PIN + security questions | Success, wallet created |
| **List item** | Create a product listing | Appears in browse |
| **Buy flow** | Start checkout → pay → confirm | USDC leaves buyer, `on_chain_status: ESCROW` |
| **Auto-release** | Wait 42h OR admin release | Seller receives `price - 2%` |
| **Webhook** | `npm run webhook:list` (from VPS) | Subscription active, pointing to `https://yourdomain.com/api/webhooks/escrow` |
| **Cron jobs** | `docker compose logs -f scheduler` | Jobs firing every 1–5 minutes, no 401s |

---

## 7. Circle Console — production webhook

The escrow webhook **must** point to your stable HTTPS domain, not a tunnel.

```bash
cd /opt/slimemarket
node scripts/setup-webhook-subscription.mjs --create https://yourdomain.com
```

Verify:

```bash
npm run webhook:list
```

If you previously used `npm run tunnel` (Cloudflare quick tunnel), delete those old subscriptions:

```bash
# The setup script auto-deletes *.trycloudflare.com subs, but verify:
npm run webhook:list
```

---

## 8. Monitoring & maintenance

### 8.1 View logs

```bash
# Web app
docker compose logs -f web

# Scheduler (cron jobs)
docker compose logs -f scheduler

# Nginx access log
tail -f /var/log/nginx/slimemarket.access.log
```

### 8.2 Update the app (subsequent deploys)

```bash
cd /opt/slimemarket
git pull origin main
bash scripts/deploy-vps.sh
```

> If `.env.production` changed (new vars), restart to pick them up:  
> `docker compose --env-file .env.production up -d`

### 8.3 Restart a single service

```bash
docker compose restart web
docker compose restart scheduler
```

### 8.4 Enter a running container

```bash
docker compose exec web sh
# Inside: you can run node -e "..." or inspect the filesystem
```

### 8.5 Disk space warning

Docker images grow over time. Clean up monthly:

```bash
docker system prune -a --volumes -f
```

> This deletes unused images AND volumes. Make sure you don't have important data in unnamed volumes.

---

## 9. Backup & disaster recovery

### 9.1 Database

Supabase Cloud auto-backs up daily (free tier: 7 days retention).  
For extra safety, export manually before major changes:

```bash
# From local machine
supabase db dump --db-url "postgres://postgres:[password]@db.<ref>.supabase.co:5432/postgres" -f backup.sql
```

### 9.2 .env.production

Keep an **offline copy** (password manager or encrypted USB).  
If you lose it, you lose access to Circle wallets, Supabase admin, and the deployer key.

### 9.3 Deployer key

`.secrets/deployer.key` is on your local machine.  
Without it, you cannot deploy contract upgrades or emergency pause. Back it up offline.

---

## 10. Rollback

### 10.1 Code rollback

```bash
cd /opt/slimemarket
git log --oneline -5
git reset --hard <PREVIOUS_COMMIT>
bash scripts/deploy-vps.sh
```

### 10.2 Database rollback

Supabase Cloud has Point-in-Time Recovery (PITR) on paid tiers.  
On free tier: restore from your manual `.sql` dump.

### 10.3 Emergency pause (contract)

If a critical bug is found after launch:

```bash
node --env-file=.env.production --import tsx scripts/pause-escrow.ts
```

> The contract has a `requestPause` / `pause` delay. Know the exact delay by checking `verify-escrow-deploy.ts` output.

---

## 11. Alternative: PM2 (non-Docker)

If you prefer **not** to use Docker, the repo already has `ecosystem.config.cjs`:

```bash
# On the VPS (requires Node 22 + npm install)
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # run the printed command once
```

**Why Docker is recommended:**
- Reproducible builds (same image locally and on VPS)
- Health checks built into the image
- Easier to manage secrets via `.env.production` only
- No Node version conflicts

**When PM2 makes sense:**
- You need to edit code directly on the VPS and hot-reload
- RAM is extremely tight (< 2 GB) and you can't afford Docker overhead

---

## 12. Troubleshooting

### Build fails with `ERESOLVE` or peer dep errors

Already fixed by `.npmrc` + `legacy-peer-deps=true`.  
If it still happens: make sure `.npmrc` is copied into the build context (Dockerfile line 31).

### `next build` hangs or dies at "trace"

Disk full. Free up space:

```bash
docker system prune -a -f
npm cache clean --force
rm -rf .next
```

### Scheduler fires 401 on every job

`INDEXER_CRON_SECRET` / `CRON_SECRET` is wrong, OR the cron route is not whitelisted in `lib/security/route-classification.ts`.  
Check: `docker compose logs scheduler | grep FAIL`

### Emails go to spam

SPF + DKIM records for your domain are missing. Add Spacemail's DNS records (they provide them in the dashboard).

### Buyer pays but order stays `PENDING`

1. Check `/api/health` → `indexer` lag. If > 5000 blocks, the indexer is behind.
2. Check `docker compose logs scheduler | grep indexer`
3. Check Circle webhook is delivering: `npm run webhook:list`

---

## 13. Security hardening checklist

- [ ] `ufw` active, only 22/80/443 open
- [ ] fail2ban running (`systemctl status fail2ban`)
- [ ] `.env.production` readable only by root/deploy (`chmod 600`)
- [ ] No real secrets in git history (`git log -p | grep -i secret` → empty)
- [ ] Domain DNS has A + AAAA (if IPv6 enabled) pointing to VPS
- [ ] Certbot auto-renewal verified (`certbot renew --dry-run`)
- [ ] SSH key auth only (disable password login in `/etc/ssh/sshd_config`)
- [ ] VPS provider firewall (if any) also restricts to 22/80/443
- [ ] `NEXT_PUBLIC_APP_URL` matches the real HTTPS domain exactly
- [ ] Circle webhook subscription points to `https://` (not `http://`)

---

## Quick reference card

```bash
# Deploy
cd /opt/slimemarket && bash scripts/deploy-vps.sh

# Logs
docker compose logs -f web
docker compose logs -f scheduler

# Health
curl -s https://yourdomain.com/api/health | jq .

# Restart
docker compose restart web

# Enter container
docker compose exec web sh

# Update + redeploy
git pull && bash scripts/deploy-vps.sh
```
