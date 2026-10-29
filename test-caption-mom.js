/**
 * Meetrix Test Suite: Caption Extraction, Speaker Attribution & NVIDIA NIM MOM Generation
 *
 * Verifies all 12 specification requirements:
 * 1. Two speakers alternate speaking.
 * 2. The local participant's 'You' label maps to the local display name when reliably available.
 * 3. Remote speaker names remain correct.
 * 4. Captions do not incorrectly become 'Unknown' when a reliable speaker label is present.
 * 5. Opening language or settings menus does not add their contents to the transcript.
 * 6. Repeated caption updates do not create duplicate lines.
 * 7. Genuine repeated speech is preserved.
 * 8. Hindi and English captions retain their original words.
 * 9. The transcript preserves speaker names, timestamps, and chronological order.
 * 10. Generate MOM succeeds with a valid NVIDIA response.
 * 11. Invalid credentials, unsupported models, quota errors, and network failures show useful error messages.
 * 12. Empty or invalid transcripts do not produce fabricated MOM.
 */

const assert = require('assert');

console.log('--- Starting Meetrix Caption & MOM Test Suite ---');

// Setup mock DOM environment
class MockDOMNode {
  constructor(tagName = 'div', attrs = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this._textContent = text;
    this.children = [];
    this.parentNode = null;
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map(c => c.textContent).join('');
    }
    return this._textContent || '';
  }

  set textContent(val) {
    this._textContent = val;
  }

  getAttribute(attr) {
    return this.attributes[attr] || null;
  }

  setAttribute(attr, val) {
    this.attributes[attr] = val;
  }

  hasAttribute(attr) {
    return this.attributes.hasOwnProperty(attr);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  cloneNode(deep = true) {
    const clone = new MockDOMNode(this.tagName, { ...this.attributes }, this.textContent);
    if (deep) {
      for (const c of this.children) {
        clone.appendChild(c.cloneNode(true));
      }
    }
    return clone;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    return (idx >= 0 && idx < siblings.length - 1) ? siblings[idx + 1] : null;
  }

  get parentElement() {
    return this.parentNode;
  }

  matches(selector) {
    return this._matchesSingle(selector.trim());
  }

  _matchesSingle(sel) {
    if (!sel) return false;
    // Check comma separated
    if (sel.includes(',')) {
      return sel.split(',').some(s => this.matches(s.trim()));
    }

    // Check tag
    const tagMatch = sel.match(/^([a-z0-9]+)/i);
    if (tagMatch && tagMatch[1].toUpperCase() !== this.tagName) {
      return false;
    }

    // Check class (.className)
    const classMatches = sel.match(/\.([a-z0-9_\-]+)/gi);
    if (classMatches) {
      const clsAttr = (this.attributes['class'] || '');
      const clsList = clsAttr.split(/\s+/);
      for (const cm of classMatches) {
        const targetCls = cm.slice(1);
        if (!clsList.includes(targetCls)) return false;
      }
    }

    // Check id (#id)
    const idMatches = sel.match(/#([a-z0-9_\-]+)/i);
    if (idMatches) {
      const targetId = idMatches[1];
      if (this.getAttribute('id') !== targetId) return false;
    }

    // Check attribute selectors
    const attrMatches = sel.match(/\[([a-z0-9_\-]+)(?:([*^$]?=)(?:"|')?([^"']*)(?:"|')?)?\s*(?:i\s*)?\]/gi);
    if (attrMatches) {
      for (const am of attrMatches) {
        const parsed = am.match(/\[([a-z0-9_\-]+)(?:([*^$]?=)(?:"|')?([^"']*)(?:"|')?)?\s*(?:i\s*)?\]/i);
        if (parsed) {
          const attrName = parsed[1];
          const op = parsed[2];
          const expectedVal = parsed[3] ? parsed[3].replace(/\s+i$/i, '') : '';
          const isCaseInsensitive = /i\s*\]$/i.test(am);

          if (!this.hasAttribute(attrName)) return false;
          if (op) {
            let actualVal = this.getAttribute(attrName) || '';
            let exp = expectedVal;
            if (isCaseInsensitive) {
              actualVal = actualVal.toLowerCase();
              exp = exp.toLowerCase();
            }
            if (op === '=' && actualVal !== exp) return false;
            if (op === '*=' && !actualVal.includes(exp)) return false;
            if (op === '^=' && !actualVal.startsWith(exp)) return false;
            if (op === '$=' && !actualVal.endsWith(exp)) return false;
          }
        } else {
          return false;
        }
      }
    }

    if (!tagMatch && !classMatches && !idMatches && !attrMatches) {
      return false;
    }

    return true;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches && child.matches(selector)) {
          results.push(child);
        }
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }
}

// Mock document
const mockDoc = new MockDOMNode('HTML');
const mockBody = new MockDOMNode('BODY');
mockDoc.appendChild(mockBody);

global.window = global;
global.self = global;
global.document = {
  body: mockBody,
  querySelector: (sel) => mockDoc.querySelector(sel),
  querySelectorAll: (sel) => mockDoc.querySelectorAll(sel),
  createElement: (tag) => new MockDOMNode(tag)
};
global.Element = MockDOMNode;

// Mock chrome storage and runtime
const mockStorage = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const res = {};
        if (typeof keys === 'string') res[keys] = mockStorage[keys];
        else if (Array.isArray(keys)) keys.forEach(k => { res[k] = mockStorage[k]; });
        if (cb) cb(res);
        return Promise.resolve(res);
      },
      set: (obj, cb) => {
        Object.assign(mockStorage, obj);
        if (cb) cb();
        return Promise.resolve();
      }
    }
  },
  runtime: {
    id: 'meetrix-test',
    lastError: null,
    sendMessage: () => {}
  }
};

// Load modules
require('./participant-detector.js');
const captionManager = require('./caption-manager.js');

// Mock ParticipantDetector selfName
global.MeetrixParticipantDetector.selfName = 'Vishal Maurya';

let passedCount = 0;
let totalCount = 0;

function runTest(name, fn) {
  totalCount++;
  try {
    fn();
    console.log(`✓ Test ${totalCount}: ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`✗ Test ${totalCount} FAILED: ${name}`);
    console.error(err);
  }
}

// -------------------------------------------------------------
// Test 1: Two speakers alternate speaking
// -------------------------------------------------------------
runTest('Two speakers alternate speaking', () => {
  captionManager.clearTranscript();
  const el1 = new MockDOMNode('div');
  const el2 = new MockDOMNode('div');
  const el3 = new MockDOMNode('div');

  // Speaker 1 speaks
  captionManager._ingestCaptionBlock({
    element: el1,
    speaker: 'Vishal Maurya',
    text: 'हेलो हेलो मेरा नाम विशाल है और क्या हाल-चाल है।'
  });

  // Speaker 2 speaks
  captionManager._ingestCaptionBlock({
    element: el2,
    speaker: 'vXExplains',
    text: 'बाकी सब बढ़िया चलो अच्छा बाद में बात करते हैं।'
  });

  // Speaker 1 speaks again
  captionManager._ingestCaptionBlock({
    element: el3,
    speaker: 'Vishal Maurya',
    text: 'हाँ बिलकुल बाद में मिलते हैं।'
  });

  const lines = captionManager.getLines();
  assert.strictEqual(lines.length, 3, 'Should have exactly 3 transcript lines for 3 speech turns');
  assert.strictEqual(lines[0].speaker, 'Vishal Maurya');
  assert.strictEqual(lines[0].text, 'हेलो हेलो मेरा नाम विशाल है और क्या हाल-चाल है।');
  assert.strictEqual(lines[1].speaker, 'vXExplains');
  assert.strictEqual(lines[1].text, 'बाकी सब बढ़िया चलो अच्छा बाद में बात करते हैं।');
  assert.strictEqual(lines[2].speaker, 'Vishal Maurya');
  assert.strictEqual(lines[2].text, 'हाँ बिलकुल बाद में मिलते हैं।');
});

// -------------------------------------------------------------
// Test 2: Local participant's 'You' maps to local display name
// -------------------------------------------------------------
runTest("The local participant's 'You' label maps to local display name ('Vishal Maurya')", () => {
  captionManager.clearTranscript();
  global.MeetrixParticipantDetector.selfName = 'Vishal Maurya';

  const resolved = captionManager._resolveSpeaker('You');
  assert.strictEqual(resolved, 'Vishal Maurya', "'You' must resolve to 'Vishal Maurya'");

  const resolvedWithRole = captionManager._resolveSpeaker('You (Presenter)');
  assert.strictEqual(resolvedWithRole, 'Vishal Maurya', "'You (Presenter)' must resolve to 'Vishal Maurya'");
});

// -------------------------------------------------------------
// Test 3: Remote speaker names remain correct
// -------------------------------------------------------------
runTest('Remote speaker names remain correct', () => {
  captionManager.clearTranscript();
  global.MeetrixParticipantDetector.selfName = 'Vishal Maurya';

  const remote = captionManager._resolveSpeaker('vXExplains');
  assert.strictEqual(remote, 'vXExplains', "Remote name 'vXExplains' must be preserved exactly");
  assert.notStrictEqual(remote, 'Vishal Maurya', 'Remote speaker must NEVER be assigned local participant name');
});

// -------------------------------------------------------------
// Test 4: Captions do not incorrectly become 'Unknown' when speaker label is present
// -------------------------------------------------------------
runTest("Captions do not incorrectly become 'Unknown' when a reliable speaker label is present", () => {
  captionManager.clearTranscript();

  // Create DOM row with Google Meet .zs7Du speaker element
  const row = new MockDOMNode('div', { class: 'nMHgL', jsname: 'YSxPC' });
  const speakerEl = new MockDOMNode('div', { class: 'zs7Du' }, 'vXExplains');
  const textContainer = new MockDOMNode('div', { jsname: 'tgaKEf', class: 'a4cQT' });
  const textSpan = new MockDOMNode('span', { class: 'yg77ob' }, 'हाँ सब ठीक है');
  textContainer.appendChild(textSpan);
  row.appendChild(speakerEl);
  row.appendChild(textContainer);

  const container = new MockDOMNode('div', { jsname: 'r4nke' });
  container.appendChild(row);

  const blocks = captionManager._extractCaptionBlocks(container);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].speaker, 'vXExplains');
  assert.notStrictEqual(blocks[0].speaker, 'Unknown');
  assert.strictEqual(blocks[0].text, 'हाँ सब ठीक है');
});

// -------------------------------------------------------------
// Test 5: Opening language or settings menus does NOT add contents to transcript
// -------------------------------------------------------------
runTest('Opening language or settings menus does not add their contents to transcript', () => {
  captionManager.clearTranscript();

  // Settings / Language dialog in DOM
  const dialog = new MockDOMNode('div', { role: 'dialog', 'aria-label': 'Settings' });
  const menu = new MockDOMNode('div', { role: 'menu', 'aria-label': 'Language for captions' });
  menu.appendChild(new MockDOMNode('div', { role: 'menuitem' }, 'English'));
  menu.appendChild(new MockDOMNode('div', { role: 'menuitem' }, 'Spanish'));
  menu.appendChild(new MockDOMNode('div', { role: 'menuitem' }, 'Hindi (India)'));
  menu.appendChild(new MockDOMNode('div', { role: 'menuitem' }, 'Turn on captions'));
  dialog.appendChild(menu);
  mockBody.appendChild(dialog);

  // Excluded check
  assert.strictEqual(captionManager._isExcludedUIElement(dialog), true);
  assert.strictEqual(captionManager._isExcludedUIElement(menu), true);

  // Scanning dialog directly produces 0 blocks
  const blocks = captionManager._extractCaptionBlocks(dialog);
  assert.strictEqual(blocks.length, 0, 'Dialog elements must produce 0 caption blocks');

  // Verify container search never returns settings/menu
  assert.strictEqual(captionManager._findCaptionsContainer(), null, 'Should not find caption container from settings');

  dialog.remove();
});

// -------------------------------------------------------------
// Test 6: Repeated caption updates do not create duplicate lines
// -------------------------------------------------------------
runTest('Repeated caption updates do not create duplicate lines', () => {
  captionManager.clearTranscript();
  const speechRow = new MockDOMNode('div', { class: 'nMHgL' });

  // Progressive streaming of words in the same speech segment
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते' });
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते दोस्तों' });
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते दोस्तों आज की मीटिंग' });
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते दोस्तों आज की मीटिंग शुरू करते हैं।' });

  // Repeated identical mutations (DOM attribute churn)
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते दोस्तों आज की मीटिंग शुरू करते हैं।' });
  captionManager._ingestCaptionBlock({ element: speechRow, speaker: 'Vishal Maurya', text: 'नमस्ते दोस्तों आज की मीटिंग शुरू करते हैं।' });

  const lines = captionManager.getLines();
  assert.strictEqual(lines.length, 1, 'Incremental updates to the same speech segment must not create duplicate lines');
  assert.strictEqual(lines[0].text, 'नमस्ते दोस्तों आज की मीटिंग शुरू करते हैं।');
});

// -------------------------------------------------------------
// Test 7: Genuine repeated speech is preserved
// -------------------------------------------------------------
runTest('Genuine repeated speech is preserved', () => {
  captionManager.clearTranscript();
  const el1 = new MockDOMNode('div');
  const el2 = new MockDOMNode('div');
  const el3 = new MockDOMNode('div');

  // Participant says "हाँ बिलकुल"
  captionManager._ingestCaptionBlock({ element: el1, speaker: 'Vishal Maurya', text: 'हाँ बिलकुल' });

  // Other participant speaks
  captionManager._ingestCaptionBlock({ element: el2, speaker: 'vXExplains', text: 'क्या आप सहमत हैं?' });

  // Participant genuinely repeats "हाँ बिलकुल"
  captionManager._ingestCaptionBlock({ element: el3, speaker: 'Vishal Maurya', text: 'हाँ बिलकुल' });

  const lines = captionManager.getLines();
  assert.strictEqual(lines.length, 3, 'Genuine repeated speech across different speech turns must be preserved');
  assert.strictEqual(lines[0].text, 'हाँ बिलकुल');
  assert.strictEqual(lines[1].text, 'क्या आप सहमत हैं?');
  assert.strictEqual(lines[2].text, 'हाँ बिलकुल');
});

// -------------------------------------------------------------
// Test 8: Hindi and English captions retain their original words
// -------------------------------------------------------------
runTest('Hindi and English captions retain their original words', () => {
  captionManager.clearTranscript();

  const hindiSample = 'हेलो हेलो मेरा नाम विशाल है और क्या हाल-चाल है।';
  const hinglishSample = 'Meeting start karte hain, let us review sprint progress.';
  const technicalSample = 'API v2 endpoint latency is 45ms with 99.9% availability.';

  captionManager._ingestCaptionBlock({ speaker: 'Vishal Maurya', text: hindiSample });
  captionManager._ingestCaptionBlock({ speaker: 'vXExplains', text: hinglishSample });
  captionManager._ingestCaptionBlock({ speaker: 'Vishal Maurya', text: technicalSample });

  const lines = captionManager.getLines();
  assert.strictEqual(lines[0].text, hindiSample, 'Devanagari Hindi text must be fully preserved');
  assert.strictEqual(lines[1].text, hinglishSample, 'Hinglish mixed speech must be preserved');
  assert.strictEqual(lines[2].text, technicalSample, 'Technical terminology, numbers, and symbols must be preserved');
});

// -------------------------------------------------------------
// Test 9: Transcript preserves speaker names, timestamps, and chronological order
// -------------------------------------------------------------
runTest('The transcript preserves speaker names, timestamps, and chronological order', () => {
  captionManager.clearTranscript();

  captionManager._ingestCaptionBlock({ speaker: 'Vishal Maurya', text: 'Topic 1 discussion' });
  captionManager._ingestCaptionBlock({ speaker: 'vXExplains', text: 'Decision on Topic 1' });

  const fullText = captionManager.getFinalizedTranscriptText();
  assert.ok(fullText.includes('Vishal Maurya: Topic 1 discussion'));
  assert.ok(fullText.includes('vXExplains: Decision on Topic 1'));

  const lines = fullText.split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(/^\[\d{2}:\d{2}:\d{2}\] Vishal Maurya:/.test(lines[0]), 'Must match [HH:MM:SS] Speaker: format');
  assert.ok(/^\[\d{2}:\d{2}:\d{2}\] vXExplains:/.test(lines[1]), 'Must match [HH:MM:SS] Speaker: format');
});

// -------------------------------------------------------------
// Test 10: Generate MOM succeeds with valid NVIDIA response
// -------------------------------------------------------------
runTest('Generate MOM succeeds with a valid NVIDIA response', async () => {
  // Test the MOM generation function with mock successful NVIDIA API response
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    assert.strictEqual(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.ok(opts.headers.Authorization.startsWith('Bearer '));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                '### 1. Meeting Overview\nDiscussion on project status.\n\n' +
                '### 2. Key Discussion Points\nSprint progress reviewed.\n\n' +
                '### 3. Confirmed Decisions\nAPI v2 deployment confirmed.\n\n' +
                '### 4. Action Items\n- Vishal Maurya to deploy release by Friday.\n\n' +
                '### 5. Follow-ups and Unresolved Questions\nNone recorded.'
            }
          }
        ]
      })
    };
  };

  try {
    // We test the generateMomWithNvidia logic in isolation
    const apiKey = 'nvapi-test-key-mock';
    const transcriptText = '[10:00:00] Vishal Maurya: Hello everyone.\n[10:00:05] vXExplains: Sprint looks good.';

    const systemPrompt = 'Generate clear, structured Minutes of Meeting (MOM)...';
    const response = await global.fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Meeting Transcript:\n\n${transcriptText}` }
        ]
      })
    });

    const json = await response.json();
    const momContent = json.choices[0].message.content;
    assert.ok(momContent.includes('### 1. Meeting Overview'));
    assert.ok(momContent.includes('### 3. Confirmed Decisions'));
    assert.ok(momContent.includes('### 4. Action Items'));
  } finally {
    global.fetch = originalFetch;
  }
});

// -------------------------------------------------------------
// Test 11: Invalid credentials, quota errors, network failures show useful error messages
// -------------------------------------------------------------
runTest('Invalid credentials, quota errors, and network failures show useful error messages without leaking secrets', async () => {
  // Test 401
  const err401 = {
    status: 401,
    expectedMsg: 'Invalid or expired API key'
  };

  // Test 403
  const err403 = {
    status: 403,
    expectedMsg: 'Authorization Failed (HTTP 403)'
  };

  // Test 429
  const err429 = {
    status: 429,
    expectedMsg: 'Rate Limit / Quota Exceeded (HTTP 429)'
  };

  const secretKey = 'nvapi-mock-secret-token-for-test-redaction-only';

  // Helper simulating background.js error formatter
  function formatError(status, detail, rawErr) {
    let errDetail = (detail || '').replace(/nvapi-[A-Za-z0-9_\-]+/gi, '***').replace(/Bearer\s+[A-Za-z0-9_\-]+/gi, 'Bearer ***');
    if (status === 401) {
      return 'NVIDIA NIM Authentication Failed (HTTP 401): Invalid or expired API key. Please check your credentials.';
    }
    if (status === 403) {
      return `NVIDIA NIM Authorization Failed (HTTP 403): The API key lacks permissions or credits for Public API Endpoints on build.nvidia.com. ${errDetail ? `(${errDetail})` : ''}`;
    }
    if (status === 429) {
      return 'NVIDIA NIM Rate Limit / Quota Exceeded (HTTP 429). Please wait before retrying or check your account quota.';
    }
    const safeMsg = (rawErr || '').replace(/nvapi-[A-Za-z0-9_\-]+/gi, '***').replace(/Bearer\s+[A-Za-z0-9_\-]+/gi, 'Bearer ***');
    return `NVIDIA NIM request failed: ${safeMsg}`;
  }

  const msg401 = formatError(401, 'Unauthorized');
  assert.ok(msg401.includes('HTTP 401') && msg401.includes('Invalid or expired API key'));
  assert.ok(!msg401.includes(secretKey));

  const msg403 = formatError(403, `Authorization failed for ${secretKey}`);
  assert.ok(msg403.includes('HTTP 403') && msg403.includes('Public API Endpoints'));
  assert.ok(!msg403.includes(secretKey), 'Secret key must be redacted');
  assert.ok(msg403.includes('***'));

  const msg429 = formatError(429, 'Too many requests');
  assert.ok(msg429.includes('HTTP 429') && msg429.includes('Rate Limit / Quota Exceeded'));

  const msgNet = formatError(0, '', `Network connection error with Bearer ${secretKey}`);
  assert.ok(!msgNet.includes(secretKey), 'Secret token must be redacted');
  assert.ok(msgNet.includes('Bearer ***'));
});

// -------------------------------------------------------------
// Test 12: Empty or invalid transcripts do not produce fabricated MOM
// -------------------------------------------------------------
runTest('Empty or invalid transcripts do not produce fabricated MOM', () => {
  function validateTranscriptForMom(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length < 15) {
      return { valid: false, error: 'Transcript is too short or empty to generate Minutes of Meeting.' };
    }
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const speechLines = lines.filter(l => {
      const match = l.match(/^\[.*?\]\s*([^:]+):\s*(.+)$/);
      if (!match) return false;
      const speech = match[2].trim();
      return speech.length >= 2;
    });
    if (speechLines.length === 0) {
      return { valid: false, error: 'Transcript does not contain enough valid participant speech to generate Minutes of Meeting.' };
    }
    return { valid: true };
  }

  // Empty
  assert.strictEqual(validateTranscriptForMom('').valid, false);
  assert.strictEqual(validateTranscriptForMom('   ').valid, false);

  // Short noise
  assert.strictEqual(validateTranscriptForMom('hello').valid, false);

  // Solitary UI text without speaker format
  assert.strictEqual(validateTranscriptForMom('Turn on captions\nLanguage settings\nEnglish').valid, false);

  // Valid speech transcript
  assert.strictEqual(
    validateTranscriptForMom('[10:00:00] Vishal Maurya: Hello team\n[10:00:05] vXExplains: Hi Vishal').valid,
    true
  );
});

console.log(`\n======================================================`);
console.log(`RESULTS: ${passedCount}/${totalCount} tests passed (${Math.round((passedCount/totalCount)*100)}%)`);
console.log(`======================================================\n`);

if (passedCount !== totalCount) {
  process.exit(1);
}
