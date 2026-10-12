// Recognise pages that are NOT the agency's website: bot walls, security
// checkpoints, error pages and parked domains. Reading "brand colours" off one of
// these is how the extractor used to return Vercel blue for McGrath and a
// Cloudflare-page green for Belle Property and hockingstuart.
//
// We never try to get past these — we stop and tell the user to supply the logo or
// brand guide instead.

// `re` matches anywhere in the title or page head. `thin` are vendor script markers that
// also get injected into perfectly normal pages (Cloudflare bot management, DataDome,
// PerimeterX), so they only count on a small, challenge-sized page.
const RULES = [
  { reason: 'cloudflare', re: /just a moment\.\.\.|attention required! \| cloudflare|checking (if the site connection is secure|your browser)/i,
    thin: /cf-chl-|cf_chl_opt|challenge-platform/i,
    message: 'This website is protected by a Cloudflare bot check, so it can\u2019t be read automatically.' },
  { reason: 'vercel', re: /vercel security checkpoint/i,
    message: 'This website is protected by a Vercel security checkpoint, so it can\u2019t be read automatically.' },
  { reason: 'bot-wall', re: /verify (that )?you are (a )?human|are you a robot|pardon our interruption|incapsula incident|sucuri website firewall|access to this page has been denied/i,
    thin: /px-captcha|perimeterx|datadome|captcha-delivery|ddos protection by/i,
    message: 'This website shows a bot check to automated visitors, so it can\u2019t be read automatically.' },
  { reason: 'parked', re: /parked domain|this domain (is|may be) for sale|domain is parked|registered at hostinger|parkingcrew|sedoparking|godaddy\.com\/domainsearch|buy this domain|domain has expired|account (has been )?suspended|default web site page|welcome to nginx!|it works!<\/h1>|apache2 (ubuntu|debian) default page/i,
    message: 'That address shows a parked, expired or default hosting page rather than the agency\u2019s site. Check the website address.' },
];
const THIN_PAGE_BYTES = 25000;

const ERROR_TITLE_RE = /^\s*(403|404|410|429|500|502|503)\b|forbidden|access denied|not found|request (could not be satisfied|blocked)|service unavailable|bad gateway|error\s*\d{3}/i;

// Returns null when the page looks like a real website, else { reason, message }.
function detectBlockedPage(status, html, title) {
  html = html || '';
  title = (title || '').trim();
  // only scan the head + start of body: real sites can mention "captcha" in a form far down
  const head = html.slice(0, 60000);
  const thin = html.length < THIN_PAGE_BYTES || status >= 400;
  for (const r of RULES) {
    if (r.re.test(title) || r.re.test(head) || (thin && r.thin && r.thin.test(head))) return { reason: r.reason, message: r.message };
  }
  if (status === 401 || status === 403 || status === 429) {
    return { reason: 'forbidden', message: 'The website refused the request (HTTP ' + status + '). It probably blocks automated tools.' };
  }
  if (status >= 400) {
    return { reason: 'http-' + status, message: 'The website returned an error (HTTP ' + status + ').' };
  }
  if (ERROR_TITLE_RE.test(title) && html.length < 30000) {
    return { reason: 'error-page', message: 'The website returned an error page (“' + title.slice(0, 60) + '”).' };
  }
  return null;
}

module.exports = { detectBlockedPage };
