/**
 * inspect-pc-form.js
 *
 * Discovery script — prints your Planning Center forms, their fields, and a
 * sample submission so you can build the field mapping for sync-from-pc.js.
 *
 * Usage:
 *   node scripts/inspect-pc-form.js
 *   node scripts/inspect-pc-form.js --form <formId>   # inspect a specific form
 *   node scripts/inspect-pc-form.js --form <formId> --submissions  # also print a sample submission
 */

import 'dotenv/config';
import {
  listForms,
  getFormFields,
  getSubmissionsWithValues,
} from '../src/planningcenter.js';

const args = process.argv.slice(2);
const formIdArg = args[args.indexOf('--form') + 1] ?? null;
const showSubmissions = args.includes('--submissions');

async function main() {
  // -------------------------------------------------------------------------
  // 1. List forms
  // -------------------------------------------------------------------------
  console.log('\n=== Planning Center Forms ===\n');
  const forms = await listForms();

  if (forms.length === 0) {
    console.log('No forms found. Check your credentials and PLANNING_CENTER_PRODUCT setting.');
    return;
  }

  for (const form of forms) {
    const marker = form.id === formIdArg ? ' <-- selected' : '';
    console.log(`  [${form.id}] ${form.name ?? '(unnamed)'}  status=${form.status ?? '?'}${marker}`);
  }

  // -------------------------------------------------------------------------
  // 2. Pick form to inspect
  // -------------------------------------------------------------------------
  const formId = formIdArg ?? forms[0].id;
  const form = forms.find(f => f.id === formId) ?? forms[0];

  console.log(`\n=== Fields for form: "${form.name}" (id=${formId}) ===\n`);

  // -------------------------------------------------------------------------
  // 3. Fields
  // -------------------------------------------------------------------------
  const fields = await getFormFields(formId);

  if (fields.length === 0) {
    console.log('No fields found for this form.');
  }

  for (const field of fields) {
    const opts = field.options?.length
      ? `\n       options: ${field.options.map(o => JSON.stringify(o)).join(', ')}`
      : '';
    console.log(
      `  [${field.id}]  seq=${String(field.sequence ?? '?').padEnd(3)}  type=${String(field.field_type ?? '?').padEnd(20)}  required=${field.required ?? '?'}  label="${field.label ?? ''}"${opts}`,
    );
  }

  // Print a mapping template to copy into your sync config
  console.log('\n=== Field mapping template (copy into your sync config) ===\n');
  console.log('// Map from Planning Center field ID → Sheets column name');
  console.log('const FIELD_MAP = {');
  for (const field of fields) {
    const suggestedCol = slugify(field.label ?? `field_${field.id}`);
    console.log(`  '${field.id}': '${suggestedCol}',  // ${field.label ?? ''}`);
  }
  console.log('};\n');

  // -------------------------------------------------------------------------
  // 4. Sample submission (optional)
  // -------------------------------------------------------------------------
  if (showSubmissions) {
    console.log('=== Sample submissions (first 3) ===\n');
    const submissions = await getSubmissionsWithValues(formId);
    const sample = submissions.slice(0, 3);

    for (const sub of sample) {
      console.log(`Submission ${sub.id}  person_id=${sub.person_id ?? 'anonymous'}  created_at=${sub.created_at}`);
      for (const [fieldId, value] of sub.values) {
        const field = fields.find(f => f.id === fieldId);
        const label = field?.label ?? fieldId;
        console.log(`  [${fieldId}] ${label}: ${JSON.stringify(value)}`);
      }
      console.log();
    }

    if (submissions.length === 0) {
      console.log('No submissions yet.');
    } else {
      console.log(`Total submissions: ${submissions.length}`);
    }
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

main().catch(err => {
  console.error('\nError:', err.message);
  if (err.message.includes('PLANNING_CENTER_APP_ID')) {
    console.error('\nMake sure your .env has:\n  PLANNING_CENTER_APP_ID=...\n  PLANNING_CENTER_SECRET=...\n');
  }
  process.exit(1);
});
