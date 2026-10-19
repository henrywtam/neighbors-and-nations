/**
 * create-pc-webhook.js
 *
 * Subscribes this app to Planning Center's form-submission webhook and prints
 * the authenticity secret to put in PLANNING_CENTER_WEBHOOK_SECRET.
 *
 * Usage:
 *   node scripts/create-pc-webhook.js https://<your-app>/webhooks/planning-center
 *
 * (Equivalent to adding the subscription by hand in Planning Center → Webhooks.)
 */

import 'dotenv/config';

const EVENT = 'people.v2.events.form_submission.created';

async function main() {
  const url = process.argv[2];
  if (!url?.startsWith('https://')) {
    console.error('Usage: node scripts/create-pc-webhook.js https://<host>/webhooks/planning-center');
    process.exit(1);
  }
  const auth = 'Basic ' + Buffer.from(
    `${process.env.PLANNING_CENTER_APP_ID}:${process.env.PLANNING_CENTER_SECRET}`,
  ).toString('base64');

  const res = await fetch('https://api.planningcenteronline.com/webhooks/v2/webhook_subscriptions', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: { attributes: { name: EVENT, url, active: true } } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Planning Center API ${res.status}:`, JSON.stringify(body));
    process.exit(1);
  }
  console.log(`Subscribed ${EVENT} → ${url} (id ${body.data?.id}).`);
  console.log(`Set PLANNING_CENTER_WEBHOOK_SECRET=${body.data?.attributes?.authenticity_secret}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
