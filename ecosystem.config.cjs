/**
 * PM2 process manager config — self-hosted VPS deployment.
 *
 * Two processes:
 *   slimemarket-web   → `next start` (the HTTP app, port 3000)
 *   slimemarket-cron  → `node scripts/scheduler.js` (the 8 cron jobs, replaces Vercel crons)
 *
 * WHY a separate cron process: `npm start` does NOT run the scheduler. On Vercel
 * the crons were declared in a PaaS config; on a VPS nothing runs them unless we
 * start this second process. Without it the escrow indexer, auto-release and
 * reconcile jobs never fire.
 *
 * USAGE (on the VPS, after `npm run build`):
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup            # prints a command — run it once to survive reboots
 *
 * Env is loaded from `.env.production` (gitignored, created from
 * `.env.example`) right here, so you do NOT need to `source` it
 * before `pm2 start`. After editing `.env.production`, apply with:
 *   pm2 restart ecosystem.config.cjs --update-env
 */

const fs = require("node:fs");
const path = require("node:path");

/** Minimal .env parser (KEY=VALUE, # comments, optional surrounding quotes). */
function loadEnvFile(file) {
  const out = {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // .env.production absent — PM2 will still start, but the app will be
    // misconfigured. The /api/health endpoint reports what is missing.
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(__dirname, ".env.production"));
const PORT = fileEnv.PORT || process.env.PORT || "3000";

module.exports = {
  apps: [
    {
      name: "slimemarket-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p " + PORT,
      cwd: __dirname,
      env: { ...fileEnv, NODE_ENV: "production", PORT: String(PORT) },
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "800M",
      kill_timeout: 10000,
    },
    {
      name: "slimemarket-cron",
      script: "scripts/scheduler.js",
      cwd: __dirname,
      env: {
        ...fileEnv,
        NODE_ENV: "production",
        // The scheduler calls the web app over loopback (same host).
        INTERNAL_API_URL: `http://127.0.0.1:${PORT}`,
      },
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "200M",
    },
  ],
};
