# Brand Extractor — Deploy Guide

This is the small backend that lets Brand Studio read a company website and guess its colours, fonts, and logo. It's one Vercel serverless function. You deploy it once, paste the resulting URL into the Brand Studio HTML file, and you're done.

**Why a backend at all?** Browsers block a local HTML file from fetching other websites (CORS). The backend does the fetching and hands clean data back to the tool.

---

## What's in this folder

```
brand-extractor/
├── api/
│   └── extract.js      ← the serverless function (the whole engine)
├── package.json        ← one dependency: cheerio (HTML parser)
├── vercel.json         ← sets the function timeout
└── DEPLOY.md           ← this file
```

You do **not** need to edit any of these to deploy.

---

## Prerequisites

- A **Vercel account** (free tier is fine): https://vercel.com/signup
- Node.js installed locally (only needed for the CLI method): https://nodejs.org

Pick **one** of the two methods below.

---

## Method A — Vercel CLI (fastest, ~3 minutes)

1. Install the CLI (one time):
   ```
   npm install -g vercel
   ```

2. From inside this `brand-extractor` folder, run:
   ```
   vercel
   ```
   - It'll ask you to log in (browser opens once).
   - Accept the defaults: link to a new project, name it e.g. `brand-extractor`.
   - It deploys a preview and prints a URL.

3. Promote it to production (gives you a stable URL):
   ```
   vercel --prod
   ```

4. Copy the production URL it prints — something like:
   ```
   https://brand-extractor.vercel.app
   ```
   **This is your API base URL.** Keep it handy for the next section.

---

## Method B — GitHub + Vercel dashboard (no CLI)

1. Put this `brand-extractor` folder in a GitHub repo (push it up).
2. Go to https://vercel.com/new
3. Click **Import** on your repo.
4. Leave all settings at default (Vercel auto-detects the `api/` function).
5. Click **Deploy**.
6. When it finishes, copy the project's domain — e.g. `https://brand-extractor.vercel.app`. **This is your API base URL.**

---

## Connect the tool to your API

1. Open `iRealty_Brand_Studio.html` in any text editor (VS Code, Notepad, TextEdit).
2. Near the top of the `<script>`, find this line:
   ```js
   const API_BASE = "https://YOUR-DEPLOYMENT.vercel.app";
   ```
3. Replace it with your real URL from above:
   ```js
   const API_BASE = "https://brand-extractor.vercel.app";
   ```
   (No trailing slash needed — the tool handles it either way.)
4. Save the file. Re-distribute this updated HTML to the team.

That's it. The "Pull from website" box at the top of the tool is now live.

---

## Test it

1. Open the updated `iRealty_Brand_Studio.html`.
2. In **Pull from website**, type a real estate site (e.g. `raywhite.com.au`) and click **Analyze website**.
3. Within a few seconds the colour, font, logo and palette fields should populate.
4. Review and correct anything that looks off, then carry on as normal.

You can also test the API directly in a browser:
```
https://brand-extractor.vercel.app/api/extract?url=raywhite.com.au
```
It should return JSON with `primary`, `secondary`, `palette`, `headFont`, `bodyFont`, `logo`, etc.

---

## How it guesses (so you know what to trust)

Colours are ranked by **where the site uses them**, not by how often a hex code appears in the CSS:

| Evidence | Weight | Why |
|---|---|---|
| **Logo pixels** (PNG/JPG/WebP/SVG, read with `sharp`) | Strongest — and it referees: colours in the logo are boosted, colours not in it are discounted | The logo is the brand |
| **Theme colour settings** — CSS variables named `--primary`, `--brand`, `--accent`, Elementor globals | Strong | The theme's own declared brand colour |
| **Buttons, header/menu bar** backgrounds | Strong | Where agencies put their brand colour |
| Footer, headings, links | Medium | |
| Everything else in the theme CSS | Weak, capped | |
| Framework / page-builder / Tailwind / Bootstrap / social-widget defaults, alerts, badges, cookie banners | Heavily discounted | These were the main source of wrong colours |

Near-identical shades are merged (so `#00aeef` and `#00adef` count as one). The secondary must be a genuinely different colour; charcoal/black counts when it's in the logo or used as a background. The response includes `confidence` (high/medium/low), `primarySources`/`secondarySources`, `paletteDetail` (each swatch with where it was found) and `warnings`.

**Blocked sites:** if the site answers with a Cloudflare/Vercel bot check, a 403/429, an error page or a parked domain, the API returns HTTP 422 with `blocked` set and a message telling the user to upload the logo or brand guide instead. It no longer reads colours off those pages (that is how McGrath used to come back as Vercel blue). The extractor identifies itself honestly and does not try to get past bot checks.

**Reading a blocked site from the user's browser:** the Studio shows a *Read site for Brand Studio* bookmark (in the *Pull from website* panel and in the blocked-site message). The user drags it to their bookmarks bar, opens the agency's site and clicks it. `public/studio/collector.js` then reads the page as their browser shows it (computed header/button/footer/heading/link colours with element sizes, `:root` brand variables, `theme-color`, logo pixels or inline-SVG fills when the browser allows it, fonts) and form-POSTs that to `POST /api/extract-from-page` in a new tab. That endpoint (`lib/page-evidence.js`) ranks it with the same evidence model and returns the same shape as `GET /api/extract`; its hand-off page passes the result to an open Studio tab (BroadcastChannel) or opens the Studio with it (sessionStorage). Nothing goes in a URL, and the server never contacts the agency's site except to try a logo image the browser couldn't read. If a site forbids form posts (CSP `form-action`), the bookmark copies the data instead and the user clicks *Paste page data*. Logos on another domain (e.g. a CDN) usually can't be read by the browser either, so the result warns and colours come from the page styling.

Fonts and logo candidates work as before (Google Fonts links + `font-family` on headings vs body; header/nav images, "logo" images, then icons).

To check a change against real sites: `node scripts/run-extract.js raywhite.com.au century21.com.au ...`, `node scripts/debug-site.js <site>` for the full evidence table, and `npm test` for the unit checks. `npm run dev` serves the studio and API locally on port 3055.

---

## Notes & limits

- **Free tier is plenty.** This is a read-only scraper hit a few times a day. Vercel's free tier covers it easily.
- **The endpoint is public.** Anyone with the URL can call it. That's fine for an internal read-only tool, but if you'd rather lock it down, you can add a shared secret: have the function check `req.query.key` against an environment variable, and append `&key=...` in the tool's fetch call. Ask if you want this added.
- **CORS is open (`*`) on purpose** so the local HTML file (which has no fixed origin) can call it. Don't remove that header or the tool can't reach the API.
- **Some sites won't extract well** — heavy JavaScript sites that render colours/fonts client-side, or sites that block bots. When that happens the tool just says so and the user enters the brand manually. Nothing breaks.
- **The logo is for reference only.** It is not stored in the SCSS — the user still uploads the logo to the platform separately. The tool shows it so they can grab the URL and confirm the brand.

---

## Updating the function later

Edit `api/extract.js`, then redeploy:
- CLI: `vercel --prod`
- GitHub method: just push to your main branch — Vercel redeploys automatically.

The tool's `API_BASE` doesn't change, so no need to touch the HTML again.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tool says "Extraction API not configured yet" | You didn't set `API_BASE` in the HTML file. See "Connect the tool to your API". |
| Tool says "Couldn't read that site" | The site blocked the bot or rendered everything in JS. Enter the brand manually — it's a graceful fallback. |
| Browser console shows a CORS error | The `Access-Control-Allow-Origin: *` header is missing — make sure you deployed the unmodified `extract.js`. |
| Deploy fails on Vercel | Check that `package.json` is present and lists `cheerio`. Vercel installs it automatically. |
| The API URL returns 404 | The path is `/api/extract` (not `/extract`). Vercel maps `api/extract.js` to `/api/extract`. |
