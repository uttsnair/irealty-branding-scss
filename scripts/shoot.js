// Ground-truth helper: screenshot the top of each site with local Chrome.
// Usage: node scripts/shoot.js <outDir> site1 site2 ...
const puppeteer = require('puppeteer-core');
const [outDir, ...sites] = process.argv.slice(2);
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  await Promise.all(sites.map(async (s) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    try {
      await page.goto('https://' + s, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      await page.screenshot({ path: `${outDir}/${s}.jpg`, type: 'jpeg', quality: 60 });
      console.log('ok', s);
    } catch (e) { console.log('fail', s, e.message); }
    await page.close();
  }));
  await browser.close();
})();
