# Publish CurrentGiya.lk

Use **one Railway service with one persistent volume** for this version. The Dockerfile runs Node.js 24 and serves both the dashboard and API. The shared reports, chat, hashing salt and push subscriptions live in JSON files, so the app needs a continuously running Node process and writable storage. A GitHub Pages upload or a standard static Vercel deployment cannot run this backend.

This guide prepares a public deployment; no hosting account, repository or domain has been created automatically. Railway bills compute, network traffic and volume storage according to your plan and usage. Review its [current pricing](https://docs.railway.com/pricing/plans) and set a spending limit before going live.

## 1. Put the project on GitHub

1. Run `npm ci` and `npm test` locally.
2. Create a GitHub repository and upload the project files, including `Dockerfile`, `.dockerignore`, `package-lock.json`, `lib/`, `data/` and `scripts/`. The repository can be public or private if your connected account grants Railway access.
3. Keep `.env`, `.data/` and `node_modules/` out of the repository. They are already in `.gitignore`. Enter production secrets in Railway's Variables panel.

This folder does not yet contain Git history. After creating an empty repository on GitHub, run these commands locally (replace the example repository URL):

```sh
git init -b main
git add .
git commit -m "Build CurrentGiya outage dashboard"
git remote add origin https://github.com/YOUR_USERNAME/currentgiya.git
git push -u origin main
```

If your checkout already has Git history or an `origin`, reuse it instead of reinitializing or replacing the remote.

## 2. Create and configure the service

In the [Railway dashboard](https://railway.com/dashboard), choose **New Project → Deploy from GitHub repo**, connect your GitHub account and select the repository. Choose **Add Variables** so you can finish configuration before the first deployment. Railway documents this flow in its [GitHub quick start](https://docs.railway.com/quick-start).

Add these service variables:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |
| `DATA_DIR` | `/data` |
| `TRUST_PROXY` | `1` |
| `CLIENT_IP_HEADER` | `x-real-ip` |

These proxy settings are for Railway's **public HTTP networking**. Its [networking specification](https://docs.railway.com/networking/public-networking/specs-and-limits) defines `X-Real-IP` as the connecting client address and `X-Forwarded-Proto` as HTTPS. They let ISP lookup, independent vote checks, Secure cookies and request-origin checks work behind Railway's edge. Keep `TRUST_PROXY=0` for direct local access. Do not expose an additional TCP proxy or place untrusted services on a private route to this listener while trusting forwarding headers.

Configure the service Settings:

| Setting | Value |
| --- | --- |
| Builder | Dockerfile, using the root `Dockerfile` |
| Custom build command | Leave empty; the Dockerfile installs dependencies |
| Custom start command | Leave empty; the Dockerfile starts `node server.mjs` |
| Healthcheck path | `/api/health` |
| Healthcheck timeout | 60 seconds |
| Region | Singapore / Asia Southeast, if available for your plan |
| Replicas | 1, in one region |
| Serverless / application sleeping | Disabled, so scheduled push and notice jobs keep running |
| Restart policy | On failure |

Railway detects the root [Dockerfile](https://docs.railway.com/builds/dockerfiles). Set the [healthcheck](https://docs.railway.com/deployments/healthchecks) in the dashboard so a deployment is only promoted after the API starts successfully.

This project uses Dockerfile plus dashboard settings. Railway's [legacy configuration reference](https://docs.railway.com/config-as-code/reference) currently marks `railway.toml` and `railway.json` as deprecated, with legacy support ending on 1 December 2026; this guide therefore does not add either file.

## 3. Attach storage before deploying

On the project canvas, add a **Volume**, attach it to this service and set its mount path to **`/data`**, exactly matching `DATA_DIR`. Choose the smallest available capacity that fits your usage. Railway mounts volumes only when the service starts; the Dockerfile's empty `/data` directory does not provide persistence by itself. See [Railway volumes](https://docs.railway.com/volumes).

Keep **one replica**. Multiple Node processes would hold separate in-memory state and overwrite the JSON files. Enable volume backups through Railway and preserve the volume when redeploying; a new deployment does not need a fresh volume. Reports intentionally expire, but the hashing salt and current data should survive restarts. Scale to a shared database before adding replicas.

Click **Deploy**, then check the deployment logs for the listening message and a successful healthcheck.

## 4. Open the HTTPS site

Open **Settings → Networking → Public Networking → Generate Domain**. Set the domain's target port to **3000**. Open the generated `https://…up.railway.app` address. Railway documents domains and target ports in [Working with Domains](https://docs.railway.com/networking/domains/working-with-domains).

Check these behaviours:

- `/api/health` returns a healthy JSON response; `/` and `/lite.html` both load.
- On your phone, allow location access and submit a real report for an actual local issue. A first report remains unverified until five independent nearby addresses and devices report within three minutes.
- ISP lookup uses your public connection. It may identify a VPN or shared gateway.
- Chat stays locked until a verified nearby power incident exists. A new site has no sample reports.
- After a service restart, the `/data` volume remains attached and existing unexpired reports remain visible.

## 5. Enable the optional integrations

Basic reporting, weather forecasts and ISP detection do not require your own API keys. Background push and AI notice extraction do require configuration:

- **Background weather push:** generate a matching key pair locally with `npx web-push generate-vapid-keys`; set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and a real `VAPID_SUBJECT`, such as `mailto:you@currentgiya.lk`, in Railway. Keep the same key pair across deployments. Redeploy, then enable weather alerts in a supported browser.
- **Official notice extraction:** set `OPENAI_API_KEY` and comma-separated `NOTICE_SOURCE_URLS` containing current HTTPS notice pages or direct PDF/image links from the allowlisted CEB, LECO or Water Board domains. `OPENAI_NOTICE_MODEL` is optional. The running server imports configured notices daily. An empty or unavailable source produces no invented notices. API usage incurs separate charges.

Use the settings and limitations in [README.md](README.md) and [.env.example](.env.example). Put secrets in service Variables, never in HTML, JavaScript, a Docker build argument or a Git commit.

## 6. Connect currentgiya.lk

Register or use a domain you control. Under **Settings → Networking → Public Networking → Custom Domain**, enter `currentgiya.lk` and target port **3000**. Add **both** DNS records Railway provides: the routing `CNAME` (or the root-domain alias/flattening equivalent) and the ownership-verification `TXT`. Use Railway's exact names and values. The missing TXT record can leave the domain returning 404 even when routing is correct.

For the root `.lk` name, your DNS provider must support CNAME flattening or a dynamic ALIAS. If it does not, use a DNS provider that does, or publish `www.currentgiya.lk` with its own Railway custom-domain entry and CNAME/TXT records. Railway verifies the records and provisions the HTTPS certificate. Follow the current [custom-domain and apex DNS instructions](https://docs.railway.com/networking/domains/working-with-domains); no fixed server IP is needed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Site loads but reporting, weather and chat fail | Use the Railway URL or local `npm start` server; static Live Server cannot serve `/api/` routes. |
| HTTPS reports fail with an origin error | Confirm `TRUST_PROXY=1` on Railway, `CLIENT_IP_HEADER=x-real-ip`, and the public domain targets the correct service. |
| ISP detection fails or every visitor shares one vote | Confirm the proxy variables; direct local requests cannot identify a public ISP. Upstream lookup can also be unavailable. |
| Data disappears on deploy | Confirm a real Railway volume is attached at `/data` and `DATA_DIR=/data`. |
| Deployment cannot write `/data` | Use this Dockerfile's default user; Railway volumes are root-owned. Check the volume attachment and deployment logs. |
| Healthcheck fails / 502 | Check deployment logs, `HOST=0.0.0.0`, `PORT=3000`, the `/api/health` healthcheck and domain target port 3000. |
| Location is blocked on a phone | Use HTTPS and allow location in the browser/site settings. A laptop's LAN HTTP address is not a secure context. |
| Battery badge or push does not appear | Browser/OS support varies. Unsupported browsers show unavailable states; mobile background delivery needs OS permission and sometimes home-screen installation. |
| Official notices are empty | Configure current source URLs and `OPENAI_API_KEY`; confirm the original notice actually lists the selected area. |

## Optional local Docker check

```sh
docker build -t currentgiya-local .
docker run --rm --name currentgiya-local -p 3000:3000 -v currentgiya-test-data:/data currentgiya-local
```

Open `http://localhost:3000` and `http://localhost:3000/api/health`. Stop the container with Ctrl+C. The named Docker volume retains this test instance's data. Local Docker runs keep proxy trust off unless explicitly configured; Railway proxy variables belong in Railway's Variables panel.
