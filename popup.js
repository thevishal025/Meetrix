/**
 * Meetrix - Popup Controller (v2)
 *
 * Coordinates popup UI lifecycle, real-time live polling, participant rendering,
 * detail inspection, CSV download, session reset, Start/Stop tracking,
 * and transcript panel (caption recording, TXT/SRT export, live streaming).
 *
 * Key improvements in v2:
 *   - Transcript tab with live caption streaming via background port.
 *   - Device type 'Unknown' replaced with 'Desktop (est.)' in display.
 *   - Camera badge renamed UNVERIFIED → '?' for clarity.
 *   - Poll interval reduced to 1500ms for more responsive camera state updates.
 *   - Transcript lines rendered safely with textContent (no innerHTML injection).
 */

(function () {
  'use strict';

  // ----------------------------------------------------------------
  // DOM references — Attendance
  // ----------------------------------------------------------------
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');

  const meetingView = document.getElementById('meetingView');
  const inactiveView = document.getElementById('inactiveView');

  const observedCountEl = document.getElementById('observedCount');
  const presentingCountEl = document.getElementById('presentingCount');
  const presenterBanner = document.getElementById('presenterBanner');
  const presenterText = document.getElementById('presenterText');

  const participantTableBody = document.getElementById('participantTableBody');
  const emptyParticipantsState = document.getElementById('emptyParticipantsState');

  const detailDrawer = document.getElementById('detailDrawer');
  const drawerName = document.getElementById('drawerName');
  const drawerId = document.getElementById('drawerId');
  const drawerConfidence = document.getElementById('drawerConfidence');
  const drawerFirstSeen = document.getElementById('drawerFirstSeen');
  const drawerJoinTime = document.getElementById('drawerJoinTime');
  const drawerLeaveTime = document.getElementById('drawerLeaveTime');
  const drawerDuration = document.getElementById('drawerDuration');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');

  const downloadReportBtn = document.getElementById('downloadReportBtn');
  const newSessionBtn = document.getElementById('newSessionBtn');

  const confirmModal = document.getElementById('confirmModal');
  const cancelResetBtn = document.getElementById('cancelResetBtn');
  const confirmResetBtn = document.getElementById('confirmResetBtn');

  const previousSessionBox = document.getElementById('previousSessionBox');
  const prevSessionDesc = document.getElementById('prevSessionDesc');
  const downloadPrevReportBtn = document.getElementById('downloadPrevReportBtn');

  const trackingControlBar = document.getElementById('trackingControlBar');
  const trackingDot = document.getElementById('trackingDot');
  const trackingLabel = document.getElementById('trackingLabel');
  const trackingToggleBtn = document.getElementById('trackingToggleBtn');
  const trackStopIcon = document.getElementById('trackStopIcon');
  const trackStartIcon = document.getElementById('trackStartIcon');
  const trackBtnLabel = document.getElementById('trackBtnLabel');

  const connectionError = document.getElementById('connectionError');
  const connectionErrorText = document.getElementById('connectionErrorText');

  // ----------------------------------------------------------------
  // DOM references — Tabs
  // ----------------------------------------------------------------
  const tabAttendance = document.getElementById('tabAttendance');
  const tabTranscript = document.getElementById('tabTranscript');
  const attendanceTab = document.getElementById('attendanceTab');
  const transcriptTab = document.getElementById('transcriptTab');

  // ----------------------------------------------------------------
  // DOM references — Transcript
  // ----------------------------------------------------------------
  const captionDot = document.getElementById('captionDot');
  const captionStatusText = document.getElementById('captionStatusText');
  const captionToggleBtn = document.getElementById('captionToggleBtn');
  const captionToggleBtnLabel = document.getElementById('captionToggleBtnLabel');
  const captionInfoBanner = document.getElementById('captionInfoBanner');
  const captionUnavailableNotice = document.getElementById('captionUnavailableNotice');
  const captionUnavailableText = document.getElementById('captionUnavailableText');
  const enableMeetCaptionsBtn = document.getElementById('enableMeetCaptionsBtn');
  const transcriptContainer = document.getElementById('transcriptContainer');
  const transcriptEmpty = document.getElementById('transcriptEmpty');
  const transcriptLines = document.getElementById('transcriptLines');
  const clearTranscriptBtn = document.getElementById('clearTranscriptBtn');
  const downloadTxtBtn = document.getElementById('downloadTxtBtn');
  const downloadSrtBtn = document.getElementById('downloadSrtBtn');
  const transcriptCount = document.getElementById('transcriptCount');

  // DOM references — reports and AI configuration
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const aiProxyStatus = document.getElementById('aiProxyStatus');

  // ----------------------------------------------------------------
  // State
  // ----------------------------------------------------------------
  let currentParticipants = [];
  let selectedParticipantId = null;
  let activeTabId = null;
  let activeMeetingId = null;
  let pollInterval = null;
  let isCurrentlyTracking = false;
  let contentScriptReady = false;
  let currentTabName = 'attendance'; // 'attendance' | 'transcript'

  // Transcript state
  let captionActive = false;
  let captionEnabled = false; // Whether Meet captions are active
  let transcriptData = []; // local copy of all lines
  let backgroundPort = null;

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const s = Math.round(seconds);
    const mins = Math.floor(s / 60);
    const remSecs = s % 60;
    if (mins === 0) return `${remSecs}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours === 0) return `${remMins}m ${remSecs}s`;
    return `${hours}h ${remMins}m`;
  }

  function formatTimestamp(ts) {
    if (!ts) return 'N/A';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Maps internal deviceType values to user-facing display labels.
   */
  function deviceLabel(deviceType) {
    if (deviceType === 'Mobile') return 'Mobile';
    if (deviceType === 'Desktop' || deviceType === 'Desktop/Laptop') return 'Desktop';
    if (deviceType === 'Room device' || deviceType === 'Room') return 'Room device';
    return 'Unknown';
  }

  /**
   * Returns the CSS class for a device type badge.
   */
  function deviceBadgeClass(deviceType) {
    if (deviceType === 'Mobile') return 'badge-device-mobile';
    if (deviceType === 'Desktop' || deviceType === 'Desktop/Laptop') return 'badge-device-desktop';
    if (deviceType === 'Room device' || deviceType === 'Room') return 'badge-device-room';
    return 'badge-camera-unknown';
  }

  /**
   * Maps camera status to display text.
   * Allowed states: 'Camera ON', 'Camera OFF', 'Unknown'.
   */
  function cameraLabel(cameraStatus) {
    if (cameraStatus === 'Camera ON' || cameraStatus === 'ON') return 'Camera ON';
    if (cameraStatus === 'Camera OFF' || cameraStatus === 'OFF') return 'Camera OFF';
    return 'Unknown';
  }

  function cameraBadgeClass(cameraStatus) {
    if (cameraStatus === 'Camera ON' || cameraStatus === 'ON') return 'badge-camera-on';
    if (cameraStatus === 'Camera OFF' || cameraStatus === 'OFF') return 'badge-camera-off';
    return 'badge-camera-unknown';
  }

  // ----------------------------------------------------------------
  // Messaging
  // ----------------------------------------------------------------

  function safeSendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function safeSendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function checkContentScriptReady(tabId) {
    const response = await safeSendToTab(tabId, { type: 'MEETRIX_PING' });
    return !!(response && response.pong);
  }

  async function ensureContentScript(tabId) {
    const directReady = await checkContentScriptReady(tabId);
    if (directReady) {
      contentScriptReady = true;
      hideConnectionError();
      return true;
    }

    showConnectionError('Content script loading...');
    const bgResponse = await safeSendToBackground({
      type: 'MEETRIX_ENSURE_CONTENT_SCRIPT',
      tabId: tabId
    });

    if (bgResponse && bgResponse.ready) {
      contentScriptReady = true;
      hideConnectionError();
      return true;
    }

    contentScriptReady = false;
    showConnectionError('Content script could not be loaded. Make sure you are in a Google Meet call.');
    return false;
  }

  function showConnectionError(text) {
    if (connectionError) {
      connectionError.classList.remove('hidden');
      connectionErrorText.textContent = text;
    }
  }

  function hideConnectionError() {
    if (connectionError) connectionError.classList.add('hidden');
  }

  async function queryMeetTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        if (tabs && tabs[0] && tabs[0].url && tabs[0].url.includes('meet.google.com')) {
          resolve(tabs[0]); return;
        }
        chrome.tabs.query({ url: 'https://meet.google.com/*' }, (meetTabs) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(meetTabs && meetTabs.length > 0 ? meetTabs[0] : null);
        });
      });
    });
  }

  // ----------------------------------------------------------------
  // Attendance sync
  // ----------------------------------------------------------------

  async function syncStatus() {
    const meetTab = await queryMeetTab();

    if (!meetTab) {
      handleInactiveState();
      return;
    }

    activeTabId = meetTab.id;

    const ready = await ensureContentScript(activeTabId);
    if (!ready) {
      await loadFromStorage();
      return;
    }

    const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_GET_STATUS' });

    if (!response) {
      await loadFromStorage();
      return;
    }

    if (response.isTracking !== undefined) {
      isCurrentlyTracking = response.isTracking;
    }

    // Update caption status from content script response
    if (response.captionStatus) {
      captionActive = response.captionStatus.isActive;
      captionEnabled = response.captionStatus.captionsEnabled;
      updateCaptionUI();
    }

    if (response.isInCall && response.summary) {
      activeMeetingId = response.meetingId;
      renderActiveMeeting(response.summary);
      // Fast path: if 0 participants are currently recorded, trigger an immediate scan
      if (response.summary.totalObserved === 0 && !window.__meetrix_initial_scan_triggered) {
        window.__meetrix_initial_scan_triggered = true;
        safeSendToTab(activeTabId, { type: 'MEETRIX_TRIGGER_SCAN' }).then((scanRes) => {
          if (scanRes && scanRes.summary && scanRes.summary.totalObserved > 0) {
            renderActiveMeeting(scanRes.summary);
          }
        });
      }
    } else {
      if (response.summary && response.summary.totalObserved > 0) {
        renderActiveMeeting(response.summary, true);
      } else {
        handleInactiveState();
      }
    }

    updateTrackingUI();
  }

  async function loadFromStorage() {
    const storage = window.MeetrixStorage;
    if (!storage) { handleInactiveState(); return; }

    const meetingId = await storage.getActiveMeetingId();
    if (meetingId) {
      const session = await storage.getSession(meetingId);
      if (session && session.participants) {
        const participants = Object.values(session.participants);
        const summary = {
          meetingId: session.meetingId,
          startTime: session.startTime,
          totalObserved: participants.length,
          currentlyPresent: participants.filter(p => p.status === 'Present' || p.status === 'Presenting').length,
          currentlyPresenting: session.isPresenting
            ? Math.max(1, participants.filter(p => p.presenting).length)
            : participants.filter(p => p.presenting).length,
          presenterName: session.presenterName,
          isPresenting: session.isPresenting,
          participants: participants
        };
        renderActiveMeeting(summary, true);
        return;
      }
    }
    handleInactiveState();
  }

  function renderActiveMeeting(summary, isStandby = false) {
    inactiveView.classList.add('hidden');
    meetingView.classList.remove('hidden');

    statusDot.className = 'status-dot ' + (isStandby ? 'standby' : 'active');
    statusLabel.textContent = isStandby
      ? `Standby (${summary.meetingId || 'Call'})`
      : `In Call (${summary.meetingId || 'Active'})`;

    observedCountEl.textContent = summary.totalObserved || 0;
    presentingCountEl.textContent = summary.currentlyPresenting || 0;

    if (summary.isPresenting && summary.presenterName) {
      presenterBanner.classList.remove('hidden');
      presenterText.textContent = `Presenting: ${summary.presenterName}`;
    } else {
      presenterBanner.classList.add('hidden');
    }

    currentParticipants = summary.participants || [];
    renderParticipantsTable(currentParticipants);

    if (selectedParticipantId) {
      const selected = currentParticipants.find(p => p.id === selectedParticipantId);
      if (selected) updateDrawerContent(selected);
    }

    trackingControlBar.classList.remove('hidden');
    updateTrackingUI();
  }

  function updateTrackingUI() {
    if (isCurrentlyTracking) {
      trackingDot.className = 'tracking-dot active';
      trackingLabel.textContent = 'Tracking Active';
      trackStopIcon.classList.remove('hidden');
      trackStartIcon.classList.add('hidden');
      trackBtnLabel.textContent = 'Stop';
      trackingToggleBtn.className = 'btn btn-track-toggle tracking-active';
    } else {
      trackingDot.className = 'tracking-dot paused';
      trackingLabel.textContent = 'Tracking Paused';
      trackStopIcon.classList.add('hidden');
      trackStartIcon.classList.remove('hidden');
      trackBtnLabel.textContent = 'Start';
      trackingToggleBtn.className = 'btn btn-track-toggle tracking-paused';
    }
  }

  function renderParticipantsTable(participants) {
    if (!participants || participants.length === 0) {
      participantTableBody.innerHTML = '';
      emptyParticipantsState.classList.remove('hidden');
      return;
    }

    emptyParticipantsState.classList.add('hidden');

    const sorted = [...participants].sort((a, b) => {
      const getPriority = (p) => (p.presenting ? 0 : p.status === 'Present' ? 1 : 2);
      const priDiff = getPriority(a) - getPriority(b);
      if (priDiff !== 0) return priDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    const rowsHtml = sorted.map((p) => {
      const isSelected = p.id === selectedParticipantId ? 'selected' : '';

      const camClass = cameraBadgeClass(p.cameraStatus);
      const camText = cameraLabel(p.cameraStatus);

      const devClass = deviceBadgeClass(p.deviceType);
      const devText = deviceLabel(p.deviceType);

      let statusClass = 'badge-status-present';
      let statusText = p.status || 'Present';

      if (p.presenting) {
        statusClass = 'badge-status-presenting';
        statusText = 'Presenting';
      } else if (p.status === 'Left' || (p.status && p.status.startsWith('Left'))) {
        statusClass = 'badge-status-left';
        statusText = 'Left';
      } else if (p.status === 'Present' || (p.status && p.status.startsWith('Present'))) {
        statusClass = 'badge-status-present';
        statusText = 'Present';
      } else {
        statusClass = 'badge-camera-unknown';
        statusText = 'Unknown';
      }

      return `
        <tr class="participant-row ${isSelected}" data-id="${escapeHtml(p.id)}">
          <td class="name-cell" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
          <td><span class="badge ${camClass}">${camText}</span></td>
          <td><span class="badge ${devClass}">${devText}</span></td>
          <td><span class="badge ${statusClass}">${statusText}</span></td>
        </tr>
      `;
    }).join('');

    participantTableBody.innerHTML = rowsHtml;

    participantTableBody.querySelectorAll('.participant-row').forEach((row) => {
      row.addEventListener('click', () => {
        selectParticipant(row.getAttribute('data-id'));
      });
    });
  }

  function selectParticipant(id) {
    selectedParticipantId = id;
    const participant = currentParticipants.find(p => p.id === id);
    if (!participant) return;

    participantTableBody.querySelectorAll('.participant-row').forEach(r => {
      r.classList.toggle('selected', r.getAttribute('data-id') === id);
    });

    updateDrawerContent(participant);
    detailDrawer.classList.remove('hidden');
  }

  function updateDrawerContent(p) {
    drawerName.textContent = p.displayName || p.name || 'Participant Details';
    drawerId.textContent = p.participantId || p.id || 'N/A';
    drawerConfidence.textContent = p.dataConfidence || p.identityConfidence || 'Medium';
    drawerFirstSeen.textContent = formatTimestamp(p.firstJoinAt || p.firstObserved);
    drawerJoinTime.textContent = formatTimestamp(p.lastJoinAt || p.estimatedJoinTime || p.firstJoinAt);
    drawerLeaveTime.textContent = (p.status && p.status.startsWith('Left') && (p.lastLeaveAt || p.estimatedLeaveTime))
      ? formatTimestamp(p.lastLeaveAt || p.estimatedLeaveTime)
      : 'Still Present';
    const durationStr = formatDuration(p.totalObservedDuration || p.observedDurationSeconds);
    drawerDuration.textContent = (p.rejoinCount && p.rejoinCount > 0)
      ? `${durationStr} · ${p.rejoinCount} rejoins`
      : durationStr;
  }

  function closeDrawer() {
    selectedParticipantId = null;
    detailDrawer.classList.add('hidden');
    participantTableBody.querySelectorAll('.participant-row').forEach(r => r.classList.remove('selected'));
  }

  async function handleInactiveState() {
    meetingView.classList.add('hidden');
    inactiveView.classList.remove('hidden');

    statusDot.className = 'status-dot offline';
    statusLabel.textContent = 'Not in Meet';

    const storage = window.MeetrixStorage;
    if (storage) {
      const activeId = await storage.getActiveMeetingId();
      if (activeId) {
        const prevSession = await storage.getSession(activeId);
        if (prevSession && prevSession.participants && Object.keys(prevSession.participants).length > 0) {
          previousSessionBox.classList.remove('hidden');
          const count = Object.keys(prevSession.participants).length;
          const dateStr = new Date(prevSession.startTime || Date.now()).toLocaleDateString();
          prevSessionDesc.textContent = `Meeting: ${prevSession.meetingId} (${count} participants, ${dateStr})`;
          return;
        }
      }
    }
    previousSessionBox.classList.add('hidden');
  }

  async function toggleTracking() {
    if (!activeTabId) return;

    if (isCurrentlyTracking) {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_STOP_TRACKING' });
      if (response) {
        isCurrentlyTracking = false;
        updateTrackingUI();
        safeSendToBackground({ type: 'MEETRIX_SET_TRACKING_STATE', isTracking: false });
        if (!response.success) alert(`Meeting data is preserved, but the report could not be saved: ${response.error || 'Unknown download error'}. Use Download Report to retry.`);
      }
    } else {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_START_TRACKING' });
      if (response) {
        isCurrentlyTracking = true;
        updateTrackingUI();
        safeSendToBackground({ type: 'MEETRIX_SET_TRACKING_STATE', isTracking: true });
        setTimeout(syncStatus, 500);
      }
    }
  }

  async function triggerDownload() {
    let participants = currentParticipants;
    let meetingId = activeMeetingId;
    let startTime = null;

    const storage = window.MeetrixStorage;
    if (storage) {
      const savedId = await storage.getActiveMeetingId();
      const saved = savedId ? await new Promise(resolve => chrome.storage.local.get(`meetrix_report_${savedId}`, data => resolve(data[`meetrix_report_${savedId}`] || null))) : null;
      if (saved && saved.html) {
        const retry = await safeSendToBackground({ type: 'MEETRIX_SAVE_HTML_REPORT', html: saved.html, filename: saved.filename });
        if (retry && retry.success) {
          await new Promise(resolve => chrome.storage.local.set({ [`meetrix_report_${savedId}`]: { ...saved, status: 'saved', downloadId: retry.downloadId } }, resolve));
          return;
        }
        if (saved.status === 'pending') { alert(`Report remains available for retry. ${retry && retry.error || ''}`); return; }
      }
    }
    if ((!participants || participants.length === 0) && storage) {
      const activeId = await storage.getActiveMeetingId();
      const prevSession = activeId ? await storage.getSession(activeId) : null;
      if (prevSession && prevSession.participants) {
        participants = Object.values(prevSession.participants);
        meetingId = prevSession.meetingId || activeId;
        startTime = prevSession.startTime;
      }
    }

    participants = participants || [];

    // 1. Gather transcript lines
    let transcriptLines = transcriptData;
    if ((!transcriptLines || transcriptLines.length === 0) && activeTabId && contentScriptReady) {
      const res = await safeSendToTab(activeTabId, { type: 'MEETRIX_GET_TRANSCRIPT' });
      if (res && res.lines && res.lines.length > 0) {
        transcriptLines = res.lines;
      }
    }

    const reportData = {
      meetingDetails: {
        meetingId: meetingId || 'meet-session',
        startTime: startTime
      },
      participants: participants || [],
      transcript: transcriptLines || []
    };

    if (transcriptLines && transcriptLines.length) {
      const ai = await safeSendToBackground({ type: 'MEETRIX_GENERATE_SUMMARY', transcript: JSON.stringify(transcriptLines) });
      if (ai && ai.success && ai.insight) reportData.aiInsight = ai.insight;
    }

    try {
      const html = window.MeetrixReportGenerator.buildHtmlReport(reportData);
      const filename = window.MeetrixReportGenerator.generateHtmlFilename(startTime || Date.now());
      const response = await safeSendToBackground({ type: 'MEETRIX_SAVE_HTML_REPORT', html, filename });
      if (!response || !response.success) alert(`Report could not be saved. Stop and meeting data remain available; retry from this button. ${response && response.error || ''}`);
    } catch (err) {
      alert('Download error: ' + err.message);
    }
  }

  async function triggerCsvDownload() {
    let participants = currentParticipants;
    if ((!participants || participants.length === 0) && window.MeetrixStorage) {
      const activeId = await window.MeetrixStorage.getActiveMeetingId();
      const prevSession = activeId ? await window.MeetrixStorage.getSession(activeId) : null;
      if (prevSession && prevSession.participants) {
        participants = Object.values(prevSession.participants);
      }
    }
    if (!participants || participants.length === 0) {
      alert('No attendance data available to download.');
      return;
    }
    try {
      await window.MeetrixReportGenerator.downloadReport(participants);
    } catch (err) {
      alert('CSV Download error: ' + err.message);
    }
  }

  async function refreshAiProxyStatus() {
    const result = await safeSendToBackground({ type: 'MEETRIX_GET_AI_PROXY_STATUS' });
    if (aiProxyStatus) aiProxyStatus.textContent = result && result.ready ? (result.keyConfigured ? 'Local proxy ready · NVIDIA key configured' : 'Proxy running · add NVIDIA_API_KEY to its environment') : 'Local AI proxy is not running';
  }

  async function executeReset() {
    confirmModal.classList.add('hidden');
    closeDrawer();

    if (activeTabId && contentScriptReady) {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_RESET_SESSION' });
      if (response && response.success) {
        isCurrentlyTracking = true;
        updateTrackingUI();
      }
      syncStatus();
    } else {
      const storage = window.MeetrixStorage;
      if (storage) {
        const id = await storage.getActiveMeetingId();
        if (id) await storage.clearSession(id);
      }
      syncStatus();
    }
  }

  // ----------------------------------------------------------------
  // Tab switching
  // ----------------------------------------------------------------

  function switchTab(tab) {
    currentTabName = tab;

    tabAttendance.classList.toggle('active', tab === 'attendance');
    tabTranscript.classList.toggle('active', tab === 'transcript');
    attendanceTab.classList.toggle('active', tab === 'attendance');
    transcriptTab.classList.toggle('active', tab === 'transcript');
    attendanceTab.classList.toggle('hidden', tab !== 'attendance');
    transcriptTab.classList.toggle('hidden', tab !== 'transcript');

    if (tab === 'transcript') {
      // Fetch current transcript state from content script
      refreshTranscript();
    }
  }

  // ----------------------------------------------------------------
  // Transcript / Caption
  // ----------------------------------------------------------------

  /**
   * Connects to background service worker via long-lived port for caption streaming.
   */
  function connectBackgroundPort() {
    if (backgroundPort) return;
    try {
      backgroundPort = chrome.runtime.connect({ name: 'meetrix-popup' });
      backgroundPort.onMessage.addListener((msg) => {
        if (msg.type === 'MEETRIX_CAPTION_EVENT') {
          handleCaptionEvent(msg.event);
        }
      });
      backgroundPort.onDisconnect.addListener(() => {
        backgroundPort = null;
        // Reconnect after brief delay if popup still open
        setTimeout(connectBackgroundPort, 1000);
      });
    } catch (e) {
      // Popup closing or context invalidated
    }
  }

  /**
   * Handles a caption event forwarded from background port.
   * @param {{ type: string, line?: Object, message?: string, captionsActive?: boolean }} event
   */
  function handleCaptionEvent(event) {
    if (!event) return;

    if (event.type === 'status') {
      captionEnabled = !!event.captionsActive;
      updateCaptionStatusDisplay(event.message || '');
      updateCaptionUI();
    } else if (event.type === 'line') {
      // New caption line
      if (event.line) {
        transcriptData.push(event.line);
        appendTranscriptLine(event.line);
        updateTranscriptCount();
        scrollTranscriptToBottom();
      }
    } else if (event.type === 'updated') {
      // Last line was updated (incremental caption)
      if (event.line && transcriptData.length > 0) {
        transcriptData[transcriptData.length - 1] = event.line;
        updateLastTranscriptLine(event.line);
      }
    } else if (event.type === 'cleared') {
      transcriptData = [];
      clearTranscriptDisplay();
    }
  }

  /**
   * Fetches the current full transcript from the content script.
   */
  async function refreshTranscript() {
    if (!activeTabId || !contentScriptReady) return;
    const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_GET_TRANSCRIPT' });
    if (response && response.success) {
      captionActive = response.active;
      captionEnabled = response.captionsEnabled;
      transcriptData = response.lines || [];
      renderAllTranscriptLines();
      updateTranscriptCount();
      updateCaptionUI();
    }
  }

  /**
   * Toggles caption recording on/off.
   */
  async function toggleCaptions() {
    if (!activeTabId) return;

    if (captionActive) {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_STOP_CAPTIONS' });
      if (response && response.success) {
        captionActive = false;
        captionEnabled = false;
        updateCaptionUI();
      }
    } else {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_START_CAPTIONS' });
      if (response && response.success) {
        captionActive = true;
        captionEnabled = !!response.captionsEnabled;
        updateCaptionUI();
        if (!captionEnabled) {
          captionInfoBanner.classList.remove('hidden');
        }
      }
    }
  }

  function updateCaptionUI() {
    if (captionActive && captionEnabled) {
      // Recording and captions are live
      captionDot.className = 'tracking-dot active';
      captionStatusText.textContent = 'Recording captions…';
      captionToggleBtnLabel.textContent = 'Stop';
      captionToggleBtn.className = 'btn btn-track-toggle tracking-active';
      captionInfoBanner.classList.add('hidden');
      captionUnavailableNotice.classList.add('hidden');
    } else if (captionActive && !captionEnabled) {
      // Active but waiting for captions to be enabled in Meet
      captionDot.className = 'tracking-dot paused';
      captionStatusText.textContent = 'Waiting for Meet captions…';
      captionToggleBtnLabel.textContent = 'Stop';
      captionToggleBtn.className = 'btn btn-track-toggle tracking-paused';
      captionInfoBanner.classList.remove('hidden');
      captionUnavailableNotice.classList.remove('hidden');
    } else {
      // Inactive
      captionDot.className = 'tracking-dot';
      captionStatusText.textContent = 'Transcription inactive';
      captionToggleBtnLabel.textContent = 'Start';
      captionToggleBtn.className = 'btn btn-track-toggle';
      captionUnavailableNotice.classList.add('hidden');
    }
  }

  function updateCaptionStatusDisplay(message) {
    if (message) captionStatusText.textContent = message;
  }

  // ----------------------------------------------------------------
  // Transcript rendering (safe — no innerHTML for transcript content)
  // ----------------------------------------------------------------

  function renderAllTranscriptLines() {
    transcriptLines.innerHTML = '';
    if (transcriptData.length === 0) {
      transcriptEmpty.classList.remove('hidden');
      return;
    }
    transcriptEmpty.classList.add('hidden');
    for (const line of transcriptData) {
      transcriptLines.appendChild(buildLineElement(line));
    }
  }

  function appendTranscriptLine(line) {
    transcriptEmpty.classList.add('hidden');
    transcriptLines.appendChild(buildLineElement(line));
  }

  function updateLastTranscriptLine(line) {
    const existing = transcriptLines.querySelector(`[data-line-id="${line.id}"]`);
    if (existing) {
      const textEl = existing.querySelector('.tl-text');
      if (textEl) textEl.textContent = line.text;
      const speakerEl = existing.querySelector('.tl-speaker');
      if (speakerEl) speakerEl.textContent = line.speaker ? line.speaker : 'Unknown';
    } else {
      appendTranscriptLine(line);
    }
  }

  function clearTranscriptDisplay() {
    transcriptLines.innerHTML = '';
    transcriptEmpty.classList.remove('hidden');
    updateTranscriptCount();
  }

  /**
   * Builds a single transcript line DOM element safely (no innerHTML injection of user text).
   * @param {{ id: number, speaker: string|null, text: string, timestamp: number }} line
   * @returns {HTMLElement}
   */
  function buildLineElement(line) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.setAttribute('data-line-id', line.id);

    const meta = document.createElement('span');
    meta.className = 'tl-meta';

    const timeEl = document.createElement('span');
    timeEl.className = 'tl-time';
    timeEl.textContent = formatTimestamp(line.timestamp);

    const speakerEl = document.createElement('span');
    speakerEl.className = 'tl-speaker';
    speakerEl.textContent = line.speaker ? line.speaker : 'Unknown';

    meta.appendChild(timeEl);
    meta.appendChild(speakerEl);

    const textEl = document.createElement('span');
    textEl.className = 'tl-text';
    textEl.textContent = line.text; // textContent is safe — no HTML injection

    row.appendChild(meta);
    row.appendChild(textEl);
    return row;
  }

  function scrollTranscriptToBottom() {
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }

  function updateTranscriptCount() {
    const count = transcriptData.length;
    transcriptCount.textContent = `${count} line${count !== 1 ? 's' : ''}`;
  }

  // ----------------------------------------------------------------
  // Transcript exports
  // ----------------------------------------------------------------

  async function downloadTranscriptTxt() {
    if (activeTabId && contentScriptReady) {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_EXPORT_TRANSCRIPT', format: 'txt' });
      if (response && response.success && response.content) {
        triggerTextDownload(response.content, 'meetrix-transcript.txt', 'text/plain');
        return;
      }
    }
    // Fallback: build from local transcriptData
    if (transcriptData.length === 0) { alert('No transcript to download.'); return; }
    const content = transcriptData.map(l => {
      const time = formatTimestamp(l.timestamp);
      return `${time} [${l.speaker || 'Unknown'}]: ${l.text}`;
    }).join('\n');
    triggerTextDownload(content, 'meetrix-transcript.txt', 'text/plain');
  }

  async function downloadTranscriptSrt() {
    if (activeTabId && contentScriptReady) {
      const response = await safeSendToTab(activeTabId, { type: 'MEETRIX_EXPORT_TRANSCRIPT', format: 'srt' });
      if (response && response.success && response.content) {
        triggerTextDownload(response.content, 'meetrix-transcript.srt', 'text/plain');
        return;
      }
    }
    if (transcriptData.length === 0) { alert('No transcript to export.'); return; }
    // Build SRT locally
    let srt = '';
    const baseTime = transcriptData[0] ? transcriptData[0].timestamp : Date.now();
    transcriptData.forEach((l, idx) => {
      const start = msToSrt(l.timestamp - baseTime);
      const endMs = transcriptData[idx + 1] ? (transcriptData[idx + 1].timestamp - baseTime) : (l.timestamp - baseTime) + 2000;
      const end = msToSrt(endMs);
      const speaker = l.speaker ? `${l.speaker}: ` : '';
      srt += `${idx + 1}\n${start} --> ${end}\n${speaker}${l.text}\n\n`;
    });
    triggerTextDownload(srt, 'meetrix-transcript.srt', 'text/plain');
  }

  function triggerTextDownload(content, filename, mimeType) {
    const blob = new Blob(['\uFEFF' + content], { type: mimeType + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    try {
      chrome.downloads.download({ url, filename, saveAs: true }, () => {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    } catch (e) {
      // Fallback anchor
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function msToSrt(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const millis = ms % 1000;
    const pad2 = n => String(n).padStart(2, '0');
    const pad3 = n => String(n).padStart(3, '0');
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(millis)}`;
  }

  async function clearTranscript() {
    transcriptData = [];
    clearTranscriptDisplay();
    if (activeTabId && contentScriptReady) {
      await safeSendToTab(activeTabId, { type: 'MEETRIX_CLEAR_TRANSCRIPT' });
    }
  }

  // ----------------------------------------------------------------
  // Event Listeners
  // ----------------------------------------------------------------

  downloadReportBtn.addEventListener('click', triggerDownload);
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', triggerCsvDownload);
  }
  refreshAiProxyStatus();
  downloadPrevReportBtn.addEventListener('click', async () => {
    const storage = window.MeetrixStorage;
    if (storage) {
      const activeId = await storage.getActiveMeetingId();
      const prevSession = activeId ? await storage.getSession(activeId) : null;
      if (prevSession && prevSession.participants) {
        await window.MeetrixReportGenerator.downloadReport(Object.values(prevSession.participants));
      }
    }
  });

  newSessionBtn.addEventListener('click', () => { confirmModal.classList.remove('hidden'); });
  cancelResetBtn.addEventListener('click', () => { confirmModal.classList.add('hidden'); });
  confirmResetBtn.addEventListener('click', executeReset);
  closeDrawerBtn.addEventListener('click', closeDrawer);
  trackingToggleBtn.addEventListener('click', toggleTracking);

  // Tab switcher
  tabAttendance.addEventListener('click', () => switchTab('attendance'));
  tabTranscript.addEventListener('click', () => switchTab('transcript'));

  // Transcript controls
  captionToggleBtn.addEventListener('click', toggleCaptions);
  if (enableMeetCaptionsBtn) {
    enableMeetCaptionsBtn.addEventListener('click', async () => {
      if (activeTabId && contentScriptReady) {
        enableMeetCaptionsBtn.textContent = 'Enabling…';
        const res = await safeSendToTab(activeTabId, { type: 'MEETRIX_ENABLE_MEET_CAPTIONS' });
        if (res && res.captionsEnabled) {
          captionEnabled = true;
          updateCaptionUI();
        }
        setTimeout(() => {
          enableMeetCaptionsBtn.textContent = 'Turn ON CC';
        }, 1500);
      }
    });
  }
  clearTranscriptBtn.addEventListener('click', clearTranscript);
  downloadTxtBtn.addEventListener('click', downloadTranscriptTxt);
  downloadSrtBtn.addEventListener('click', downloadTranscriptSrt);

  // ----------------------------------------------------------------
  // Initialisation
  // ----------------------------------------------------------------

  async function loadInitialTrackingState() {
    const response = await safeSendToBackground({ type: 'MEETRIX_GET_TRACKING_STATE' });
    if (response && response.isTracking !== undefined) {
      isCurrentlyTracking = response.isTracking;
    }
  }

  connectBackgroundPort();

  loadInitialTrackingState().then(() => {
    syncStatus();
  });

  // Poll every 1500ms (reduced from 1800ms for faster camera state updates)
  pollInterval = setInterval(syncStatus, 1500);

  window.addEventListener('unload', () => {
    if (pollInterval) clearInterval(pollInterval);
    if (backgroundPort) {
      try { backgroundPort.disconnect(); } catch (e) { /* safe */ }
      backgroundPort = null;
    }
  });
})();
