const webhookSecret = process.env.PLANNING_CENTER_WEBHOOK_SECRET ?? '';

export default Object.freeze({
  // How often to read the Meta tab (2 cells) to detect new rows
  sheetReadIntervalMs: parseInt(process.env.SHEET_READ_INTERVAL_MS ?? '30000'),
  // How often to re-read the small Lists/Regions/Approvals tabs (moderation edits)
  referenceRefreshMs: parseInt(process.env.REFERENCE_REFRESH_MS ?? '300000'),
  // Planning Center webhook authenticity secret; when set, PC polling is off by default
  pcWebhookSecret: webhookSecret,
  // Fallback PC poll (0 = off). Defaults to off with a webhook, 30s without.
  pcPollIntervalMs: parseInt(process.env.PC_POLL_INTERVAL_MS ?? (webhookSecret ? '0' : '30000')),
  showTestRows: process.env.SHOW_TEST_ROWS === 'true',
});
