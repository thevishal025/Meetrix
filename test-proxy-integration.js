const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const reports = require('./report-generator.js');

console.log('--- Starting Local AI Proxy & Report Integration Tests ---');

// 1. Verify report generation with AI insight (NVIDIA summary & cautious corrections)
console.log('\n[Check 1] HTML report with NVIDIA summary & caption corrections');
const sampleCaptions = [
  { timestamp: 1700000000000, speaker: 'Vishal Maurya', text: 'We need to fix the relase date.' },
  { timestamp: 1700000005000, speaker: 'vxExplains', text: 'Agreed, Friday sounds good.' }
];

const mockAiInsight = {
  summary: 'Team agreed to ship the release on Friday.',
  keyPoints: ['Release timing reviewed and finalized.'],
  decisions: ['Release is scheduled for Friday.'],
  actionItems: [{ text: 'Prepare release build', owner: 'Vishal Maurya', deadline: 'Friday' }],
  followUps: ['Monitor deployment'],
  correctedCaptions: [
    'We need to fix the release date.',
    'Agreed, Friday sounds good.'
  ]
};

const htmlWithAi = reports.buildHtmlReport({
  meetingDetails: { meetingId: 'test-meeting-1', startTime: 1700000000000, duration: '15 min' },
  participants: [{ name: 'Vishal Maurya', deviceType: 'Desktop/Laptop', cameraStatus: 'Camera ON' }],
  transcript: sampleCaptions,
  aiInsight: mockAiInsight
});

assert.ok(htmlWithAi.includes('AI-reviewed Captions'), 'Report must display AI-reviewed Captions heading');
assert.ok(htmlWithAi.includes('We need to fix the release date.'), 'Corrected caption text must appear in report');
assert.ok(htmlWithAi.includes('Team agreed to ship the release on Friday.'), 'NVIDIA executive summary must appear');
assert.ok(htmlWithAi.includes('Vishal Maurya'), 'Speaker attribution must be preserved');
console.log('✓ Check 1 passed: HTML report integrates NVIDIA summary and cautious caption correction.');

// 2. Verify local fallback when AI summary is unavailable / fails
console.log('\n[Check 2] Local fallback when proxy or NVIDIA fails (original captions recoverable)');
const htmlFallback = reports.buildHtmlReport({
  meetingDetails: { meetingId: 'test-meeting-1', startTime: 1700000000000, duration: '15 min' },
  participants: [{ name: 'Vishal Maurya', deviceType: 'Desktop/Laptop', cameraStatus: 'Camera ON' }],
  transcript: sampleCaptions,
  aiInsight: null // Fallback
});

assert.ok(htmlFallback.includes('Complete Captured Transcript'), 'Must fall back to Complete Captured Transcript heading');
assert.ok(htmlFallback.includes('We need to fix the relase date.'), 'Original captions must be preserved verbatim in fallback');
assert.ok(htmlFallback.includes('Executive Summary'), 'Local heuristic summary must be generated');
console.log('✓ Check 2 passed: Fallback preserves original captions and provides local summary.');

// 3. Test loopback server behavior
console.log('\n[Check 3] Testing local proxy loopback server');
const proxyProcess = spawn(process.execPath, ['local-ai-proxy.js'], {
  cwd: __dirname,
  env: { ...process.env, NVIDIA_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let proxyStdout = '';
proxyProcess.stdout.on('data', chunk => { proxyStdout += chunk.toString(); });
proxyProcess.stderr.on('data', chunk => { process.stderr.write(`Proxy stderr: ${chunk}\n`); });

function waitForServer(port, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/health`, res => {
        clearInterval(interval);
        resolve();
      });
      req.on('error', () => {
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          reject(new Error('Proxy failed to start within timeout.'));
        }
      });
    }, 200);
  });
}

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    req.end();
  });
}

(async () => {
  try {
    await waitForServer(8787);
    console.log('✓ Proxy successfully listening on 127.0.0.1:8787.');

    // 3a. Health check from extension origin
    const extHealth = await request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/health',
      method: 'GET',
      headers: {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        Host: '127.0.0.1:8787'
      }
    });
    assert.equal(extHealth.status, 200);
    assert.equal(extHealth.body.ready, true);
    assert.equal(extHealth.body.keyConfigured, false);
    assert.equal(extHealth.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    console.log('✓ Extension reachability & CORS verified.');

    // 3b. Unauthorized external web origin must be blocked with 403
    const blockedWeb = await request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/health',
      method: 'GET',
      headers: {
        Origin: 'https://malicious-website.com',
        Host: '127.0.0.1:8787'
      }
    });
    assert.equal(blockedWeb.status, 403);
    console.log('✓ Unauthorized web origin strictly rejected with 403.');

    // 3c. Invalid host header must be blocked with 403
    const blockedHost = await request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/health',
      method: 'GET',
      headers: {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        Host: 'attacker-controlled-host.com:8787'
      }
    });
    assert.equal(blockedHost.status, 403);
    console.log('✓ Invalid host header strictly rejected with 403.');

    // 3d. API endpoint without key configured must return 503
    const insightsReq = await request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/api/meeting-insights',
      method: 'POST',
      headers: {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        Host: '127.0.0.1:8787',
        'Content-Type': 'application/json'
      }
    }, { lines: sampleCaptions });
    assert.equal(insightsReq.status, 503);
    assert.ok(insightsReq.body.error.includes('NVIDIA_API_KEY is not configured'));
    console.log('✓ Missing API key handled cleanly with 503 error without exposing internals.');

    // 3e. Test background.js helper with proxy running (unconfigured key returns local proxy error)
    global.chrome = {
      runtime: { id: 'test', lastError: null, onInstalled: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener() {} } },
      action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
      tabs: { onUpdated: { addListener() {} } },
      storage: { local: { remove(_k) {}, get(_k, cb) { cb({}); }, set(_d, cb) { if (cb) cb(); } } }
    };
    const { generateNvidiaMeetingInsights } = require('./background.js');
    const bgResult = await generateNvidiaMeetingInsights(JSON.stringify(sampleCaptions));
    assert.equal(bgResult.success, false);
    assert.ok(bgResult.error.includes('NVIDIA_API_KEY') || bgResult.error.includes('HTTP 503'));
    console.log('✓ background.js safely catches and reports proxy error.');

    console.log('\n======================================================');
    console.log('ALL INTEGRATION CHECKS PASSED');
    console.log('======================================================\n');
  } finally {
    proxyProcess.kill();
  }
})().catch(err => {
  proxyProcess.kill();
  console.error('Integration test failed:', err);
  process.exit(1);
});
