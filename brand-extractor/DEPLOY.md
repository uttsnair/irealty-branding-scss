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

| Field | How it's guessed | Reliability |
|---|---|---|
| **Primary colour** | `theme-color` meta tag first, otherwise the most-used non-neutral colour in the CSS | Good when a theme-color exists; otherwise a guess — check it |
| **Secondary colour** | The next most-used brand colour | Often needs correcting |
| **Palette** | Top ~14 colours by frequency | Use these as click-to-set options if the guess is wrong |
| **Heading / body font** | Google Fonts links + `font-family` on `h1/h2` vs `body/p` | Good when Google Fonts are used |
| **Logo** | Images in the header/nav, or any image with "logo" in its name, then og:image, then favicon | Usually right; sometimes grabs the wrong image |

It's intentionally **best-guess** — the tool shows the guesses and lets the user fix them. In the tool: **click a palette swatch** to set it as primary, **right-click** to set it as secondary; **click a font chip** to use it as the heading font, **right-click** for body.

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
