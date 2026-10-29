/**
 * Meetrix - Content Script (v2)
 *
 * Injected into meet.google.com to coordinate:
 *   - Participant detection and attendance tracking
 *   - Camera status observation (fast MutationObserver + 1.5s heartbeat)
 *   - Presentation tracking
 *   - Caption transcription (MeetrixCaptionManager)
 *   - Extension messaging with popup and background
 *
 * Safe Lifecycle Guarantees:
 *   - Detects extension context invalidation and tears down all observers/intervals.
 *   - Disconnects old MutationObservers and clears intervals on teardown.
 *   - Allows fresh re-injection without colliding with orphaned scripts.
 *   - Restores saved session from storage upon initialisation or resume.
 *   - Does not scan or write when tracking is manually paused.
 */

(function () {
  'use strict';

  // If a previous instance is running in this tab, cleanly tear it down first
  if (typeof window.__meetrix_teardown === 'function') {
    try {
      window.__meetrix_teardown('Replaced by new content script instance');
    } catch (e) {
      // Safe catch
    }
  }

  let isTornDown = false;
  let activeMeetingId = null;
  let participantObserver = null;
  let tickerInterval = null;
  let isScanning = false;
  let manuallyPaused = false;
  let finalizationPromise = null;
  let endSignalSince = 0;

  const tracker = window.MeetrixAttendanceTracker;
  const participantDetector = window.MeetrixParticipantDetector;
  const presentationDetector = window.MeetrixPresentationDetector;
  const reportGenerator = window.MeetrixReportGenerator;
  const captionManager = window.MeetrixCaptionManager;
  const branding = window.MeetrixBranding;
  let headerPanel = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }

  let transcriptSaveTimer = null;
  if (captionManager && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('meetrix_transcript_' + (detectMeetingId() || ''), data => {
      const recovered = data['meetrix_transcript_' + (detectMeetingId() || '')];
      if (Array.isArray(recovered) && captionManager.lines.length === 0) captionManager.lines = recovered;
    });
    captionManager.onUpdate(() => {
      clearTimeout(transcriptSaveTimer);
      transcriptSaveTimer = setTimeout(() => {
        const id = tracker && tracker.meetingId || detectMeetingId();
        if (id) chrome.storage.local.set({ ['meetrix_transcript_' + id]: captionManager.getLines() });
      }, 1000);
    });
  }

  /**
   * Robustly checks whether the extension execution context is still valid.
   * @returns {boolean}
   */
  function isContextValid() {
    const storage = window.MeetrixStorage;
    if (storage && typeof storage.isContextValid === 'function') {
      return storage.isContextValid();
    }
    try {
      return typeof chrome !== 'undefined' &&
             typeof chrome.runtime !== 'undefined' &&
             Boolean(chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * Halts all tracking, disconnects MutationObservers, clears intervals, destroys tracker.
   * @param {string} reason
   */
  function teardown(reason = 'Unknown') {
    if (isTornDown) return;
    isTornDown = true;
    console.warn(`[Meetrix] Tearing down content script (${reason}).`);

    if (participantObserver) {
      try { participantObserver.disconnect(); } catch (e) { /* safe */ }
      participantObserver = null;
    }

    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }

    if (tracker && typeof tracker.destroy === 'function') {
      tracker.destroy();
    }

    if (captionManager && captionManager.isActive) {
      captionManager.stop();
    }

    if (headerPanel) {
      try { headerPanel.destroy(); } catch (e) { /* safe */ }
      headerPanel = null;
    }

    window.__meetrix_initialized = false;
    window.__meetrix_listener_registered = false;
  }

  // Register teardown hook on window
  window.__meetrix_teardown = teardown;
  window.__meetrix_initialized = true;

  // Link tracker context invalidation to content script teardown
  if (tracker) {
    tracker.onContextInvalidated = () => {
      teardown('Tracker detected invalidated context');
    };
  }

  console.log(
    '%c Meetrix %c Active Meeting Tracker v1.1 initialized.',
    'background:#0f172a;color:#38bdf8;font-weight:bold;padding:2px 4px;border-radius:3px;',
    'color:#10b981;'
  );

  /**
   * Extracts the meeting ID from current URL.
   * @returns {string|null}
   */
  function detectMeetingId() {
    const pathname = window.location.pathname.replace(/^\//, '').split('?')[0];
    const meetCodeMatch = pathname.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    if (meetCodeMatch) return meetCodeMatch[1].toLowerCase();
    if (pathname && pathname.length >= 3 && !['landing', 'about', 'help', 'calls'].includes(pathname.toLowerCase())) {
      return pathname.toLowerCase();
    }
    return null;
  }

  /**
   * Determines if the user is actually inside an active meeting call.
   * @returns {boolean}
   */
  function isInActiveMeeting() {
    // If meeting ended overlay is shown, call is no longer active
    if (document.querySelector('[data-call-ended], [data-meeting-ended]')) {
      return false;
    }

    // If lobby or pre-join screen is shown, call is not yet joined
    if (document.querySelector('button[aria-label*="Join now" i], button[aria-label*="Ask to join" i], [data-is-lobby]')) {
      return false;
    }

    const indicators = document.querySelectorAll(
      'button[aria-label*="Leave call" i], ' +
      'button[aria-label*="leave meeting" i], ' +
      'button[aria-label*="end call" i], ' +
      'div[aria-label*="Call controls" i], ' +
      'div[data-meeting-title], ' +
      'div[data-allocation-index], ' +
      'div[data-participant-id], ' +
      'div.zWGUib, ' +
      'div.PoLmKc, ' +
      'button[aria-label*="turn off microphone" i], ' +
      'button[aria-label*="turn on microphone" i], ' +
      'button[aria-label*="turn off camera" i], ' +
      'button[aria-label*="turn on camera" i], ' +
      'button[aria-label*="raise hand" i]'
    );
    return indicators.length > 0;
  }

  /**
   * Loads the manual tracking state from chrome.storage.
   * Tracking defaults to false on new meetings until the user clicks Start.
   * @returns {Promise<boolean>}
   */
  async function loadTrackingState() {
    if (!isContextValid()) return false;
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get('meetrix_tracking_active', (data) => {
            if (chrome.runtime.lastError) { resolve(false); return; }
            resolve(data['meetrix_tracking_active'] === true);
          });
        } else {
          resolve(false);
        }
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * Saves tracking state to chrome.storage for cross-context persistence.
   * @param {boolean} isActive
   */
  function saveTrackingState(isActive) {
    if (!isContextValid()) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ 'meetrix_tracking_active': isActive }, () => {
          if (chrome.runtime.lastError) { /* Ignored if service worker idle */ }
        });
      }
    } catch (e) { /* Safe catch */ }
  }

  async function finalizeMeeting(reason = 'manual-stop') {
    if (finalizationPromise) return finalizationPromise;
    if (!tracker || !tracker.meetingId || !window.MeetrixStorage) return { success: false, error: 'No active meeting data is available.' };
    finalizationPromise = (async () => {
      const recoveryKey = `meetrix_report_${tracker.meetingId}`;
      const prior = await new Promise(resolve => chrome.storage.local.get(recoveryKey, data => resolve(data[recoveryKey] || null)));
      if (prior && prior.status === 'saved') return { success: true, filename: prior.filename, alreadyFinalized: true };
      if (prior && prior.status === 'pending' && prior.html) {
        const retryResult = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'MEETRIX_SAVE_HTML_REPORT', html: prior.html, filename: prior.filename }, response => resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : response)));
        if (retryResult && retryResult.success) {
          await new Promise((resolve, reject) => chrome.storage.local.set({ [recoveryKey]: { ...prior, status: 'saved', downloadId: retryResult.downloadId } }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
          return { success: true, filename: prior.filename, alreadyFinalized: true };
        }
        return { success: false, error: retryResult && retryResult.error || 'Retry failed; report data remains available.' };
      }
      manuallyPaused = true;
      tracker.isTracking = false;
      if (captionManager && captionManager.isActive) captionManager.stop();
      clearTimeout(transcriptSaveTimer);
      const persisted = await tracker.persist();
      const session = persisted || await window.MeetrixStorage.getSession(tracker.meetingId) || {};
      let lines = captionManager ? captionManager.getLines() : [];
      if (!lines.length) {
        const recovered = await new Promise(resolve => chrome.storage.local.get('meetrix_transcript_' + tracker.meetingId, data => resolve(data['meetrix_transcript_' + tracker.meetingId] || [])));
        lines = recovered;
      }
      const participantsList = Object.values(session.participants || Object.fromEntries(tracker.participants || []));
      if (!participantsList.length && !lines.length && reason !== 'manual-stop') {
        return { success: false, error: 'No meeting attendance or captions were recorded.' };
      }
      const endedAt = Date.now();
      const reportData = {
        meetingDetails: { meetingId: tracker.meetingId, startTime: tracker.startTime, endTime: endedAt, duration: tracker.startTime ? `${Math.max(0, Math.round((endedAt - tracker.startTime) / 60000))} min` : 'Not recorded' },
        participants: participantsList,
        transcript: lines
      };
      let aiInsight = null;
      if (lines.length) {
        try {
          const aiResult = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'MEETRIX_GENERATE_SUMMARY', transcript: JSON.stringify(lines) }, response => resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : response)));
          if (aiResult && aiResult.success && aiResult.insight) aiInsight = aiResult.insight;
          else console.warn('[Meetrix] NVIDIA summary unavailable; preserving original captions and using local summary.', aiResult && aiResult.error);
        } catch (error) { console.warn('[Meetrix] NVIDIA summary unavailable; using local summary.', error); }
      }
      reportData.aiInsight = aiInsight;
      const html = reportGenerator.buildHtmlReport(reportData);
      const filename = reportGenerator.generateHtmlFilename(tracker.startTime || endedAt);
      await new Promise((resolve, reject) => chrome.storage.local.set({ ['meetrix_transcript_' + tracker.meetingId]: lines, [recoveryKey]: { meetingId: tracker.meetingId, filename, html, status: 'pending', reason, savedAt: endedAt, reportData } }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
      const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'MEETRIX_SAVE_HTML_REPORT', html, filename }, response => resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : response || { success: false, error: 'No download response.' })));
      if (result && result.success) {
        await new Promise((resolve, reject) => chrome.storage.local.set({ [recoveryKey]: { meetingId: tracker.meetingId, filename, html, status: 'saved', downloadId: result.downloadId, savedAt: endedAt, reportData } }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
        return { success: true, filename };
      }
      return { success: false, error: result && result.error || 'Download failed; report data remains available for retry.' };
    })().catch(error => ({ success: false, error: error.message || 'Finalization failed; meeting data was retained.' })).finally(() => {
      finalizationPromise = null;
      if (headerPanel) headerPanel.updateState();
    });
    return finalizationPromise;
  }

  window.__meetrix_finalizeMeeting = finalizeMeeting;

  // A stable Meet end screen must remain present before automatic finalization.
  setInterval(() => {
    if (isTornDown || !tracker || !tracker.meetingId || !tracker.isTracking || manuallyPaused) { endSignalSince = 0; return; }
    const ended = !!document.querySelector('[data-call-ended], [data-meeting-ended]') || /you left the meeting|call has ended|meeting has ended/i.test(document.body ? document.body.innerText.slice(-2500) : '');
    if (!ended) { endSignalSince = 0; return; }
    if (!endSignalSince) endSignalSince = Date.now();
    if (Date.now() - endSignalSince >= 12000) finalizeMeeting('confirmed-meeting-end');
  }, 2000);

  /**
   * Core scanning tick: reads DOM, updates presentation and attendance state.
   */
  async function performScan() {
    if (isTornDown) return;
    if (isScanning) return;

    if (!isContextValid()) {
      teardown('Extension context invalidated during scan');
      return;
    }

    isScanning = true;

    try {
      const detectedId = detectMeetingId();
      if (!detectedId) { isScanning = false; return; }

      if (!isInActiveMeeting()) {
        if (headerPanel) headerPanel.updateState();
        isScanning = false;
        return;
      }

      // Check if meeting ID changed or session needs initiation
      if (activeMeetingId !== detectedId) {
        activeMeetingId = detectedId;
        const previouslyActive = await loadTrackingState();
        manuallyPaused = !previouslyActive;

        if (tracker) {
          await tracker.initSession(activeMeetingId);
          tracker.isTracking = previouslyActive;
        }

        if (previouslyActive && captionManager && !captionManager.isActive) {
          captionManager.startCaptionObserver();
        }
      }

      // Mount or reposition the compact header control panel inside active meeting
      if (headerPanel) {
        headerPanel.mount();
      }

      if (!tracker || !tracker.isTracking || manuallyPaused) {
        if (headerPanel) headerPanel.updateState();
        isScanning = false;
        return;
      }

      // 1. Detect presentation and presenter
      const selfName = participantDetector ? participantDetector.detectSelfName(document) : '';
      const presentationInfo = presentationDetector
        ? presentationDetector.detectActivePresentation(document, selfName)
        : { isPresenting: false, presenterName: null };

      // 2. Detect visible participants
      const detectedList = participantDetector
        ? participantDetector.scanParticipants(document)
        : [];

      // 3. Update attendance tracker
      await tracker.update(detectedList, presentationInfo);

      // 4. Update background badge
      const summary = tracker.getSummary();
      sendBackgroundUpdate(summary);

      if (headerPanel) {
        headerPanel.updateState();
      }

    } catch (err) {
      console.warn('[Meetrix] Scan error:', err);
    } finally {
      isScanning = false;
    }
  }

  /**
   * Sends update to background script to update badge or icon state.
   */
  function sendBackgroundUpdate(summary) {
    if (isTornDown) return;
    if (!isContextValid()) {
      teardown('Extension context invalidated before message send');
      return;
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'MEETRIX_STATE_UPDATED',
          meetingId: activeMeetingId,
          presentCount: summary.currentlyPresent,
          totalObserved: summary.totalObserved,
          isPresenting: summary.isPresenting
        }, () => {
          if (chrome.runtime.lastError) {
            const msg = (chrome.runtime.lastError.message || '').toLowerCase();
            if (msg.includes('context invalidated')) {
              teardown('Extension context invalidated during message callback');
            }
          }
        });
      } catch (e) {
        const msg = (e && e.message ? e.message : String(e)).toLowerCase();
        if (msg.includes('context invalidated')) {
          teardown('Extension context invalidated during sendMessage invocation');
        }
      }
    }
  }

  /**
   * Sets up MutationObserver with aggressive camera-focused attribute watching.
   *
   * Camera ON/OFF detection improvements:
   *   - Debounce reduced from 800ms → 200ms for camera-related attribute changes.
   *   - Heartbeat reduced from 2500ms → 1500ms.
   *   - Attribute filter expanded to include 'data-is-muted', 'data-camera-state',
   *     'src' (for avatar image swaps), and 'style' (for video visibility toggling).
   */
  function initObserver() {
    if (isTornDown) return;
    if (participantObserver) participantObserver.disconnect();

    let debounceTimer = null;
    let fastDebounceTimer = null;

    participantObserver = new MutationObserver((mutations) => {
      if (isTornDown) return;

      // Check whether any mutation is camera-relevant for fast-path response
      const isCameraRelated = mutations.some(m => {
        if (m.type === 'attributes') {
          const attr = m.attributeName || '';
          return (
            attr === 'aria-label' ||
            attr === 'data-camera-state' ||
            attr === 'data-is-muted' ||
            attr === 'style' ||
            attr === 'src' ||
            attr === 'class'
          );
        }
        if (m.type === 'childList') {
          for (let i = 0; i < m.addedNodes.length; i++) {
            const n = m.addedNodes[i];
            if (n.nodeType === 1) {
              if (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video'))) return true;
              if (n.hasAttribute && (n.hasAttribute('data-avatar-url') || n.hasAttribute('data-initials'))) return true;
            }
          }
          for (let i = 0; i < m.removedNodes.length; i++) {
            const n = m.removedNodes[i];
            if (n.nodeType === 1) {
              if (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video'))) return true;
            }
          }
        }
        return false;
      });

      // Fast path for camera-relevant mutations: 150ms debounce
      if (isCameraRelated) {
        if (fastDebounceTimer) clearTimeout(fastDebounceTimer);
        fastDebounceTimer = setTimeout(() => {
          if (!isTornDown) performScan();
        }, 150);
        return;
      }

      // Standard path for participant add/remove: 400ms debounce
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!isTornDown) performScan();
      }, 400);
    });

    participantObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'aria-label',
        'data-self-name',
        'data-is-screen-share',
        'data-camera-state',
        'data-is-muted',
        'title',
        'class',
        'style',
        'src'
      ]
    });

    // Heartbeat at 1200ms
    if (tickerInterval) clearInterval(tickerInterval);
    tickerInterval = setInterval(() => {
      if (!isTornDown) performScan();
    }, 1200);

    // Initial scan
    performScan();
  }

  /**
   * Registers the chrome.runtime.onMessage listener cleanly.
   */
  function ensureMessageListener() {
    if (isTornDown) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
    if (window.__meetrix_listener_registered) return;
    window.__meetrix_listener_registered = true;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (isTornDown) {
        sendResponse({ success: false, error: 'Content script torn down' });
        return true;
      }

      // PING/PONG handshake
      if (request.type === 'MEETRIX_PING') {
        sendResponse({ pong: true, meetingId: activeMeetingId, isInCall: isInActiveMeeting() });
        return true;
      }

      if (request.type === 'MEETRIX_GET_STATUS') {
        const inCall = isInActiveMeeting();
        const currentId = detectMeetingId();
        const summary = tracker ? tracker.getSummary() : null;
        const captionStatus = captionManager
          ? {
              isActive: captionManager.isActive,
              captionsEnabled: captionManager._captionsEnabled,
              lineCount: captionManager.lines.length
            }
          : null;

        sendResponse({
          isInCall: inCall,
          meetingId: currentId || (tracker ? tracker.meetingId : null),
          summary: summary,
          isTracking: !manuallyPaused && (tracker ? tracker.isTracking : false),
          captionStatus
        });
        return true;
      }

      if (request.type === 'MEETRIX_RESET_SESSION') {
        if (tracker) {
          tracker.resetSession().then(() => {
            manuallyPaused = false;
            saveTrackingState(true);
            performScan().then(() => {
              sendResponse({ success: true, summary: tracker.getSummary() });
            });
          });
          return true;
        }
        sendResponse({ success: false, error: 'Tracker not initialized' });
        return true;
      }

      if (request.type === 'MEETRIX_TRIGGER_SCAN') {
        performScan().then(() => {
          sendResponse({ success: true, summary: tracker ? tracker.getSummary() : null });
        });
        return true;
      }

      if (request.type === 'MEETRIX_DOWNLOAD_REPORT') {
        if (tracker && reportGenerator) {
          const summary = tracker.getSummary();
          reportGenerator.downloadReport(summary.participants)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
          return true;
        }
        sendResponse({ success: false, error: 'Tracker or report generator not available' });
        return true;
      }

      if (request.type === 'MEETRIX_START_TRACKING') {
        manuallyPaused = false;
        saveTrackingState(true);
        if (tracker) {
          tracker.isTracking = true;
          tracker.isDirty = true;
          const meetId = detectMeetingId();
          if (meetId && !tracker.meetingId) {
            tracker.initSession(meetId).then(() => {
              performScan().then(() => {
                if (headerPanel) headerPanel.updateState();
                sendResponse({ success: true, summary: tracker.getSummary(), isTracking: true });
              });
            });
          } else {
            performScan().then(() => {
              if (headerPanel) headerPanel.updateState();
              sendResponse({ success: true, summary: tracker.getSummary(), isTracking: true });
            });
          }
        } else {
          sendResponse({ success: false, error: 'Tracker not available', isTracking: true });
        }
        return true;
      }

      if (request.type === 'MEETRIX_STOP_TRACKING') {
        finalizeMeeting('manual-stop').then(result => {
          saveTrackingState(false);
          if (headerPanel) headerPanel.updateState();
          sendResponse({ ...result, isTracking: false, summary: tracker ? tracker.getSummary() : null });
        });
        return true;
      }

      // Caption controls
      if (request.type === 'MEETRIX_START_CAPTIONS') {
        if (captionManager) {
          captionManager.startCaptionObserver();
          sendResponse({
            success: true,
            active: captionManager.isActive,
            captionsEnabled: captionManager._captionsEnabled
          });
        } else {
          sendResponse({ success: false, error: 'Caption manager not available' });
        }
        return true;
      }

      if (request.type === 'MEETRIX_ENABLE_MEET_CAPTIONS') {
        if (captionManager) {
          const clicked = captionManager.tryEnableMeetCaptions();
          sendResponse({ success: true, clicked, captionsEnabled: captionManager._captionsEnabled });
        } else {
          sendResponse({ success: false });
        }
        return true;
      }

      if (request.type === 'MEETRIX_STOP_CAPTIONS') {
        if (captionManager) {
          captionManager.stop();
          sendResponse({ success: true, active: false });
        } else {
          sendResponse({ success: false, error: 'Caption manager not available' });
        }
        return true;
      }

      if (request.type === 'MEETRIX_GET_TRANSCRIPT') {
        if (captionManager) {
          sendResponse({
            success: true,
            lines: captionManager.getLines(),
            finalizedText: typeof captionManager.getFinalizedTranscriptText === 'function' ? captionManager.getFinalizedTranscriptText() : '',
            active: captionManager.isActive,
            captionsEnabled: captionManager._captionsEnabled
          });
        } else {
          sendResponse({ success: false, error: 'Caption manager not available', lines: [] });
        }
        return true;
      }

      if (request.type === 'MEETRIX_CLEAR_TRANSCRIPT') {
        if (captionManager) {
          captionManager.clearTranscript();
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false });
        }
        return true;
      }

      if (request.type === 'MEETRIX_EXPORT_TRANSCRIPT') {
        if (captionManager) {
          const format = request.format || 'txt';
          const content = format === 'srt' ? captionManager.exportSrt() : captionManager.exportTxt();
          sendResponse({ success: true, content, format });
        } else {
          sendResponse({ success: false, error: 'Caption manager not available' });
        }
        return true;
      }

      if (request.type === 'MEETRIX_CHECK_LOCAL_AI') {
        if (captionManager) {
          sendResponse({ success: true, ...captionManager.checkLocalAiAvailability() });
        } else {
          sendResponse({ success: false, available: false, reason: 'Caption manager not available' });
        }
        return true;
      }
    });
  }

  // Register message listener
  ensureMessageListener();

  // Save state on page unload
  window.addEventListener('beforeunload', () => {
    if (!isTornDown && tracker) tracker.persist();
    teardown('Page unload');
  });

  window.addEventListener('pagehide', () => {
    if (!isTornDown && tracker) tracker.persist();
    teardown('Page hide');
  });

  /**
   * MEETRIX AI - Google Meet Header Floating Control Panel
   *
   * Positions a compact, single-row black-and-yellow control panel directly
   * inside the top Google Meet header row on the exact same horizontal line as the
   * meeting code and participant count:
   *   Meeting Code | [ MEETRIX AI Start Stop Download View Menu ] | Participants Count
   */
  class MeetrixHeaderPanel {
    constructor() {
      this.container = null;
      this.detailMenu = null;
      this.isMenuOpen = false;
      this.activeTab = 'participants';
      this.toastTimer = null;
      this.repositionRaf = null;
      this.onWindowResize = this.onWindowResize.bind(this);
      this.onDocumentClick = this.onDocumentClick.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      window.addEventListener('resize', this.onWindowResize);
    }

    onWindowResize() {
      if (this.repositionRaf) cancelAnimationFrame(this.repositionRaf);
      this.repositionRaf = requestAnimationFrame(() => {
        this.reposition();
      });
    }

    onDocumentClick(e) {
      if (!this.isMenuOpen) return;
      if (this.container && this.container.contains(e.target)) return;
      this.closeMenu();
    }

    onKeyDown(e) {
      if (e.key === 'Escape' && this.isMenuOpen) {
        this.closeMenu();
      }
    }

    injectStyles() {
      if (document.getElementById('meetrix-header-styles')) return;
      const style = document.createElement('style');
      style.id = 'meetrix-header-styles';
      style.textContent = `
        #meetrix-header-control {
          position: fixed;
          height: 38px;
          background: rgba(10, 10, 14, 0.96);
          border: 1px solid rgba(234, 179, 8, 0.7);
          border-radius: 9999px;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.8), 0 0 12px rgba(234, 179, 8, 0.2);
          display: inline-flex;
          align-items: center;
          padding: 0 8px 0 12px;
          gap: 8px;
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          user-select: none;
          box-sizing: border-box;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        #meetrix-header-control:hover {
          border-color: #facc15;
          box-shadow: 0 6px 22px rgba(0, 0, 0, 0.85), 0 0 16px rgba(250, 204, 21, 0.3);
        }
        #meetrix-header-control * {
          box-sizing: border-box;
        }
        .meetrix-brand-group {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          user-select: none;
        }
        .meetrix-brand-emblem-img {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          box-shadow: 0 0 6px rgba(234, 179, 8, 0.45);
        }
        .meetrix-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #71717a;
          transition: background 0.25s ease, box-shadow 0.25s ease;
          flex-shrink: 0;
        }
        .meetrix-status-dot.active {
          background: #22c55e;
          box-shadow: 0 0 10px #22c55e;
          animation: meetrixPulse 2s infinite ease-in-out;
        }
        @keyframes meetrixPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.65; transform: scale(1.15); }
        }
        .meetrix-brand-text {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.05em;
          color: #ffffff;
          display: inline-flex;
          align-items: center;
          white-space: nowrap;
        }
        .meetrix-brand-ai-badge {
          background: #facc15;
          color: #09090b;
          font-size: 8.5px;
          font-weight: 800;
          padding: 1px 3.5px;
          border-radius: 3px;
          margin-left: 3px;
          letter-spacing: 0.04em;
          vertical-align: middle;
        }
        .meetrix-divider {
          width: 1px;
          height: 18px;
          background: rgba(234, 179, 8, 0.35);
          margin: 0 2px;
        }
        .meetrix-actions-group {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .meetrix-btn {
          height: 28px;
          padding: 0 11px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          border: 1px solid transparent;
          outline: none;
          background: transparent;
          transition: all 0.15s ease;
          white-space: nowrap;
        }
        .meetrix-btn:active {
          transform: scale(0.97);
        }
        .meetrix-btn-start {
          background: #18181b;
          color: #fef08a;
          border-color: rgba(234, 179, 8, 0.45);
        }
        .meetrix-btn-start:hover:not(:disabled) {
          background: #facc15;
          color: #09090b;
          border-color: #facc15;
          box-shadow: 0 0 12px rgba(250, 204, 21, 0.45);
        }
        .meetrix-btn-start:disabled {
          opacity: 0.45;
          cursor: default;
          background: #18181b;
          color: #71717a;
          border-color: #27272a;
        }
        .meetrix-btn-stop {
          background: #18181b;
          color: #71717a;
          border-color: #27272a;
        }
        .meetrix-btn-stop:not(:disabled) {
          background: #27272a;
          color: #f87171;
          border-color: rgba(239, 68, 68, 0.5);
        }
        .meetrix-btn-stop:not(:disabled):hover {
          background: #ef4444;
          color: #ffffff;
          border-color: #ef4444;
          box-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
        }
        .meetrix-btn-stop:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .meetrix-btn-download {
          background: #18181b;
          color: #e4e4e7;
          border-color: rgba(234, 179, 8, 0.35);
        }
        .meetrix-btn-download:hover {
          background: #27272a;
          color: #facc15;
          border-color: #facc15;
        }
        .meetrix-btn-view {
          background: #18181b;
          color: #facc15;
          border-color: rgba(234, 179, 8, 0.5);
        }
        .meetrix-btn-view:hover, .meetrix-btn-view.active {
          background: #eab308;
          color: #09090b;
          border-color: #eab308;
          box-shadow: 0 0 12px rgba(234, 179, 8, 0.4);
        }

        #meetrix-header-control.meetrix-compact .meetrix-btn-text {
          display: none;
        }
        #meetrix-header-control.meetrix-compact .meetrix-btn {
          padding: 0 8px;
        }
        #meetrix-header-control.meetrix-ultra-compact .meetrix-brand-text {
          display: none;
        }

        .meetrix-toast {
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          background: #09090b;
          color: #facc15;
          border: 1px solid rgba(234, 179, 8, 0.6);
          border-radius: 6px;
          padding: 6px 14px;
          font-size: 11.5px;
          font-weight: 600;
          white-space: nowrap;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.85);
          pointer-events: none;
          z-index: 10002;
          animation: meetrixFadeIn 0.2s ease;
        }

        #meetrix-detail-menu {
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          width: 500px;
          max-width: calc(100vw - 28px);
          max-height: 540px;
          background: rgba(12, 12, 16, 0.98);
          border: 1px solid rgba(234, 179, 8, 0.6);
          border-radius: 12px;
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.9), 0 0 18px rgba(234, 179, 8, 0.18);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          color: #f4f4f5;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          z-index: 10001;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: meetrixSlideDown 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes meetrixSlideDown {
          from { opacity: 0; transform: translate(-50%, -8px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes meetrixFadeIn {
          from { opacity: 0; transform: translate(-50%, -4px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        .meetrix-menu-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px 10px;
          border-bottom: 1px solid rgba(234, 179, 8, 0.2);
          background: rgba(24, 24, 28, 0.65);
        }
        .meetrix-menu-title-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .meetrix-dashboard-emblem-img {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          box-shadow: 0 0 8px rgba(234, 179, 8, 0.45);
        }
        .meetrix-menu-badge {
          background: #facc15;
          color: #09090b;
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.05em;
          padding: 2.5px 7px;
          border-radius: 4px;
        }
        .meetrix-menu-title {
          font-size: 13.5px;
          font-weight: 700;
          color: #ffffff;
        }
        .meetrix-menu-mid-tag {
          font-size: 11px;
          font-family: ui-monospace, monospace;
          background: rgba(255, 255, 255, 0.08);
          color: #e4e4e7;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .meetrix-menu-close-btn {
          background: transparent;
          border: none;
          color: #a1a1aa;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 4px;
          transition: color 0.15s, background 0.15s;
        }
        .meetrix-menu-close-btn:hover {
          color: #facc15;
          background: rgba(255, 255, 255, 0.08);
        }

        .meetrix-metrics-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          padding: 10px 14px;
          background: rgba(18, 18, 22, 0.65);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .meetrix-metric-item {
          background: rgba(24, 24, 28, 0.85);
          border: 1px solid rgba(234, 179, 8, 0.18);
          border-radius: 7px;
          padding: 7px 10px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .meetrix-metric-label {
          font-size: 10px;
          text-transform: uppercase;
          color: #a1a1aa;
          letter-spacing: 0.04em;
        }
        .meetrix-metric-val {
          font-size: 13.5px;
          font-weight: 700;
          color: #facc15;
        }

        .meetrix-menu-tabs {
          display: flex;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: #111116;
          padding: 0 10px;
        }
        .meetrix-tab-btn {
          flex: 1;
          padding: 9px 10px;
          font-size: 11.5px;
          font-weight: 600;
          color: #a1a1aa;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          transition: color 0.15s, border-bottom-color 0.15s;
        }
        .meetrix-tab-btn:hover {
          color: #fef08a;
        }
        .meetrix-tab-btn.active {
          color: #facc15;
          border-bottom-color: #facc15;
        }

        .meetrix-menu-content {
          flex: 1;
          overflow-y: auto;
          max-height: 330px;
          padding: 12px 14px;
        }
        .meetrix-tab-pane {
          display: none;
          flex-direction: column;
          gap: 8px;
        }
        .meetrix-tab-pane.active {
          display: flex;
        }

        .meetrix-participant-card {
          background: #18181e;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 9px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .meetrix-participant-name-col {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .meetrix-participant-name {
          font-size: 12.5px;
          font-weight: 600;
          color: #ffffff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .meetrix-participant-sub {
          font-size: 10px;
          color: #a1a1aa;
        }
        .meetrix-participant-badges {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-wrap: wrap;
        }
        .meetrix-tag {
          font-size: 9.5px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
          letter-spacing: 0.02em;
        }
        .meetrix-tag-cam-on { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
        .meetrix-tag-cam-off { background: rgba(113, 113, 122, 0.15); color: #a1a1aa; border: 1px solid rgba(113, 113, 122, 0.25); }
        .meetrix-tag-cam-unk { background: rgba(234, 179, 8, 0.12); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.25); }
        .meetrix-tag-dev { background: rgba(255, 255, 255, 0.06); color: #d4d4d8; border: 1px solid rgba(255, 255, 255, 0.1); }
        .meetrix-tag-status { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }

        .meetrix-caption-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 11px;
          margin-bottom: 6px;
        }
        .meetrix-caption-btn-sm {
          background: #facc15;
          color: #09090b;
          border: none;
          border-radius: 4px;
          font-size: 10.5px;
          font-weight: 700;
          padding: 3px 8px;
          cursor: pointer;
        }
        .meetrix-caption-btn-sm:hover {
          background: #eab308;
        }

        .meetrix-caption-row {
          font-size: 11.5px;
          line-height: 1.5;
          padding: 6px 10px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.03);
          border-left: 2px solid #eab308;
        }
        .meetrix-caption-time {
          font-family: ui-monospace, monospace;
          color: #71717a;
          margin-right: 6px;
          font-size: 10px;
        }
        .meetrix-caption-speaker {
          font-weight: 700;
          color: #facc15;
          margin-right: 4px;
        }

        .meetrix-summary-box {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(234, 179, 8, 0.2);
          border-radius: 8px;
          padding: 10px;
          font-size: 12px;
          line-height: 1.5;
          color: #e4e4e7;
        }
        .meetrix-summary-title {
          font-size: 11px;
          font-weight: 700;
          color: #facc15;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 6px;
        }

        .meetrix-menu-footer {
          padding: 10px 14px;
          background: rgba(18, 18, 22, 0.95);
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }
        .meetrix-footer-btn {
          background: #facc15;
          color: #09090b;
          font-size: 11px;
          font-weight: 700;
          padding: 6px 12px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          transition: background 0.15s;
        }
        .meetrix-footer-btn:hover {
          background: #eab308;
        }
        .meetrix-footer-btn-sec {
          background: rgba(255, 255, 255, 0.08);
          color: #e4e4e7;
          font-size: 11px;
          font-weight: 600;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          cursor: pointer;
        }
        .meetrix-footer-btn-sec:hover {
          background: rgba(255, 255, 255, 0.14);
          color: #ffffff;
        }
      `;
      document.head.appendChild(style);
    }

    findHeaderPlacement() {
      const panelHeight = 38;
      let headerTop = 10;
      let headerHeight = 38;
      let leftBound = 220;
      let rightBound = window.innerWidth - 180;

      // 1. Locate Meeting Code on top-left (r.top <= 80, r.left < innerWidth / 2)
      let codeEl = null;
      const meetCodeRegex = /[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

      const codeSelectors = [
        '[data-meeting-title]',
        '[data-unresolved-meeting-id]',
        '[data-meeting-code]',
        'button[aria-label*="Meeting details" i]'
      ];
      for (const sel of codeSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el && el.offsetParent !== null) {
            const r = el.getBoundingClientRect();
            if (r.top >= 0 && r.top <= 80 && r.left < window.innerWidth / 2 && r.width > 20 && r.width < 360 && r.height > 10 && r.height < 60) {
              codeEl = el;
              break;
            }
          }
        }
        if (codeEl) break;
      }

      // If not found by selector, scan elements with text matching meeting code pattern
      if (!codeEl) {
        const candidates = document.querySelectorAll('div, span, button');
        for (const el of candidates) {
          if (el.children.length <= 2) {
            const txt = (el.textContent || '').trim();
            if (txt && txt.length <= 32 && meetCodeRegex.test(txt)) {
              const r = el.getBoundingClientRect();
              if (r.top >= 0 && r.top <= 80 && r.left < window.innerWidth / 2 && r.width > 20 && r.width < 360 && r.height > 10 && r.height < 60) {
                codeEl = el;
                break;
              }
            }
          }
        }
      }

      // 2. Locate Participant Count / People badge on top-right (r.top <= 80, r.left > innerWidth / 2)
      let partEl = null;
      let minRightX = window.innerWidth;
      const partSelectors = [
        'button[aria-label*="Show everyone" i]',
        'button[aria-label*="People" i]',
        'button[aria-label*="participants" i]',
        'button[aria-label*="Contributors" i]',
        'button[data-panel-id="1"]',
        'div[aria-label*="Show everyone" i]',
        'div[data-panel-id="1"]'
      ];

      for (const sel of partSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el && el.offsetParent !== null) {
            const r = el.getBoundingClientRect();
            if (r.top >= 0 && r.top <= 80 && r.left > window.innerWidth / 2 && r.width > 16 && r.width < 300 && r.height > 10 && r.height < 60) {
              if (r.left < minRightX) {
                minRightX = r.left;
                partEl = el;
              }
            }
          }
        }
      }

      // Also scan for any chip/avatar element in top right header row
      if (!partEl) {
        const topElements = document.querySelectorAll('button, div[role="button"], div[aria-label], span[aria-label]');
        for (const el of topElements) {
          if (el.offsetParent !== null) {
            const r = el.getBoundingClientRect();
            if (r.top >= 0 && r.top <= 80 && r.left > window.innerWidth / 2 && r.width > 16 && r.width < 300 && r.height > 10 && r.height < 60) {
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              if (aria.includes('people') || aria.includes('participant') || aria.includes('everyone') || aria.includes('call') || el.querySelector('img')) {
                if (r.left < minRightX) {
                  minRightX = r.left;
                  partEl = el;
                }
              }
            }
          }
        }
      }

      // 3. Compute horizontal bounds and vertical alignment
      if (codeEl) {
        const cr = codeEl.getBoundingClientRect();
        leftBound = Math.round(cr.right + 16);
        headerTop = cr.top;
        headerHeight = cr.height;
      }

      if (partEl) {
        const pr = partEl.getBoundingClientRect();
        rightBound = Math.round(pr.left - 16);
        if (!codeEl) {
          headerTop = pr.top;
          headerHeight = pr.height;
        } else {
          const midY = (headerTop + headerHeight / 2 + pr.top + pr.height / 2) / 2;
          headerHeight = Math.max(headerHeight, pr.height);
          headerTop = midY - headerHeight / 2;
        }
      }

      // Guardrail sanity limits
      if (leftBound < 100) leftBound = 100;
      if (rightBound > window.innerWidth - 60) rightBound = window.innerWidth - 60;
      if (leftBound >= rightBound - 140) {
        leftBound = 140;
        rightBound = window.innerWidth - 140;
      }

      const alignedTop = Math.max(8, Math.round(headerTop + (headerHeight - panelHeight) / 2));
      const centerX = Math.round((leftBound + rightBound) / 2);
      const maxAvailableWidth = Math.max(280, Math.round(rightBound - leftBound - 12));

      return { alignedTop, centerX, maxAvailableWidth };
    }

    mount() {
      if (isTornDown) return;
      if (!isInActiveMeeting()) {
        if (this.container) this.container.style.display = 'none';
        if (this.isMenuOpen) this.closeMenu();
        return;
      }

      this.injectStyles();

      if (!this.container || !document.body.contains(this.container)) {
        let el = document.getElementById('meetrix-header-control');
        if (!el) {
          el = document.createElement('div');
          el.id = 'meetrix-header-control';
          el.role = 'toolbar';
          el.setAttribute('aria-label', 'MEETRIX AI Control Panel');
          el.innerHTML = `
            <div class="meetrix-brand-group" id="meetrix-brand-click" title="MEETRIX AI Status (Click to open Dashboard)">
              <img src="${(window.MeetrixBranding && window.MeetrixBranding.getEmblemUrl()) || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('icons/icon48.png') : 'icons/icon48.png')}" alt="MEETRIX AI" class="meetrix-brand-emblem-img" />
              <span class="meetrix-status-dot" id="meetrix-live-dot" title="Status: Idle"></span>
              <span class="meetrix-brand-text">MEETRIX<span class="meetrix-brand-ai-badge">AI</span></span>
            </div>
            <div class="meetrix-divider"></div>
            <div class="meetrix-actions-group">
              <button class="meetrix-btn meetrix-btn-start" id="meetrix-btn-start" title="Start Tracking Attendance & Captions">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
                <span class="meetrix-btn-text">Start</span>
              </button>
              <button class="meetrix-btn meetrix-btn-stop" id="meetrix-btn-stop" title="Stop Tracking & Finalize Report" disabled>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
                <span class="meetrix-btn-text">Stop</span>
              </button>
              <button class="meetrix-btn meetrix-btn-download" id="meetrix-btn-download" title="Download Attendance & Summary Report">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span class="meetrix-btn-text">Download</span>
              </button>
              <button class="meetrix-btn meetrix-btn-view" id="meetrix-btn-view" title="Open In-Meeting Dashboard" aria-expanded="false">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                <span class="meetrix-btn-text">View Menu</span>
              </button>
            </div>
          `;
          document.body.appendChild(el);

          el.querySelector('#meetrix-btn-start').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleStartClick();
          });
          el.querySelector('#meetrix-btn-stop').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleStopClick();
          });
          el.querySelector('#meetrix-btn-download').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleDownloadClick();
          });
          el.querySelector('#meetrix-btn-view').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
          });
          el.querySelector('#meetrix-brand-click').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
          });
        }
        this.container = el;
      }

      this.container.style.display = 'inline-flex';
      this.reposition();
      this.updateState();
    }

    reposition() {
      if (!this.container || isTornDown) return;
      const { alignedTop, centerX, maxAvailableWidth } = this.findHeaderPlacement();
      this.container.style.top = `${alignedTop}px`;
      this.container.style.left = `${centerX}px`;
      this.container.style.transform = 'translateX(-50%)';
      this.container.style.maxWidth = `${maxAvailableWidth}px`;

      if (maxAvailableWidth < 460) {
        this.container.classList.add('meetrix-compact');
      } else {
        this.container.classList.remove('meetrix-compact');
      }

      if (maxAvailableWidth < 260) {
        this.container.classList.add('meetrix-ultra-compact');
      } else {
        this.container.classList.remove('meetrix-ultra-compact');
      }
    }

    updateState() {
      if (!this.container || isTornDown) return;
      if (!isInActiveMeeting()) {
        this.container.style.display = 'none';
        if (this.isMenuOpen) this.closeMenu();
        return;
      }
      this.container.style.display = 'inline-flex';

      const isTracking = !manuallyPaused && tracker && tracker.isTracking;
      const dot = this.container.querySelector('#meetrix-live-dot');
      if (dot) {
        if (isTracking) {
          dot.classList.add('active');
          dot.title = 'Status: Tracking Active';
        } else {
          dot.classList.remove('active');
          dot.title = 'Status: Idle (Not Tracking)';
        }
      }

      const startBtn = this.container.querySelector('#meetrix-btn-start');
      if (startBtn) startBtn.disabled = isTracking;

      const stopBtn = this.container.querySelector('#meetrix-btn-stop');
      if (stopBtn) stopBtn.disabled = !isTracking;

      if (this.isMenuOpen) {
        this.updateMenuContent();
      }
    }

    toggleMenu() {
      if (this.isMenuOpen) {
        this.closeMenu();
      } else {
        this.openMenu();
      }
    }

    openMenu() {
      if (isTornDown) return;
      this.isMenuOpen = true;
      const viewBtn = this.container ? this.container.querySelector('#meetrix-btn-view') : null;
      if (viewBtn) {
        viewBtn.classList.add('active');
        viewBtn.setAttribute('aria-expanded', 'true');
      }

      if (!this.detailMenu || !document.body.contains(this.detailMenu)) {
        let menu = document.getElementById('meetrix-detail-menu');
        if (!menu) {
          menu = document.createElement('div');
          menu.id = 'meetrix-detail-menu';
          menu.setAttribute('role', 'dialog');
          menu.setAttribute('aria-label', 'MEETRIX AI Meeting Dashboard');
          const currentMeetId = tracker && tracker.meetingId || activeMeetingId || detectMeetingId() || '';
          menu.innerHTML = `
            <div class="meetrix-menu-header">
              <div class="meetrix-menu-title-group">
                <img src="${(window.MeetrixBranding && window.MeetrixBranding.getLargeEmblemUrl()) || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('icons/icon48.png') : 'icons/icon48.png')}" alt="MEETRIX AI" class="meetrix-dashboard-emblem-img" />
                <span class="meetrix-menu-badge">MEETRIX AI</span>
                <span class="meetrix-menu-title">Meeting Dashboard</span>
                ${currentMeetId ? `<span class="meetrix-menu-mid-tag">${escapeHtml(currentMeetId)}</span>` : ''}
              </div>
              <button class="meetrix-menu-close-btn" id="meetrix-menu-close" title="Close dashboard">&times;</button>
            </div>
            <div class="meetrix-metrics-row">
              <div class="meetrix-metric-item">
                <span class="meetrix-metric-label">Tracking</span>
                <span class="meetrix-metric-val" id="meetrix-metric-status">Idle</span>
              </div>
              <div class="meetrix-metric-item">
                <span class="meetrix-metric-label">Participants</span>
                <span class="meetrix-metric-val" id="meetrix-metric-count">0</span>
              </div>
              <div class="meetrix-metric-item">
                <span class="meetrix-metric-label">Captions</span>
                <span class="meetrix-metric-val" id="meetrix-metric-captions">0</span>
              </div>
            </div>
            <div class="meetrix-menu-tabs">
              <button class="meetrix-tab-btn active" data-tab="participants">Attendance</button>
              <button class="meetrix-tab-btn" data-tab="captions">Live Captions</button>
              <button class="meetrix-tab-btn" data-tab="summary">Summary</button>
            </div>
            <div class="meetrix-menu-content">
              <div class="meetrix-tab-pane active" id="meetrix-pane-participants"></div>
              <div class="meetrix-tab-pane" id="meetrix-pane-captions"></div>
              <div class="meetrix-tab-pane" id="meetrix-pane-summary"></div>
            </div>
            <div class="meetrix-menu-footer">
              <button class="meetrix-footer-btn-sec" id="meetrix-menu-csv">Export CSV</button>
              <button class="meetrix-footer-btn" id="meetrix-menu-download">Download Report (HTML)</button>
            </div>
          `;
          if (this.container) {
            this.container.appendChild(menu);
          } else {
            document.body.appendChild(menu);
          }

          menu.querySelector('#meetrix-menu-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeMenu();
          });

          menu.querySelector('#meetrix-menu-download').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleDownloadClick();
          });

          menu.querySelector('#meetrix-menu-csv').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleCsvDownloadClick();
          });

          const tabBtns = menu.querySelectorAll('.meetrix-tab-btn');
          tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const tabName = btn.getAttribute('data-tab');
              this.activeTab = tabName;
              tabBtns.forEach(b => b.classList.toggle('active', b === btn));
              menu.querySelectorAll('.meetrix-tab-pane').forEach(p => {
                p.classList.toggle('active', p.id === `meetrix-pane-${tabName}`);
              });
            });
          });

          menu.addEventListener('click', (e) => { e.stopPropagation(); });
        }
        this.detailMenu = menu;
      }

      this.updateMenuContent();
      document.addEventListener('click', this.onDocumentClick);
      document.addEventListener('keydown', this.onKeyDown);
    }

    closeMenu() {
      this.isMenuOpen = false;
      const viewBtn = this.container ? this.container.querySelector('#meetrix-btn-view') : null;
      if (viewBtn) {
        viewBtn.classList.remove('active');
        viewBtn.setAttribute('aria-expanded', 'false');
      }
      if (this.detailMenu) {
        this.detailMenu.remove();
        this.detailMenu = null;
      }
      document.removeEventListener('click', this.onDocumentClick);
      document.removeEventListener('keydown', this.onKeyDown);
    }

    updateMenuContent() {
      if (!this.detailMenu) return;

      const isTracking = !manuallyPaused && tracker && tracker.isTracking;
      const statusEl = this.detailMenu.querySelector('#meetrix-metric-status');
      if (statusEl) {
        if (isTracking) {
          const durationMin = tracker && tracker.startTime ? Math.max(0, Math.floor((Date.now() - tracker.startTime) / 60000)) : 0;
          statusEl.textContent = `Active (${durationMin}m)`;
          statusEl.style.color = '#4ade80';
        } else {
          statusEl.textContent = 'Idle';
          statusEl.style.color = '#a1a1aa';
        }
      }

      let participants = [];
      if (tracker && tracker.participants && tracker.participants.size > 0) {
        participants = Array.from(tracker.participants.values());
      } else if (participantDetector) {
        participants = participantDetector.scanParticipants(document);
      }

      const countEl = this.detailMenu.querySelector('#meetrix-metric-count');
      if (countEl) {
        const presentCount = participants.filter(p => !p.status || !p.status.startsWith('Left')).length;
        countEl.textContent = `${participants.length} (${presentCount} present)`;
      }

      const partPane = this.detailMenu.querySelector('#meetrix-pane-participants');
      if (partPane) {
        if (participants.length === 0) {
          partPane.innerHTML = `<div style="text-align:center;color:#71717a;padding:28px 10px;font-size:12.5px;">No participants recorded yet.<br><span style="font-size:11px;color:#52525b;">Click Start to begin active tracking.</span></div>`;
        } else {
          partPane.innerHTML = participants.map(p => {
            const rawName = p.displayName || p.name || 'Participant';
            const name = escapeHtml(p.isSelf && !rawName.includes('(You)') ? `${rawName} (You)` : rawName);
            const cam = p.cameraStatus || 'Unknown';
            let camClass = 'meetrix-tag-cam-unk';
            if (cam.includes('ON')) camClass = 'meetrix-tag-cam-on';
            else if (cam.includes('OFF')) camClass = 'meetrix-tag-cam-off';

            const dev = escapeHtml(p.deviceType || 'Unknown');
            const status = (p.status && p.status.startsWith('Left')) ? 'Left' : (p.presenting ? 'Presenting' : 'Present');

            const joinTime = p.firstJoinAt ? new Date(p.firstJoinAt).toLocaleTimeString() : (tracker && tracker.startTime ? new Date(tracker.startTime).toLocaleTimeString() : 'In call');
            const durSec = p.totalObservedDuration || p.observedDurationSeconds || (p.firstJoinAt ? Math.round((Date.now() - p.firstJoinAt) / 1000) : 0);
            const durationStr = durSec > 0 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : 'Active';

            return `
              <div class="meetrix-participant-card">
                <div class="meetrix-participant-name-col">
                  <span class="meetrix-participant-name">${name}</span>
                  <span class="meetrix-participant-sub">Joined ${joinTime} · ${durationStr}</span>
                </div>
                <div class="meetrix-participant-badges">
                  <span class="meetrix-tag ${camClass}">${escapeHtml(cam)}</span>
                  <span class="meetrix-tag meetrix-tag-dev">${dev}</span>
                  <span class="meetrix-tag meetrix-tag-status">${status}</span>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      const lines = captionManager ? captionManager.getLines() : [];
      const captEl = this.detailMenu.querySelector('#meetrix-metric-captions');
      if (captEl) captEl.textContent = `${lines.length} lines`;

      const captPane = this.detailMenu.querySelector('#meetrix-pane-captions');
      if (captPane) {
        const captionsActive = captionManager && captionManager._captionsEnabled;
        const bannerHtml = `
          <div class="meetrix-caption-banner">
            <span>Status: <strong style="color:${captionsActive ? '#4ade80' : '#facc15'};">${captionsActive ? 'Captions Active (CC)' : 'Meet Captions are OFF'}</strong></span>
            ${!captionsActive ? `<button class="meetrix-caption-btn-sm" id="meetrix-btn-enable-cc">Turn ON Meet CC</button>` : ''}
          </div>
        `;

        let feedHtml = '';
        if (lines.length === 0) {
          feedHtml = `<div style="text-align:center;color:#71717a;padding:24px 10px;font-size:12px;">No captions captured yet.<br><span style="font-size:10.5px;color:#52525b;">Enable Captions (CC) in Meet to begin transcription.</span></div>`;
        } else {
          const recent = lines.slice(-30);
          feedHtml = recent.map(l => {
            const timeStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '--:--:--';
            const speaker = escapeHtml(l.speaker || 'Unknown');
            const text = escapeHtml(l.text || '');
            return `
              <div class="meetrix-caption-row">
                <span class="meetrix-caption-time">${timeStr}</span>
                <span class="meetrix-caption-speaker">${speaker}:</span>
                <span class="meetrix-caption-text">${text}</span>
              </div>
            `;
          }).join('');
        }

        captPane.innerHTML = bannerHtml + feedHtml;

        const enableCcBtn = captPane.querySelector('#meetrix-btn-enable-cc');
        if (enableCcBtn) {
          enableCcBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (captionManager) {
              captionManager.tryEnableMeetCaptions();
              setTimeout(() => this.updateMenuContent(), 600);
            }
          });
        }
      }

      const summPane = this.detailMenu.querySelector('#meetrix-pane-summary');
      if (summPane) {
        if (lines.length === 0) {
          summPane.innerHTML = `<div style="text-align:center;color:#71717a;padding:28px 10px;font-size:12.5px;">No transcript data captured yet.<br><span style="font-size:11px;color:#52525b;">A meeting summary will be compiled once captions are captured.</span></div>`;
        } else {
          const sum = reportGenerator ? reportGenerator.buildMeetingSummary(lines) : { available: false, summary: '' };
          const decs = (sum.decisions && sum.decisions.length) ? `
            <div style="margin-top:8px;">
              <div class="meetrix-summary-title">Confirmed Decisions</div>
              <ul style="margin:0;padding-left:16px;font-size:11px;color:#d4d4d8;">
                ${sum.decisions.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
              </ul>
            </div>
          ` : '';
          const acts = (sum.actions && sum.actions.length) ? `
            <div style="margin-top:8px;">
              <div class="meetrix-summary-title">Action Items</div>
              <ul style="margin:0;padding-left:16px;font-size:11px;color:#d4d4d8;">
                ${sum.actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}
              </ul>
            </div>
          ` : '';

          summPane.innerHTML = `
            <div class="meetrix-summary-box">
              <div class="meetrix-summary-title">Executive Summary</div>
              <div>${escapeHtml(sum.summary || 'Summary in progress...')}</div>
              ${decs}
              ${acts}
            </div>
          `;
        }
      }
    }

    showToast(msg) {
      if (!this.container) return;
      const old = this.container.querySelector('.meetrix-toast');
      if (old) old.remove();

      const toast = document.createElement('div');
      toast.className = 'meetrix-toast';
      toast.textContent = msg;
      this.container.appendChild(toast);

      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        toast.remove();
      }, 2400);
    }

    handleStartClick() {
      manuallyPaused = false;
      saveTrackingState(true);
      if (tracker) {
        tracker.isTracking = true;
        tracker.isDirty = true;
        const meetId = activeMeetingId || detectMeetingId();
        if (meetId && !tracker.meetingId) {
          tracker.initSession(meetId).then(() => {
            performScan();
          });
        } else {
          performScan();
        }
      }
      if (captionManager && !captionManager.isActive) {
        captionManager.startCaptionObserver();
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: 'MEETRIX_SET_TRACKING_STATE', isTracking: true });
        } catch (e) { /* safe */ }
      }
      this.updateState();
      this.showToast('MEETRIX: Tracking started');
    }

    handleStopClick() {
      manuallyPaused = true;
      saveTrackingState(false);
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: 'MEETRIX_SET_TRACKING_STATE', isTracking: false });
        } catch (e) { /* safe */ }
      }
      finalizeMeeting('manual-stop').then(res => {
        this.updateState();
        if (res && res.success) {
          this.showToast('MEETRIX: Stopped & Report Saved');
        } else {
          this.showToast('MEETRIX: Stopped');
        }
      });
    }

    handleCsvDownloadClick() {
      if (tracker && reportGenerator) {
        const summary = tracker.getSummary();
        reportGenerator.downloadReport(summary.participants)
          .then(() => this.showToast('CSV downloaded'))
          .catch((err) => this.showToast('CSV error: ' + (err && err.message || err)));
      } else {
        this.showToast('Tracker not ready');
      }
    }

    async handleDownloadClick() {
      const meetId = activeMeetingId || detectMeetingId();
      if (!meetId) {
        this.showToast('No active meeting');
        return;
      }

      const recoveryKey = `meetrix_report_${meetId}`;
      let saved = null;
      if (chrome.storage && chrome.storage.local) {
        saved = await new Promise(r => chrome.storage.local.get(recoveryKey, d => r(d[recoveryKey] || null)));
      }

      if (saved && saved.html) {
        chrome.runtime.sendMessage({
          type: 'MEETRIX_SAVE_HTML_REPORT',
          html: saved.html,
          filename: saved.filename
        }, (res) => {
          if (res && res.success) this.showToast('Report downloaded');
          else this.showToast('Download triggered');
        });
        return;
      }

      const session = tracker ? tracker.getSummary() : { participants: [] };
      const participants = session.participants || [];
      const lines = captionManager ? captionManager.getLines() : [];

      if (!participants.length && !lines.length) {
        this.showToast('Start tracking first to record data');
        return;
      }

      const endedAt = Date.now();
      const reportData = {
        meetingDetails: {
          meetingId: meetId,
          startTime: tracker ? tracker.startTime : endedAt,
          endTime: endedAt,
          duration: tracker && tracker.startTime ? `${Math.max(0, Math.round((endedAt - tracker.startTime) / 60000))} min` : 'In progress'
        },
        participants: participants,
        transcript: lines
      };

      const html = reportGenerator.buildHtmlReport(reportData);
      const filename = reportGenerator.generateHtmlFilename(tracker ? tracker.startTime : endedAt);

      chrome.runtime.sendMessage({
        type: 'MEETRIX_SAVE_HTML_REPORT',
        html: html,
        filename: filename
      }, (res) => {
        if (res && res.success) this.showToast('Report downloaded');
        else this.showToast('Report generated');
      });
    }

    destroy() {
      this.closeMenu();
      if (this.container) {
        this.container.remove();
        this.container = null;
      }
      const style = document.getElementById('meetrix-header-styles');
      if (style) style.remove();
      window.removeEventListener('resize', this.onWindowResize);
    }
  }

  // Load tracking state on startup, then init observer
  async function startup() {
    const isActive = await loadTrackingState();
    manuallyPaused = !isActive;

    headerPanel = new MeetrixHeaderPanel();
    window.__meetrix_headerPanel = headerPanel;

    // Listen for storage changes to maintain cross-context sync with extension popup
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.meetrix_tracking_active) {
          const newActive = changes.meetrix_tracking_active.newValue === true;
          manuallyPaused = !newActive;
          if (tracker) {
            tracker.isTracking = newActive;
          }
          if (headerPanel) {
            headerPanel.updateState();
          }
        }
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        initObserver();
        if (headerPanel) headerPanel.mount();
      });
    } else {
      initObserver();
      if (headerPanel) headerPanel.mount();
    }
  }

  startup();
})();

