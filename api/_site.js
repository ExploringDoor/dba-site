// Which website this deployment is.
// This site and the Lower Merion Aces site (aces-basketball) share ONE Firestore database and ONE Stripe account. Every
// registration, pledge and order is tagged with the site that took it (record.site and the Stripe
// checkout's metadata.site), and the AUTOMATIC paths (Stripe webhook, reconcile + reminder crons)
// only touch their own site's records. Without this, whichever site got there first would send
// the family a receipt in the wrong branding with links to the wrong website.
// Untagged records (everything taken before the tag existed) belong to Downer.
// Manual admin actions (refund, cancel, sync, send pay-links) still work on every record.
export const SITE_TAG = 'downer';
const tagOf = (v) => String(v || 'downer');
export const ownsRecord = (rec) => tagOf(rec && rec.site) === SITE_TAG;
export const ownsSession = (s) => tagOf(s && s.metadata && s.metadata.site) === SITE_TAG;
