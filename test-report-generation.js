const assert = require('node:assert/strict');
const fs = require('node:fs');
const reports = require('./report-generator.js');

const popupMarkup = fs.readFileSync(require.resolve('./popup.html'), 'utf8');
assert.ok(!popupMarkup.includes('id="nvidiaApiKeyInput"'));
assert.ok(popupMarkup.includes('id="downloadReportBtn"'));

const injected = '<img src=x onerror="alert(1)"> & hello';
const html = reports.buildHtmlReport({
  meetingDetails: { meetingId: 'abc-defg-hij', startTime: 1793111400000 },
  participants: [{ name: '<script>alert(1)</script>', firstJoinAt: 1793111400000 }],
  transcript: [{ timestamp: 1793111400000, speaker: '<svg onload=alert(1)>', text: injected }]
});
assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; hello'));
assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
assert.ok(!html.includes('<img src=x'));
assert.ok(!html.includes('<script>alert(1)</script>'));
assert.ok(html.includes('Print / Save as PDF'));
assert.ok(html.includes('works offline'));

const summary = reports.buildMeetingSummary([
  { text: 'We agreed to ship the feature on Friday.' },
  { text: 'Alex will follow up with the final draft?' }
]);
assert.equal(summary.available, true);
assert.ok(summary.decisions.some(line => /agreed/i.test(line)));
assert.ok(summary.actions.some(line => /will follow up/i.test(line)));
assert.equal(reports.buildMeetingSummary([]).available, false);
async function testNvidiaCaptionReview() {
  global.chrome = {
    runtime: { id: 'test', lastError: null, onInstalled: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener() {} } },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
    tabs: { onUpdated: { addListener() {} } },
    storage: { local: { remove(_key) {}, get(_key, callback) { callback({}); }, set(_data, callback) { if (callback) callback(); } } }
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/api/meeting-insights');
    const lines = JSON.parse(options.body).lines;
    return { ok: true, status: 200, json: async () => ({ success: true, model: 'test-model', insight: { summary: 'Discussed the release.', keyPoints: ['Release timing reviewed.'], decisions: ['The team agreed on Friday.'], actionItems: [{ text: 'Share notes', owner: null, deadline: null }], followUps: [], correctedCaptions: lines.map(line => line.text.replace('relase', 'release')) } }) };
  };
  try {
    const { generateNvidiaMeetingInsights } = require('./background.js');
    const inputLines = [{ speaker: 'Sam', timestamp: 123, text: 'We reviewed the relase plan.' }];
    const result = await generateNvidiaMeetingInsights(JSON.stringify(inputLines));
    assert.equal(result.success, true);
    assert.equal(result.insight.correctedCaptions[0], 'We reviewed the release plan.');
    assert.equal(result.insight.decisions[0], 'The team agreed on Friday.');
    assert.equal(result.insight.actionItems[0].owner, null);
  } finally { global.fetch = originalFetch; }
}

testNvidiaCaptionReview().then(() => console.log('Report generation, HTML escaping, and NVIDIA caption review checks passed.')).catch(error => { console.error(error); process.exit(1); });
