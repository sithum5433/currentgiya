# CurrentGiya.lk

A practical community outage dashboard for Sri Lanka. Vanilla HTML/CSS/JavaScript frontend, a Node.js API, persistent shared reports, and a separate Lite page. The shop and simulated activity have been removed. A new installation starts with zero reports.

## Run locally

Requires Node.js 20.19 or newer and npm.

```sh
npm install
npm start
```

Open **http://localhost:3000**. If that port is occupied, run `PORT=3001 npm start`. Use the Node server rather than opening `index.html` directly or using a static Live Server: shared reporting, forecasts and chat need the API. `npm run dev` restarts the server on source changes.

If dependencies are already installed and your terminal cannot find npm, start directly with `node --env-file-if-exists=.env server.mjs`. Keep that terminal running while using the app.

The standard dashboard is `/`; the dependency-free lightweight version is `/lite.html`. Save-Data and 2G connections automatically enter Lite mode; `/?full=1` explicitly opens the full version. Location, battery, notifications and service workers need HTTPS in production; localhost works for development.

## If a feature looks unavailable

| Symptom | What to do |
| --- | --- |
| Page opens but reports, weather, chat or counters fail | Run `npm start` and open the address printed by Node. Opening the HTML file or using VS Code Live Server does not start the API. |
| Location works but reporting is blocked | An approximate reading can browse the map and weather. Reports and chat need a location accurate to 200 m; enable precise location on a phone and retry. |
| Chat stays locked | It opens only within 3 km of a verified power outage. Five different devices and network addresses must report within 3 minutes. Testing alone or on one shared Wi-Fi network will not meet that rule. |
| Weather notifications ask for server setup | Copy `.env.example` to `.env`, generate VAPID keys and complete the three VAPID values. Restart Node. Use HTTPS in production and a supported browser. |
| Official notices are empty | Configure `OPENAI_API_KEY` and current `NOTICE_SOURCE_URLS`. Notices must explicitly list the selected area. No sample notices are invented. |
| Battery badge says unavailable | This browser does not expose the Battery API; other features continue to work. |
| SMS or call button does nothing on a laptop | These need an installed native handler. Use **Copy draft**, or open the page on your phone. |
| An older page still appears after an update | Close old tabs and reload. If necessary, clear the site's cached data/service worker in browser settings. Saved local account numbers may be removed if you clear all site storage. |

## Publish it

A Node server and persistent storage are required. The included [Dockerfile](Dockerfile) is ready for Railway; follow the complete [publishing guide](DEPLOYMENT.md) for GitHub upload, a `/data` volume, proxy variables, healthchecks, HTTPS and your `.lk` domain. No site has been published automatically.

## Project files

| Path | Responsibility |
| --- | --- |
| `index.html`, `style.css`, `app.js` | Accessible responsive dashboard, interactive street map, network diagnostics, reports, chat, alerts, SMS drafts, story graphics |
| `lite.html` | Self-contained low-data dashboard; no external fonts, tiles, images or libraries |
| `server.mjs` | HTTP server, private device cookies, request validation, rate limits, static compression, API routes |
| `lib/outages.mjs` | Geospatial grouping, independent report verification, ephemeral chat, restoration quorum, daily rankings |
| `lib/districts.mjs`, `data/` | Offline district lookup using attributed geoBoundaries district polygons |
| `lib/integrations.mjs` | Real ISP lookup, live forecast, area notices, optional Web Push and scheduled jobs |
| `scripts/refresh-notices.mjs` | Official-domain HTML/PDF/image notice extraction through the OpenAI API |
| `service-worker.js`, `manifest.webmanifest` | Offline page shell from the first Lite visit and push notifications; live API responses are never cached |
| `tests/` | Domain, HTTP, integration, district and browser checks |

## Behaviour

- **Precise reports:** approximate browser locations can centre the map and weather; reporting needs a browser location accurate to 200 m or better. Town selection is for browsing. Public report coordinates are rounded to approximately 100 m; exact coordinates are private to the server's grouping logic.
- **5-tap rule:** five independent network addresses **and** devices within 1 km must report the same category within a three-minute window. A report starts unverified. Verified incident status remains stable until that incident expires or is restored. Shared Wi-Fi or carrier NAT can reduce the number of independent votes.
- **Street patterns:** reports use 100 m microclusters. One cluster suggests a local street fault; geographically separated clusters suggest a broader area outage. These are geographic estimates, not electrical phase or transformer identification.
- **Kaluware chat:** unlocks within 3 km of a verified power incident and is removed when that incident is restored or expires. Messages are anonymous, escaped for display, rate limited and limited to 200 characters. Supported browsers attach actual battery readings and update the sender's live room badges as battery readings change.
- **Current awa:** three independent restoration reports newer than the latest outage report clear the incident. An armed tab sounds a tone only after three confirmations within 1 km of its location. Keep the tab open and device awake; mobile operating systems can suspend or delay tab audio.
- **Daily shame board:** ranks the day's real power reports by spatially determined district and real internet reports by server-resolved ISP. The day follows Asia/Colombo time. The exported 1080×1920 PNG can be shared through the native share sheet or downloaded. Report volume is not an official reliability assessment.
- **Network checks:** four HTTP probes allow up to three seconds per response, with staggered starts, so a slow but usable connection is not labelled unreachable. These measure response time and failed HTTP checks to this server. Browsers cannot directly measure packet loss or determine that a connection is specifically fibre or 4G. Provider lookup uses the request's public IP/ASN and may reflect a VPN or gateway. Localhost cannot supply a public client ISP.
- **Low data:** the complete initial Lite HTML, worker and manifest are under 20 KB uncompressed; static responses support gzip/Brotli. Lite requests a compact status response, pauses polling when hidden and backs off on errors. Initial load time depends on the connection; no unconditional sub-second 2G claim is made. Main map tiles are requested only for the visible viewport and are excluded from offline caches.
- **Private utility accounts:** optional CEB/Water Board account numbers remain in browser `localStorage` and never appear in API payloads. The dialog opens the native SMS app with an editable plain-text draft, copies the draft on desktops, or calls the official hotline. Message sending always remains with the user.

## Optional integrations

Copy `.env.example` to `.env`, then restart the server after changing configuration.

**Weather and ISP:** work without keys through [Open-Meteo](https://open-meteo.com/en/docs) and [ipwho.is](https://ipwhois.io/documentation). Forecast warnings use current or next-hour thunderstorm weather codes. They are not live lightning tracking, a 30-minute arrival prediction, or a guaranteed outage prediction. Provider detection and forecasts show unavailable states when the source fails.

**Background weather push:** generate a matched VAPID pair with `npx web-push generate-vapid-keys`, and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. Visitors opt in from the dashboard and can disable alerts there. Subscriptions retain the selected coordinates/area for server checks every 15 minutes while the server runs, even after the tab closes. Storm notifications are deduplicated for an hour; expired subscriptions are removed. Delivery depends on browser and OS support. iOS generally requires installing the page on the home screen. The server allowlists legitimate browser push services.

**AI notice extraction:** set `OPENAI_API_KEY`, optional `OPENAI_NOTICE_MODEL`, and comma-separated `NOTICE_SOURCE_URLS` pointing to actual HTTPS notice pages or direct documents on `ceb.lk`, `leco.lk`, or `waterboard.lk`. The running server refreshes daily; `npm run notices` performs an immediate refresh. The importer bounds downloads and document count, checks redirects, extracts HTML/PDF/images with a strict structured schema, retains source links, rejects invalid dates, and preserves current records from failed sources. JavaScript-only portals may need direct document URLs. API usage can incur charges. Imported text is area matched only when the official document explicitly lists that name; matching does not infer adjacent towns or unlisted translations. Extraction can be imperfect, so the UI links the original. No key or source configured means no invented notices.

## Privacy and deployment

`.data/` stores reports, a random hashing salt, short-lived hashed identities, temporary chat, anonymous daily scores, imported notices and opted-in push subscriptions. `.env` and `.data/` are ignored by Git and cannot be served by the static router. Raw client IPs and utility account numbers are not persisted. Device cookies are HttpOnly/SameSite and use Secure over HTTPS.

This implementation uses atomic JSON persistence for **one Node process**. Use a persistent writable volume; do not run several replicas against the JSON files. A national production rollout needs database storage, distributed rate limiting, capacity planning, and an appropriate tile/provider agreement. Browser GPS and device cookies are client claims, so they reduce casual spam without proving physical presence or stopping coordinated abuse. Reports expire after two hours; restoration confirmations after fifteen minutes; anonymous leaderboard history after forty-eight hours. Old chat is physically removed on incident closure.

Only set `TRUST_PROXY=1` behind a proxy you control that **replaces**, rather than appends to, untrusted `X-Forwarded-For` and sets `X-Forwarded-Proto`. On Railway public HTTP networking, use `TRUST_PROXY=1` with `CLIENT_IP_HEADER=x-real-ip`, as detailed in [DEPLOYMENT.md](DEPLOYMENT.md). `CLIENT_IP_HEADER` accepts only `x-real-ip` or `x-forwarded-for` and is ignored when proxy trust is off. Otherwise keep proxy trust off. Configure HTTPS at that proxy and a durable `DATA_DIR`. No server API key is included in frontend assets.

## Verification

```sh
npm test
```

The tests use temporary storage and mocked upstream integrations. They cover independent vote counts, time and distance thresholds, restoration replay, room expiry, district lookup, private identities, HTTP validation, push ownership, forecast bounds, and notice extraction/matching. No live OpenAI request or notification delivery is needed for the suite.

The optional browser smoke script uses Playwright installed in your environment:

```sh
BASE_URL=http://localhost:3000 PLAYWRIGHT_PATH=/path/to/playwright node tests/browser-smoke.cjs
BASE_URL=http://localhost:3000 PLAYWRIGHT_PATH=/path/to/playwright node tests/client-regressions.cjs
BASE_URL=http://localhost:3000 PLAYWRIGHT_PATH=/path/to/playwright node tests/lite-regressions.cjs
```

Browser tests suppress external map tile traffic and use isolated browser contexts. Do not point the script at a public production service.

## Sources and attribution

[CEB](https://ceb.lk/contactus) confirms the 1987 call centre, and the [Water Board](https://www.waterboard.lk/contact/) lists 1939. A breakdown SMS syntax was not verified from official sources. The UI therefore describes its message as a plain-text draft, never a confirmed utility SMS submission format.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Tiles follow the [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) and use normal browser caching with visible attribution. For commercial/high-volume deployment, configure a suitable tile service and its CSP allowance. District boundary provenance, licensing and pinned source are in [data/README.md](data/README.md).
