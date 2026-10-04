/**
 * planningcenter.js
 *
 * Read-only Planning Center API client for fetching form submissions.
 *
 * Auth: HTTP Basic Auth with App ID (username) + Secret (password).
 * Get credentials at: https://developer.planningcenteronline.com/
 *
 * Supports both the People API (/people/v2/forms) and
 * Church Center API (/church_center/v2/forms) — set via PLANNING_CENTER_PRODUCT env var.
 */

const BASE_URL = 'https://api.planningcenteronline.com';

function getCredentials() {
  const appId = process.env.PLANNING_CENTER_APP_ID;
  const secret = process.env.PLANNING_CENTER_SECRET;
  if (!appId || !secret) {
    throw new Error('PLANNING_CENTER_APP_ID and PLANNING_CENTER_SECRET must be set');
  }
  return { appId, secret };
}

function authHeader(appId, secret) {
  return 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64');
}

/**
 * GET a Planning Center API URL, following pagination automatically.
 * Returns all data items across all pages.
 *
 * @param {string} url - Full URL including query params
 * @param {string} appId
 * @param {string} secret
 * @returns {Promise<object[]>}
 */
async function fetchAllPages(url, appId, secret) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        Authorization: authHeader(appId, secret),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Planning Center API ${res.status} for ${nextUrl}: ${body}`);
    }

    const json = await res.json();
    if (Array.isArray(json.data)) {
      items.push(...json.data);
    }

    // JSON:API pagination — follow `links.next` if present
    nextUrl = json.links?.next ?? null;
  }

  return items;
}

/**
 * GET a single Planning Center resource.
 *
 * @param {string} url
 * @param {string} appId
 * @param {string} secret
 * @returns {Promise<object>} - The `data` object from the JSON:API response
 */
async function fetchOne(url, appId, secret) {
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(appId, secret),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Planning Center API ${res.status} for ${url}: ${body}`);
  }

  const json = await res.json();
  return json.data;
}

// ---------------------------------------------------------------------------
// Product helpers
// ---------------------------------------------------------------------------

/**
 * Returns the API base path for the configured product.
 * Defaults to 'people/v2'.
 */
function productBase() {
  const product = (process.env.PLANNING_CENTER_PRODUCT ?? 'people').toLowerCase().replace(/\//g, '');
  if (product === 'churchcenter' || product === 'church_center') {
    return `${BASE_URL}/church_center/v2`;
  }
  return `${BASE_URL}/people/v2`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all forms visible to this token.
 *
 * @returns {Promise<Array<{id: string, name: string, status: string}>>}
 */
export async function listForms() {
  const { appId, secret } = getCredentials();
  const items = await fetchAllPages(`${productBase()}/forms`, appId, secret);
  return items.map(item => ({
    id: item.id,
    ...item.attributes,
  }));
}

/**
 * Get all fields for a form.
 *
 * @param {string} formId
 * @returns {Promise<Array<{id: string, label: string, field_type: string, sequence: number, required: boolean, options: string[]}>>}
 */
export async function getFormFields(formId) {
  const { appId, secret } = getCredentials();
  const items = await fetchAllPages(`${productBase()}/forms/${formId}/fields`, appId, secret);
  return items.map(item => ({
    id: item.id,
    ...item.attributes,
    options: item.attributes?.options ?? [],
  }));
}

/**
 * Get all submissions for a form, optionally filtered to those created after `since`.
 *
 * Each submission includes:
 *   - id: string
 *   - person_id: string|null  (null if submitted anonymously)
 *   - created_at: string (ISO 8601)
 *   - updated_at: string (ISO 8601)
 *
 * @param {string} formId
 * @param {Date|null} since - only return submissions created after this date (optional)
 * @returns {Promise<Array<{id: string, person_id: string|null, created_at: string, updated_at: string}>>}
 */
export async function getFormSubmissions(formId, since = null) {
  const { appId, secret } = getCredentials();

  let url = `${productBase()}/forms/${formId}/form_submissions`;
  if (since) {
    url += `?where[created_at][gte]=${encodeURIComponent(since.toISOString())}`;
  }

  const items = await fetchAllPages(url, appId, secret);

  return items.map(item => ({
    id: item.id,
    formId,
    person_id: item.relationships?.person?.data?.id ?? null,
    created_at: item.attributes?.created_at ?? null,
    updated_at: item.attributes?.updated_at ?? null,
  }));
}

/**
 * Get all field values for a single submission.
 *
 * @param {string} submissionId
 * @returns {Promise<Array<{field_id: string, value: string, display_value: string}>>}
 */
export async function getSubmissionValues(formId, submissionId) {
  const { appId, secret } = getCredentials();
  const items = await fetchAllPages(
    `${productBase()}/forms/${formId}/form_submissions/${submissionId}/form_submission_values`,
    appId,
    secret,
  );
  return items.map(item => ({
    field_id: item.attributes?.form_field_id ?? item.relationships?.form_field?.data?.id ?? null,
    value: item.attributes?.value ?? '',
    display_value: item.attributes?.display_value ?? item.attributes?.value ?? '',
  }));
}

/**
 * Fetch all submissions for a form with their field values fully resolved.
 *
 * Returns an array of submission objects where `values` is a Map from
 * field_id → string[] (array of display values).
 *
 * Checkbox fields produce multiple values per field_id; single-select fields
 * produce exactly one. The map always stores arrays so callers are consistent.
 *
 * This is the primary function for the sync script.
 *
 * @param {string} formId
 * @param {Date|null} since
 * @returns {Promise<Array<{id, person_id, created_at, values: Map<string,string[]>}>>}
 */
export async function getSubmissionsWithValues(formId, since = null) {
  const submissions = await getFormSubmissions(formId, since);

  // Fetch values + person emails for each submission (parallel, 5 at a time)
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < submissions.length; i += CONCURRENCY) {
    const batch = submissions.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async sub => {
        const [values, emails] = await Promise.all([
          getSubmissionValues(sub.formId, sub.id),
          getPersonEmails(sub.person_id),
        ]);
        const valueMap = new Map();
        for (const { field_id, display_value } of values) {
          if (!field_id) continue;
          if (!valueMap.has(field_id)) valueMap.set(field_id, []);
          if (display_value) valueMap.get(field_id).push(display_value);
        }
        return { ...sub, values: valueMap, emails };
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Get all email addresses for a person.
 *
 * @param {string} personId
 * @returns {Promise<string[]>}
 */
export async function getPersonEmails(personId) {
  if (!personId) return [];
  const { appId, secret } = getCredentials();
  const items = await fetchAllPages(
    `${productBase()}/people/${personId}/emails`,
    appId,
    secret,
  );
  return items.map(item => item.attributes?.address ?? '').filter(Boolean);
}
