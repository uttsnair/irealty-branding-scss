// Third-party widgets embedded on agency sites (Google review badges, chat
// widgets, portal and payment logos) carry other companies' brand colours and
// logos. They must not be mistaken for the agency's brand.

// stylesheets / assets that belong to an embedded widget, wherever they're hosted
// (Trustindex, for one, writes its CSS into the site's own /wp-content/uploads/)
const WIDGET_RE = /trustindex|elfsight|trustpilot|ratemyagent|google-?(widget|reviews?)|reviews?-?(widget|slider|badge)|testimonial|tidio|intercom|livechat|drift|hubspot|zendesk|chat-?widget|cookie|consent/i;

// logos that are some other company's mark: review platforms, social networks,
// property portals, industry bodies, app stores, payment providers.
// Domains are matched on the hostname exactly (or a subdomain of it), never as a
// substring: "nextvisionrealestate.com.au" must not match "realestate.com.au".
const OTHER_BRAND_HOSTS = ['trustindex.io', 'elfsight.com', 'trustpilot.com', 'ratemyagent.com.au', 'ratemyagent.com',
  'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'facebook.com', 'fbcdn.net', 'instagram.com',
  'linkedin.com', 'licdn.com', 'youtube.com', 'ytimg.com', 'twitter.com', 'twimg.com', 'tiktok.com', 'pinterest.com',
  'apple.com', 'realestate.com.au', 'reastatic.net', 'domain.com.au', 'domainstatic.com.au', 'homely.com.au',
  'allhomes.com.au', 'openagent.com.au', 'paypal.com', 'afterpay.com'];
// file-name keywords for those marks when a site hosts a copy itself
const OTHER_BRAND_FILE_RE = /(^|[^a-z])(google|facebook|instagram|linkedin|youtube|twitter|tiktok|pinterest|whatsapp|trustpilot|ratemyagent|trustindex|app-?store|play-?store|google-?play|visa|mastercard|paypal|afterpay|rea-?logo|domain-?logo|reiq|reinsw|reiv|reiwa)([^a-z]|$)|\/platform\//i;

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'asn', 'id', 'co']);
function siteKey(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  const n = parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}
// same registrable domain (so cdn.agency.com.au counts as the agency's own)
function sameSite(url, base) {
  try { return siteKey(new URL(url).hostname) === siteKey(new URL(base).hostname); } catch (e) { return false; }
}
function isOtherBrandLogo(url) {
  let u; try { u = new URL(url); } catch (e) { return false; }
  const host = u.hostname.toLowerCase();
  if (OTHER_BRAND_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true;
  return OTHER_BRAND_FILE_RE.test(decodeURIComponent(u.pathname));
}
function isWidgetAsset(url) { return WIDGET_RE.test(url || ''); }

module.exports = { isOtherBrandLogo, isWidgetAsset, sameSite, siteKey };
