/**
 * Meetrix - Caption Transcription Manager (v2)
 *
 * Stage A: Google Meet built-in closed captions observer.
 *   - Auto-detects and watches Google Meet's closed caption containers across all versions.
 *   - Detects whether captions are currently enabled via Meet's CC button state.
 *   - Can automatically turn ON captions in Google Meet when transcription is started.
 *   - Captures speaker name, text, and timestamp.
 *   - Deduplicates incremental caption updates (Meet streams words incrementally).
 *   - Preserves chronological ordering.
 *   - Supports Hindi, English, and multilingual captions.
 *   - Never injects caption text as executable HTML; always uses textContent.
 *
 * Stage B: Local AI fallback — interface prepared, inference not yet integrated.
 *
 * Exposed on window.MeetrixCaptionManager.
 */

(function (root) {
  'use strict';

  // Maximum number of transcript lines stored in memory (rolling window)
  const MAX_TRANSCRIPT_LINES = 1000;

  // Minimum time between consecutive lines from the same speaker (ms)
  const SAME_SPEAKER_CONTINUATION_MS = 5000;

  class MeetrixCaptionManager {
    constructor() {
      this.isActive = false;
      this.lines = []; // { id, speaker, text, timestamp, source }
      this.observers = [];
      this.listeners = []; // UI change callbacks
      this._lineIdCounter = 0;
      this._lastLine = null;
      this._captionsContainerObserver = null;
      this._containerWatchInterval = null;
      this._captionsEnabled = false;
      this._observedContainer = null;

      // Audio capture (Stage B — not yet functional)
      this._mediaStream = null;
      this._audioContext = null;
      this._stageB = false;
    }

    // ----------------------------------------------------------------
    // Public API
    // ----------------------------------------------------------------

    /**
     * Starts observing Google Meet captions.
     * Automatically attempts to enable captions in Google Meet if not yet active.
     */
    startCaptionObserver() {
      if (this.isActive) return;
      this.isActive = true;

      // Check if Meet's CC button is already active, otherwise try turning it on
      const isButtonOn = this.isMeetCaptionsButtonActive();
      if (!isButtonOn) {
        this.tryEnableMeetCaptions();
      }

      this._captionsEnabled = Boolean(isButtonOn || this._findCaptionsContainer());
      this._startContainerWatch();

      const initialMessage = this._captionsEnabled
        ? 'Recording captions…'
        : 'Waiting for Meet captions…';

      this._notifyListeners({
        type: 'status',
        captionsActive: this._captionsEnabled,
        message: initialMessage
      });
    }

    /**
     * Stops all caption observation and cleans up resources.
     */
    stop() {
      this.isActive = false;
      this._captionsEnabled = false;
      this._stopContainerWatch();
      this._disconnectCaptionObserver();
      this._releaseAudioResources();
      this._observedContainer = null;
      if (this._lastLine) {
        this._lastLine.interim = false;
      }
      this._notifyListeners({ type: 'status', captionsActive: false, message: 'Transcription stopped.' });
    }

    /**
     * Clears the in-memory transcript.
     */
    clearTranscript() {
      this.lines = [];
      this._lastLine = null;
      this._lineIdCounter = 0;
      this._notifyListeners({ type: 'cleared' });
    }

    /**
     * Returns all current transcript lines as a copy.
     * @returns {Array<{id: number, speaker: string|null, text: string, timestamp: number, source: string}>}
     */
    getLines() {
      const selfName = this._getLocalParticipantName();
      return this.lines.map(l => {
        if (l.speaker === 'You' && selfName) {
          return { ...l, speaker: selfName };
        }
        return { ...l };
      });
    }

    /**
     * Registers a callback that fires when transcript state changes.
     * @param {function} cb
     */
    onUpdate(cb) {
      if (typeof cb === 'function') this.listeners.push(cb);
    }

    /**
     * Removes a previously registered callback.
     * @param {function} cb
     */
    offUpdate(cb) {
      this.listeners = this.listeners.filter(l => l !== cb);
    }

    /**
     * Exports transcript as a plain text string.
     * @returns {string}
     */
    exportTxt() {
      const selfName = this._getLocalParticipantName();
      return this.lines.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const speakerName = (l.speaker === 'You' && selfName) ? selfName : l.speaker;
        const speaker = speakerName ? `[${speakerName}]` : '[Unknown]';
        return `${time} ${speaker}: ${l.text}`;
      }).join('\n');
    }

    /**
     * Exports transcript as an SRT subtitle file string.
     */
    exportSrt() {
      const selfName = this._getLocalParticipantName();
      const baseTime = this._sessionStartTime || (this.lines.length > 0 ? this.lines[0].timestamp : Date.now());
      return this.lines.map((l, idx) => {
        const start = this._msToSrt(l.timestamp - baseTime);
        const endMs = this.lines[idx + 1] ? (this.lines[idx + 1].timestamp - baseTime) : (l.timestamp - baseTime) + 2500;
        const end = this._msToSrt(endMs);
        const speakerName = (l.speaker === 'You' && selfName) ? selfName : l.speaker;
        const speaker = speakerName ? `${speakerName}: ` : '';
        return `${idx + 1}\n${start} --> ${end}\n${speaker}${l.text}\n`;
      }).join('\n');
    }

    /**
     * Checks if Google Meet's closed caption button is currently active (captions enabled).
     * @returns {boolean}
     */
    isMeetCaptionsButtonActive() {
      // In Google Meet, button aria-label says "Turn off captions" or has aria-pressed="true"
      const turnOffBtn = document.querySelector(
        'button[aria-label*="turn off captions" i], ' +
        'button[aria-label*="disable captions" i], ' +
        'button[aria-pressed="true"][aria-label*="caption" i]'
      );
      if (turnOffBtn) return true;

      // If button says "Turn on captions", CC is currently OFF
      const turnOnBtn = document.querySelector(
        'button[aria-label*="turn on captions" i], ' +
        'button[aria-label*="enable captions" i], ' +
        'button[aria-pressed="false"][aria-label*="caption" i]'
      );
      if (turnOnBtn) return false;

      // Fallback: check if an active caption container exists in the DOM
      return Boolean(this._findCaptionsContainer());
    }

    /**
     * Automatically triggers closed captions in Google Meet by clicking the CC button
     * or dispatching the standard 'c' keyboard shortcut.
     * @returns {boolean}
     */
    tryEnableMeetCaptions() {
      // 1. Look for Meet's CC button in the bottom bar
      const turnOnBtn = document.querySelector(
        'button[aria-label*="turn on captions" i], ' +
        'button[aria-label*="enable captions" i], ' +
        'button[aria-pressed="false"][aria-label*="caption" i]'
      );
      if (turnOnBtn) {
        turnOnBtn.click();
        console.log('[Meetrix] Automatically clicked Google Meet "Turn on captions" button.');
        return true;
      }

      // 2. Fallback: simulate 'c' key press in Google Meet
      try {
        const keyEvt = new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          keyCode: 67,
          which: 67,
          bubbles: true,
          cancelable: true
        });
        document.dispatchEvent(keyEvt);
        console.log('[Meetrix] Dispatched "c" key shortcut for captions.');
        return true;
      } catch (e) {
        return false;
      }
    }

    // ----------------------------------------------------------------
    // Caption container watch & polling
    // ----------------------------------------------------------------

    _startContainerWatch() {
      if (this._containerWatchInterval) clearInterval(this._containerWatchInterval);

      // Check immediately
      this._checkCaptionsState();

      // Poll at 600ms for responsive state changes
      this._containerWatchInterval = setInterval(() => {
        if (!this.isActive) {
          this._stopContainerWatch();
          return;
        }
        this._checkCaptionsState();
      }, 600);
    }

    _stopContainerWatch() {
      if (this._containerWatchInterval) {
        clearInterval(this._containerWatchInterval);
        this._containerWatchInterval = null;
      }
    }

    _checkCaptionsState() {
      const isButtonOn = this.isMeetCaptionsButtonActive();
      const container = this._findCaptionsContainer();

      const isLive = Boolean(isButtonOn || container);

      if (isLive && !this._captionsEnabled) {
        this._captionsEnabled = true;
        this._notifyListeners({ type: 'status', captionsActive: true, message: 'Recording captions…' });
      } else if (!isLive && this._captionsEnabled) {
        this._captionsEnabled = false;
        this._notifyListeners({ type: 'status', captionsActive: false, message: 'Waiting for Meet captions…' });
      }

      if (container && container !== this._observedContainer) {
        this._observedContainer = container;
        this._disconnectCaptionObserver();
        this._attachCaptionObserver(container);
      } else if (!container && this._observedContainer) {
        this._observedContainer = null;
        this._disconnectCaptionObserver();
      }

      // Periodic scan if container is active to ensure no mutations are missed
      if (container && this.isActive) {
        this._scanCaptionContainer(container);
      }
    }

    /**
     * Determines whether an element or any of its ancestors is an interface control,
     * settings menu, language picker, dialog, toolbar, or sidebar that must NOT
     * be captured as speech captions.
     * @param {Element} el
     * @returns {boolean}
     */
    _isExcludedUIElement(el) {
      if (!el || !(el instanceof Element)) return true;
      try {
        const excludedAncestor = el.closest(
          '[role="dialog"], ' +
          '[role="menu"], ' +
          '[role="listbox"], ' +
          '[role="tooltip"], ' +
          '[role="tabpanel"], ' +
          '[role="toolbar"], ' +
          'aside, ' +
          'nav, ' +
          '[aria-modal="true"], ' +
          '.goog-menu, ' +
          'div[aria-label*="settings" i], ' +
          'div[aria-label*="language" i], ' +
          'div[aria-label*="call controls" i], ' +
          'div[aria-label*="bottom bar" i], ' +
          'div[aria-label*="chat" i], ' +
          'div[aria-label*="people" i], ' +
          'div[aria-label*="activities" i], ' +
          'div[aria-label*="participant" i], ' +
          '.meetrix-overlay, ' +
          '#meetrix-root'
        );
        return Boolean(excludedAncestor);
      } catch (e) {
        return false;
      }
    }

    /**
     * Resolves the current local participant's display name from available metadata
     * (e.g. MeetrixParticipantDetector, MeetrixAttendanceTracker, or Meet DOM markers).
     * @returns {string|null}
     */
    _getLocalParticipantName() {
      try {
        // 1. Check MeetrixParticipantDetector if available
        const pd = root.MeetrixParticipantDetector;
        if (pd) {
          if (pd.selfName && pd.selfName.toLowerCase() !== 'you') {
            return pd.selfName;
          }
          if (typeof pd.detectSelfName === 'function') {
            const detected = pd.detectSelfName(typeof document !== 'undefined' ? document : undefined);
            if (detected && detected.toLowerCase() !== 'you') {
              return detected;
            }
          }
        }

        // 2. Check MeetrixAttendanceTracker if available
        const at = root.MeetrixAttendanceTracker;
        if (at && typeof at.getSummary === 'function') {
          const summary = at.getSummary();
          if (summary && Array.isArray(summary.participants)) {
            const selfP = summary.participants.find(p => p.isSelf);
            if (selfP && selfP.name && selfP.name.toLowerCase() !== 'you') {
              return selfP.name;
            }
          }
        }

        // 3. Inspect DOM for native data-self-name or '(You)' annotations
        if (typeof document !== 'undefined') {
          const selfEl = document.querySelector('[data-self-name]');
          if (selfEl) {
            const val = (selfEl.getAttribute('data-self-name') || '').trim();
            if (val && val.toLowerCase() !== 'you') return val;
          }

          const youElements = document.querySelectorAll('span[title*="(You)" i], div.zWGUib, span.notranslate');
          for (let i = 0; i < youElements.length; i++) {
            const text = (youElements[i].getAttribute('title') || youElements[i].textContent || '').trim();
            if (/\(you\)/i.test(text)) {
              const cleaned = text.replace(/\s*\((?:you|guest|host|co-host)\)/gi, '').trim();
              if (cleaned && cleaned.toLowerCase() !== 'you') {
                return cleaned;
              }
            }
          }
        }
      } catch (e) {
        // Safe catch
      }
      return null;
    }

    /**
     * Resolves a raw speaker string:
     * - Maps "You" to the local participant's actual display name (e.g. "Vishal Maurya") when available.
     * - Preserves the exact display name for remote participants (e.g. "vXExplains").
     * - Never assigns local participant name to remote speech.
     * @param {string|null} rawSpeaker
     * @returns {string|null}
     */
    _resolveSpeaker(rawSpeaker) {
      if (!rawSpeaker) return null;
      let name = rawSpeaker.trim();
      if (!name) return null;

      // Clean trailing colons and punctuation
      name = name.replace(/[:\s]+$/, '').trim();

      // Check if speaker label represents the local participant
      if (/^(?:you|\(you\)|आप)\b/i.test(name) || /\(you\)$/i.test(name)) {
        const selfName = this._getLocalParticipantName();
        if (selfName) {
          return selfName;
        }
        return 'You';
      }

      // Remote participant: strip any trailing role tag (e.g. " (Presenter)")
      name = name.replace(/\s*\((?:presenter|presentation|guest|host|co-host)\)/gi, '').trim();
      return name || null;
    }

    /**
     * Locates the live captions overlay container in Google Meet's DOM across all versions.
     * Strictly avoids language pickers, settings dialogs, sidebars, and arbitrary aria-live regions.
     * @returns {Element|null}
     */
    _findCaptionsContainer() {
      if (typeof document === 'undefined') return null;

      // 1. Direct Google Meet closed captions containers
      const directSelectors = [
        'div[jsname="r4nke"]',
        'div[role="region"][aria-label*="caption" i]',
        'div[role="region"][aria-label*="subtitle" i]',
        'div[role="region"][aria-label*="자막"]',
        'div[jsname="dsyhDe"]',
        'div.iTTPOb:not([role="dialog"]):not([role="menu"])',
        'div.bh44bd:not([role="dialog"]):not([role="menu"])'
      ];

      for (let i = 0; i < directSelectors.length; i++) {
        const el = document.querySelector(directSelectors[i]);
        if (el && !this._isExcludedUIElement(el)) {
          return el;
        }
      }

      // 2. Locate container via active speech text elements (.ygicle, .yg77ob, .VbkSUe, [jsname="tgaKEf"])
      const activeTextEls = document.querySelectorAll(
        '.ygicle, .yg77ob, .VbkSUe, [jsname="tgaKEf"], [jsname="dsjhic"]'
      );
      for (let i = 0; i < activeTextEls.length; i++) {
        const tEl = activeTextEls[i];
        if (this._isExcludedUIElement(tEl)) continue;
        const container = tEl.closest('[jsname="r4nke"], [role="region"], div.iTTPOb, div.bh44bd') ||
                          tEl.closest('.nMcdL, .bj4p3b, [jsname="YSxPC"], .nMHgL')?.parentElement;
        if (container && !this._isExcludedUIElement(container)) {
          return container;
        }
      }

      return null;
    }

    // ----------------------------------------------------------------
    // MutationObserver on the captions container
    // ----------------------------------------------------------------

    _attachCaptionObserver(container) {
      if (this._captionsContainerObserver) this._captionsContainerObserver.disconnect();

      this._captionsContainerObserver = new MutationObserver((mutations) => {
        if (!this.isActive) return;
        this._scanCaptionContainer(container);
      });

      this._captionsContainerObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: false
      });

      // Initial scan
      this._scanCaptionContainer(container);
    }

    _disconnectCaptionObserver() {
      if (this._captionsContainerObserver) {
        this._captionsContainerObserver.disconnect();
        this._captionsContainerObserver = null;
      }
    }

    /**
     * Scans the captions container and ingests all current caption blocks.
     * @param {Element} container
     */
    _scanCaptionContainer(container) {
      if (!container || this._isExcludedUIElement(container)) return;
      const blocks = this._extractCaptionBlocks(container);
      for (const block of blocks) {
        this._ingestCaptionBlock(block);
      }
    }

    /**
     * Extracts structured caption blocks from the container.
     * Excludes UI menus, settings controls, language pickers, and tooltips.
     * Each block has { element: Element|null, speaker: string|null, text: string }
     * @param {Element} container
     * @returns {Array<{element: Element|null, speaker:string|null, text:string}>}
     */
    _extractCaptionBlocks(container) {
      if (!container || this._isExcludedUIElement(container)) return [];
      const blocks = [];

      // Google Meet turn block / row wrappers:
      // Modern Google Meet: .nMcdL, .bj4p3b, [jsname="dsyhDe"]
      // Classic Google Meet: [jsname="YSxPC"], .nMHgL, .nMHgLd, .iTTPOb, .bh44bd
      let rows = Array.from(container.querySelectorAll(
        '.nMcdL, .bj4p3b, [jsname="YSxPC"], .nMHgL, .nMHgLd, .iTTPOb, .bh44bd, [jsname="dsyhDe"]'
      ));

      // Filter out any row inside an excluded UI tree
      rows = rows.filter(r => !this._isExcludedUIElement(r));

      // Prevent duplicate processing if nested matching rows exist
      if (rows.length > 1) {
        const rowSet = new Set(rows);
        rows = rows.filter(r => {
          let p = r.parentElement;
          while (p && p !== container) {
            if (rowSet.has(p)) return false;
            p = p.parentElement;
          }
          return true;
        });
      }

      // If no explicit row classes match, locate turn blocks of genuine speech text elements
      if (rows.length === 0) {
        const textElements = Array.from(container.querySelectorAll(
          '.ygicle, .yg77ob, .VbkSUe, [jsname="tgaKEf"], [jsname="dsjhic"], .a4cQT'
        )).filter(el => !this._isExcludedUIElement(el));

        const uniqueRows = new Set();
        for (const tEl of textElements) {
          let row = tEl.closest('.nMcdL, .bj4p3b, [jsname="YSxPC"], .nMHgL, .nMHgLd, .iTTPOb, .bh44bd, [jsname="dsyhDe"]');
          if (!row) {
            // Traverse up to find ancestor turn container holding a speaker label
            let p = tEl.parentElement;
            while (p && p !== container) {
              if (p.querySelector('.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name]')) {
                row = p;
                break;
              }
              p = p.parentElement;
            }
            if (!row) row = tEl.parentElement;
          }
          if (row && row !== container && !this._isExcludedUIElement(row)) {
            uniqueRows.add(row);
          }
        }
        if (uniqueRows.size > 0) {
          rows = Array.from(uniqueRows);
        } else {
          rows = Array.from(container.children).filter(child => {
            return child instanceof Element && !this._isExcludedUIElement(child);
          });
        }
      }

      for (const item of rows) {
        if (!item || !(item instanceof Element) || this._isExcludedUIElement(item)) continue;

        // 1. Speaker label resolution via verified Google Meet DOM relationships
        let rawSpeaker = null;
        let speakerEl = item.querySelector(
          '.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name], span.zWGUib, div.zWGUib, .jT5e9'
        );

        // Check if item itself is the speaker element
        if (!speakerEl && item.matches('.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name]')) {
          speakerEl = item;
        }

        // Check preceding sibling if item is an adjacent text container
        if (!speakerEl && item.previousElementSibling) {
          speakerEl = item.previousElementSibling.matches('.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name]')
            ? item.previousElementSibling
            : item.previousElementSibling.querySelector('.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name]');
        }

        // Check parent container if item is a nested text block
        if (!speakerEl && item.parentElement && item.parentElement !== container) {
          speakerEl = item.parentElement.querySelector(
            '.NWpY1d, .zs7Du, [jsname="V6T7b"], [data-sender-name], span.zWGUib, div.zWGUib'
          );
        }

        if (speakerEl && !this._isExcludedUIElement(speakerEl)) {
          rawSpeaker = (speakerEl.getAttribute('data-sender-name') || speakerEl.textContent || '').trim();
        }

        // 2. Caption text extraction (prefer leaf speech spans to prevent duplicating parent and child text)
        let text = '';
        let textElements = item.querySelectorAll(
          '.yg77ob, .VbkSUe, span[jsname="dsjhic"]'
        );
        if (textElements.length === 0) {
          textElements = item.querySelectorAll(
            '[jsname="tgaKEf"], .a4cQT, div[jsname="dsjhic"]'
          );
        }
        if (textElements.length > 1) {
          textElements = Array.from(textElements).filter(el => {
            for (let i = 0; i < textElements.length; i++) {
              const other = textElements[i];
              if (other !== el) {
                let p = other.parentElement;
                while (p && p !== item) {
                  if (p === el) return false;
                  p = p.parentElement;
                }
              }
            }
            return true;
          });
        }
        if (textElements.length > 0) {
          const parts = [];
          for (let i = 0; i < textElements.length; i++) {
            const el = textElements[i];
            if (el.matches('.NWpY1d, .zs7Du, [jsname="V6T7b"], .zWGUib')) continue;
            const t = (el.textContent || '').trim();
            if (t) parts.push(t);
          }
          text = parts.join(' ').trim();
        }

        if (!text) {
          // Clone element and strip speaker elements, images, buttons, svgs
          const clone = item.cloneNode(true);
          const toRemove = clone.querySelectorAll(
            '.NWpY1d, .zs7Du, [jsname="V6T7b"], .jT5e9, .zWGUib, img, svg, button, [role="button"]'
          );
          toRemove.forEach(n => n.remove());
          text = (clone.textContent || '').trim();
        }

        // Resolve speaker name (maps "You" -> local display name Vishal Maurya, preserves remote vXExplains)
        const speaker = this._resolveSpeaker(rawSpeaker);

        // Normalize unclear speech tokens from Google Meet (e.g. [inaudible], ...)
        if (text) {
          text = text.replace(/\[\s*(?:inaudible|unintelligible)\s*\]/gi, '[unclear]');
        }

        if (text && text.length >= 1) {
          blocks.push({ element: item, speaker: speaker || null, text });
        }
      }

      return blocks;
    }

    /**
     * Determines whether newText is an interim expansion or minor revision of existingText.
     * @param {string} existingText
     * @param {string} newText
     * @returns {boolean}
     */
    _isInterimExpansion(existingText, newText) {
      if (!existingText || !newText) return false;
      if (newText === existingText) return false;
      // 1. Direct prefix extension
      if (newText.startsWith(existingText)) return true;
      // 2. Token overlap: Meet revised intermediate word
      const oldWords = existingText.split(/\s+/);
      const newWords = newText.split(/\s+/);
      if (newWords.length >= oldWords.length && oldWords.length >= 2) {
        // Check if the beginning words match
        let matching = 0;
        for (let i = 0; i < Math.min(oldWords.length, 3); i++) {
          if (oldWords[i].toLowerCase() === newWords[i].toLowerCase()) matching++;
        }
        if (matching >= Math.min(oldWords.length, 2)) {
          return true;
        }
      }
      return false;
    }

    /**
     * Ingests a caption block into the canonical transcript.
     * Updates interim captions in place, deduplicates lingering DOM mutations,
     * and preserves genuine repeated speech, timestamps, speaker names, and Unicode text.
     * @param {{ element?: Element|null, speaker: string|null, text: string }} block
     */
    _ingestCaptionBlock(block) {
      const { element, speaker, text } = block;
      if (!text || text.trim().length < 1) return;
      let cleanText = text.trim().replace(/\[\s*(?:inaudible|unintelligible)\s*\]/gi, '[unclear]');
      const now = Date.now();

      // Track known DOM elements to update interim captions in-place
      if (!this._rowMap) {
        this._rowMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
      }

      if (element && this._rowMap && typeof element === 'object') {
        const rowData = this._rowMap.get(element);
        if (rowData) {
          // Exact text and speaker unchanged on this DOM row -> skip lingering row
          if (rowData.lastText === cleanText && (rowData.speaker === speaker || (!speaker && rowData.speaker))) {
            return;
          }

          // Text on this same row changed/extended or speaker became identified
          const targetLine = this.lines.find(l => l.id === rowData.lineId);
          if (targetLine) {
            targetLine.text = cleanText;
            targetLine.timestamp = now;
            if (speaker && (!targetLine.speaker || targetLine.speaker === 'Unknown')) {
              targetLine.speaker = speaker;
              rowData.speaker = speaker;
            }
            rowData.lastText = cleanText;
            this._notifyListeners({ type: 'updated', line: { ...targetLine } });
            return;
          }
        }
      }

      // Check if this is an interim continuation of the last line from the same speaker
      const sameSpeakerAsLast = Boolean(
        this._lastLine && (
          (this._lastLine.speaker && speaker && this._lastLine.speaker === speaker) ||
          (!this._lastLine.speaker && !speaker) ||
          (!this._lastLine.speaker && speaker)
        )
      );

      if (sameSpeakerAsLast && now - this._lastLine.timestamp < SAME_SPEAKER_CONTINUATION_MS) {
        // A. Stale interim update (shorter prefix or identical)
        if (this._lastLine.text === cleanText || this._lastLine.text.startsWith(cleanText)) {
          if (speaker && (!this._lastLine.speaker || this._lastLine.speaker === 'Unknown')) {
            this._lastLine.speaker = speaker;
            this._notifyListeners({ type: 'updated', line: { ...this._lastLine } });
          }
          return;
        }

        // B. Legitimate interim expansion
        if (this._isInterimExpansion(this._lastLine.text, cleanText)) {
          this._lastLine.text = cleanText;
          this._lastLine.timestamp = now;
          if (speaker && (!this._lastLine.speaker || this._lastLine.speaker === 'Unknown')) {
            this._lastLine.speaker = speaker;
          }
          if (element && this._rowMap && typeof element === 'object') {
            this._rowMap.set(element, { lineId: this._lastLine.id, lastText: cleanText, speaker: this._lastLine.speaker });
          }
          this._notifyListeners({ type: 'updated', line: { ...this._lastLine } });
          return;
        }
      }

      // Deduplicate: ignore rapid identical duplicate mutations from the same speaker within 2500ms
      // Genuine repetitions after another speaker or after a pause are preserved
      if (
        this._lastLine &&
        this._lastLine.speaker === speaker &&
        this._lastLine.text === cleanText &&
        now - this._lastLine.timestamp < 2500
      ) {
        return;
      }

      // Mark previous line as finalized
      if (this._lastLine) {
        this._lastLine.interim = false;
      }

      // Create new canonical transcript line
      const line = {
        id: ++this._lineIdCounter,
        speaker: speaker || null,
        text: cleanText,
        timestamp: now,
        interim: true,
        source: 'meet-captions'
      };

      this.lines.push(line);
      this._lastLine = line;

      if (element && this._rowMap && typeof element === 'object') {
        this._rowMap.set(element, { lineId: line.id, lastText: cleanText, speaker });
      }

      // Enforce rolling window
      if (this.lines.length > MAX_TRANSCRIPT_LINES) {
        this.lines.splice(0, this.lines.length - MAX_TRANSCRIPT_LINES);
      }

      this._notifyListeners({ type: 'line', line: { ...line } });
    }

    /**
     * Returns formatted full canonical transcript string.
     * Preserves timestamps, speaker names, Hindi, English, and Unicode text.
     * @returns {string}
     */
    getFinalizedTranscriptText() {
      if (!this.lines || this.lines.length === 0) return '';
      return this.lines.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const speaker = l.speaker ? l.speaker : 'Unknown';
        return `[${time}] ${speaker}: ${l.text}`;
      }).join('\n');
    }

    // ----------------------------------------------------------------
    // Stage B — Local AI (interface only, not yet integrated)
    // ----------------------------------------------------------------

    isLocalAiActive() {
      return this._stageB;
    }

    checkLocalAiAvailability() {
      return {
        available: false,
        reason:
          'Local AI transcription (Whisper WASM) is not yet available. ' +
          'It requires a ~150 MB model download and WebAssembly support. ' +
          'Use Google Meet built-in captions for real-time transcription.'
      };
    }

    _releaseAudioResources() {
      if (this._mediaStream) {
        try {
          this._mediaStream.getTracks().forEach(t => t.stop());
        } catch (e) { /* safe */ }
        this._mediaStream = null;
      }
      if (this._audioContext) {
        try { this._audioContext.close(); } catch (e) { /* safe */ }
        this._audioContext = null;
      }
      this._stageB = false;
    }

    // ----------------------------------------------------------------
    // Utility & Notification
    // ----------------------------------------------------------------

    _notifyListeners(event) {
      for (const cb of this.listeners) {
        try { cb(event); } catch (e) { /* safe */ }
      }
      this._forwardToPopup(event);
    }

    _forwardToPopup(event) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ type: 'MEETRIX_CAPTION_EVENT', event }, () => {
            if (chrome.runtime.lastError) { /* popup closed */ }
          });
        }
      } catch (e) { /* context invalidated */ }
    }

    _msToSrt(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      const millis = ms % 1000;
      const pad2 = n => String(n).padStart(2, '0');
      const pad3 = n => String(n).padStart(3, '0');
      return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(millis)}`;
    }
  }

  // Expose singleton
  const manager = new MeetrixCaptionManager();
  root.MeetrixCaptionManager = manager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = manager;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
