export default Object.freeze({
  sheetReadIntervalMs: parseInt(process.env.SHEET_READ_INTERVAL_MS ?? '30000'),
  showTestRows: process.env.SHOW_TEST_ROWS === 'true',
});
