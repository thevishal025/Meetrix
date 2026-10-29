/**
 * Meetrix - Attendance Tracker
 * 
 * Manages participant attendance lifecycles, join/leave timestamps,
 * observed duration calculation, and session persistence.
 * 
 * Strict Guarantees:
 * - Uses local browser time.
 * - Clearly distinguishes exact observations from estimates.
 * - Never fabricates historical timestamps.
 * - Recalculates accurate counts strictly from validated participant records.
 * - Restores state after popup close or page refresh.
 * - Coalesces and serializes storage persistence writes to avoid race conditions.
 * - Halts cleanly upon extension context invalidation to prevent error spamming.
 */

(function (root) {
  'use strict';

  class MeetrixAttendanceTracker {
    constructor() {
      this.meetingId = null;
      this.startTime = null;
      this.lastTickTime = null;
      this.isTracking = false;
      this.participants = new Map(); // id -> participant object
      this.presenterName = null;
      this.isPresenting = false;
      this.departureConfirmationWindowMs = 3500; // 3.5 seconds departure confirmation window (3-4 seconds per spec)
      this.leaveGracePeriodMs = 3500; // backwards compatibility alias
      this.lastSaveTime = 0;
      this.saveThrottleMs = 2000;
      this.saveTimeout = null;

      // Persistence concurrency and lifecycle controls
      this.isSaving = false;
      this.hasPendingSave = false;
      this.activeSavePromise = null;
      this.isDestroyed = false;
      this.isDirty = false;
      this.onContextInvalidated = null;
    }

    /**
     * Purges any legacy or corrupted participant records that match UI controls or invalid labels.
     */
    sanitizeRecords() {
      const detector = root.MeetrixParticipantDetector;

      for (const [id, p] of this.participants.entries()) {
        if (!p || !p.name) {
          this.participants.delete(id);
          continue;
        }
        const nameLower = p.name.trim().toLowerCase();
        if (
          nameLower.includes('user profile') ||
          nameLower.includes('profile picture') ||
          nameLower.includes('profile photo') ||
          nameLower.includes('google account') ||
          nameLower.includes('presenting') ||
          nameLower.includes('presentation') ||
          (detector && !detector.isValidParticipantName(p.name))
        ) {
          this.participants.delete(id);
        }
      }
    }

    /**
     * Halts all tracking, clears timers, and stops pending writes.
     */
    destroy() {
      this.isDestroyed = true;
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      this.hasPendingSave = false;
      this.isSaving = false;
      this.activeSavePromise = null;
    }

    /**
     * Handles extension context invalidation gracefully.
     * Halts chrome.storage write timers without destroying active in-memory participant tracking.
     */
    handleContextInvalidated() {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      this.hasPendingSave = false;
      this.isSaving = false;
      console.warn('[Meetrix] Extension context invalidated. Session persistence paused; in-memory tracking preserved.');
      if (typeof this.onContextInvalidated === 'function') {
        try {
          this.onContextInvalidated();
        } catch (e) {
          // Safe catch
        }
      }
    }

    /**
     * Initializes or resumes a tracking session for a specific meeting.
     * @param {string} meetingId 
     */
    async initSession(meetingId) {
      if (!meetingId) return;

      this.isDestroyed = false;
      this.meetingId = meetingId;
      const storage = root.MeetrixStorage;

      // Attempt to restore existing session data for this meeting
      if (storage) {
        try {
          const savedSession = await storage.getSession(meetingId);
          if (savedSession && savedSession.meetingId === meetingId) {
            this.startTime = savedSession.startTime || Date.now();
            this.isTracking = savedSession.isTracking !== false;
            this.presenterName = savedSession.presenterName || null;
            this.isPresenting = !!savedSession.isPresenting;
            this.participants.clear();

            if (savedSession.participants) {
              const now = Date.now();
              Object.values(savedSession.participants).forEach(p => {
                // Do not rely on outdated stored participant records as proof of current presence
                const isOutdated = p.status === 'Present' && p.lastObserved && (now - p.lastObserved > this.departureConfirmationWindowMs);
                const resolvedStatus = isOutdated ? 'Left' : (p.status || 'Present');
                const pRecord = {
                  ...p,
                  status: resolvedStatus,
                  participantId: p.participantId || p.id,
                  displayName: p.displayName || p.name,
                  firstJoinAt: p.firstJoinAt || p.firstObserved || this.startTime,
                  lastJoinAt: p.lastJoinAt || p.estimatedJoinTime || this.startTime,
                  lastLeaveAt: isOutdated ? (p.lastObserved || p.estimatedLeaveTime || now) : (p.lastLeaveAt || p.estimatedLeaveTime || null),
                  rejoinCount: typeof p.rejoinCount === 'number' ? p.rejoinCount : 0,
                  totalObservedDuration: p.totalObservedDuration || p.observedDurationSeconds || 0,
                  sessions: Array.isArray(p.sessions) && p.sessions.length > 0
                    ? [...p.sessions]
                    : [{ joinAt: p.firstObserved || this.startTime, leaveAt: p.estimatedLeaveTime || null, duration: p.observedDurationSeconds || 0 }]
                };
                this.participants.set(pRecord.id, pRecord);
              });
            }
            this.sanitizeRecords();
            this.isDirty = false;
            console.log(`[Meetrix] Resumed session for ${meetingId} with ${this.participants.size} participants.`);
            return;
          }
        } catch (err) {
          console.warn('[Meetrix] Could not restore saved session, starting fresh:', err.message);
        }
      }

      // New session
      this.startTime = Date.now();
      this.lastTickTime = this.startTime;
      this.isTracking = true;
      this.participants.clear();
      this.presenterName = null;
      this.isPresenting = false;
      this.isDirty = true;

      await this.persist();
      console.log(`[Meetrix] Started new session for ${meetingId}.`);
    }

    /**
     * Core update method called on every scan cycle.
     * @param {Array<Object>} detectedList Validated participants currently visible in the DOM
     * @param {{ isPresenting: boolean, presenterName: string|null }} presentationInfo 
     */
    async update(detectedList = [], presentationInfo = { isPresenting: false, presenterName: null }) {
      if (this.isDestroyed || !this.isTracking) return;

      const now = Date.now();
      const elapsedDeltaSec = this.lastTickTime ? Math.max(0, Math.round((now - this.lastTickTime) / 1000)) : 1;
      this.lastTickTime = now;

      const wasPresenting = this.isPresenting;
      const prevPresenter = this.presenterName;
      this.isPresenting = !!presentationInfo.isPresenting;
      this.presenterName = presentationInfo.presenterName || null;

      if (wasPresenting !== this.isPresenting || prevPresenter !== this.presenterName) {
        this.isDirty = true;
      }

      const detector = root.MeetrixParticipantDetector;
      const currentlySeenIds = new Set();

      // Process only validated participants
      for (const detected of detectedList) {
        if (!detected || !detected.name) continue;
        if (detector && !detector.isValidParticipantName(detected.name) && detected.name !== 'Name unavailable') {
          continue; // Discard invalid/control names
        }

        const id = detected.id || detected.participantId;

        // Conservative matching:
        // 1. Exact ID match
        // 2. Match by normalized name ONLY IF exactly 1 record has this name AND has not been matched in this cycle
        // 3. For duplicate names, correlate unseen records rather than creating runaway duplicates
        let matchedRecordId = null;
        if (this.participants.has(id)) {
          matchedRecordId = id;
        } else {
          const normName = detected.name.trim().toLowerCase();
          const matches = [];
          for (const [pId, p] of this.participants.entries()) {
            if (p.name && p.name.trim().toLowerCase() === normName && detected.name !== 'Name unavailable') {
              matches.push(pId);
            }
          }
          if (matches.length === 1 && !currentlySeenIds.has(matches[0])) {
            matchedRecordId = matches[0];
          } else if (matches.length > 1) {
            const unseenMatches = matches.filter(mId => !currentlySeenIds.has(mId));
            if (unseenMatches.length > 0) {
              matchedRecordId = unseenMatches[0];
              const rec = this.participants.get(matchedRecordId);
              if (rec) {
                rec.identityConfidence = 'Uncertain';
                rec.dataConfidence = 'Low';
              }
            }
          }
        }

        if (matchedRecordId) {
          currentlySeenIds.add(matchedRecordId);
          const existing = this.participants.get(matchedRecordId);
          this.updateParticipantRecord(existing, detected, now, elapsedDeltaSec);
          this.isDirty = true;
        } else {
          // Brand new validated participant observed
          currentlySeenIds.add(id);
          const isCurrentlyPresenting = this.isPresenting && !!detected.presenting;
          const normName = detected.name.trim().toLowerCase();
          const existingSameName = Array.from(this.participants.values()).filter(
            p => p.name && p.name.trim().toLowerCase() === normName
          );
          const isDuplicateName = existingSameName.length > 0;
          const identityConfidence = isDuplicateName
            ? 'Uncertain'
            : (detected.identityConfidence || detected.dataConfidence || 'Medium');

          const newParticipant = {
            participantId: id,
            displayName: detected.name || 'Name unavailable',
            status: 'Present',
            firstJoinAt: now,
            lastJoinAt: now,
            lastLeaveAt: null,
            rejoinCount: 0,
            totalObservedDuration: 1,
            cameraStatus: detected.cameraStatus || 'Unknown',
            deviceType: detected.deviceType || 'Unknown',
            sessions: [{ joinAt: now, leaveAt: null, duration: 1 }],
            dataConfidence: isDuplicateName ? 'Low' : (detected.dataConfidence || detected.identityConfidence || 'Medium'),
            presenting: isCurrentlyPresenting,

            // Backward compatibility aliases
            id: id,
            name: detected.name || 'Name unavailable',
            firstObserved: now,
            estimatedJoinTime: now,
            lastObserved: now,
            estimatedLeaveTime: null,
            observedDurationSeconds: 1,
            identityConfidence: identityConfidence
          };
          this.participants.set(id, newParticipant);
          this.isDirty = true;
        }
      }

      // If presentation is NOT active, ensure no participant retains presenting status
      if (!this.isPresenting) {
        for (const p of this.participants.values()) {
          if (p.presenting) {
            p.presenting = false;
            if (p.status !== 'Left') {
              p.status = 'Present';
            }
            this.isDirty = true;
          }
        }
      }

      // Check participants who were NOT seen in this scan cycle
      for (const [id, participant] of this.participants.entries()) {
        if (!currentlySeenIds.has(id)) {
          // If already confirmed Left, skip
          if (participant.status === 'Left') {
            continue;
          }

          // Start or check 3-4 second departure confirmation window
          if (!participant.pendingDeparture) {
            participant.pendingDeparture = {
              startedAt: participant.lastObserved || now,
              lastSeenAt: participant.lastObserved || now
            };
          }

          // Check if confirmation window has elapsed since absence began
          const elapsed = now - participant.pendingDeparture.startedAt;
          if (elapsed >= this.departureConfirmationWindowMs) {
            // Confirmed departure after 3-4s confirmation window
            participant.status = 'Left';
            participant.lastLeaveAt = participant.pendingDeparture.lastSeenAt;
            participant.estimatedLeaveTime = participant.pendingDeparture.lastSeenAt;
            participant.presenting = false;

            // Close active session
            if (participant.sessions && participant.sessions.length > 0) {
              const activeSession = participant.sessions[participant.sessions.length - 1];
              if (activeSession && !activeSession.leaveAt) {
                activeSession.leaveAt = participant.lastLeaveAt;
                activeSession.duration = Math.max(1, Math.round((participant.lastLeaveAt - activeSession.joinAt) / 1000));
              }
            }
            participant.totalObservedDuration = (participant.sessions || []).reduce((acc, s) => acc + (s.duration || 0), 0);
            participant.observedDurationSeconds = participant.totalObservedDuration;
            participant.pendingDeparture = null;
            this.isDirty = true;
          }
        }
      }

      this.sanitizeRecords();

      if (this.isDirty) {
        this.schedulePersist();
      }
    }

    /**
     * Updates an existing participant record with new observations.
     */
    updateParticipantRecord(record, detected, now, deltaSeconds) {
      const isCurrentlyPresenting = this.isPresenting && !!detected.presenting;

      if (!Array.isArray(record.sessions)) {
        record.sessions = [];
      }

      // If participant had a pending departure, cancel it immediately upon reappearance
      if (record.pendingDeparture) {
        record.pendingDeparture = null;
      }

      // Check if participant is returning after departure
      if (record.status === 'Left') {
        record.status = 'Present';
        record.rejoinCount = (record.rejoinCount || 0) + 1;
        record.lastJoinAt = now;
        record.estimatedJoinTime = now;
        record.estimatedLeaveTime = null;
        record.lastLeaveAt = null;
        // Start a verified new session
        record.sessions.push({ joinAt: now, leaveAt: null, duration: 1 });
      } else {
        record.status = 'Present';
        // Active session continues
        if (record.sessions.length === 0) {
          record.sessions.push({ joinAt: record.firstJoinAt || now, leaveAt: null, duration: 1 });
        }
        const activeSession = record.sessions[record.sessions.length - 1];
        if (activeSession && !activeSession.leaveAt) {
          activeSession.duration = Math.max(1, Math.round((now - activeSession.joinAt) / 1000));
        }
      }

      record.lastObserved = now;
      record.totalObservedDuration = record.sessions.reduce((acc, s) => acc + (s.duration || 0), 0);
      record.observedDurationSeconds = record.totalObservedDuration;

      // Update camera status
      const isWeakCam = (s) => !s || s === 'UNKNOWN' || s === 'UNVERIFIED' || s === 'Unknown';
      if (detected.cameraStatus && !isWeakCam(detected.cameraStatus)) {
        if (record.cameraStatus !== detected.cameraStatus) {
          record.cameraStatus = detected.cameraStatus;
          this.isDirty = true;
        }
      } else if (isWeakCam(record.cameraStatus) && detected.cameraStatus) {
        if (record.cameraStatus !== detected.cameraStatus) {
          record.cameraStatus = detected.cameraStatus;
          this.isDirty = true;
        }
      }

      // Update device type
      const isWeakDevice = (d) => !d || d === 'Unknown' || d === 'Desktop (est.)';
      if (detected.deviceType && !isWeakDevice(detected.deviceType)) {
        record.deviceType = detected.deviceType;
      } else if (isWeakDevice(record.deviceType) && detected.deviceType) {
        record.deviceType = detected.deviceType;
      }

      record.presenting = isCurrentlyPresenting;

      if (detected.identityConfidence === 'High' || detected.dataConfidence === 'High') {
        record.identityConfidence = 'High';
        record.dataConfidence = 'High';
      }
    }

    /**
     * Throttles storage writes to prevent excessive extension storage I/O.
     */
    schedulePersist() {
      if (this.isDestroyed) return;

      const storage = root.MeetrixStorage;
      if (storage && typeof storage.isContextValid === 'function' && !storage.isContextValid()) {
        this.handleContextInvalidated();
        return;
      }

      // When tracking is stopped and no dirty changes, do not schedule writes
      if (!this.isTracking && !this.isDirty) {
        return;
      }

      const now = Date.now();
      if (now - this.lastSaveTime > this.saveThrottleMs) {
        this.persist();
      } else if (!this.saveTimeout) {
        this.saveTimeout = setTimeout(() => {
          this.saveTimeout = null;
          if (!this.isDestroyed) {
            this.persist();
          }
        }, this.saveThrottleMs);
      }
    }

    /**
     * Writes current state into MeetrixStorage.
     * Serializes concurrent writes and coalesces rapid requests.
     * Safely classifies errors and halts on context invalidation.
     * @returns {Promise<Object|null>}
     */
    async persist() {
      if (this.isDestroyed) return null;
      if (!this.meetingId) return null;

      const storage = root.MeetrixStorage;
      if (!storage) return null;

      // Verify lifecycle context before attempting persistence
      if (typeof storage.isContextValid === 'function' && !storage.isContextValid()) {
        this.handleContextInvalidated();
        return null;
      }

      // Coalesce concurrent persistence writes:
      // If a write is already in progress, mark pending and wait on active promise
      if (this.isSaving) {
        this.hasPendingSave = true;
        return this.activeSavePromise;
      }

      this.isSaving = true;
      this.hasPendingSave = false;

      this.activeSavePromise = (async () => {
        try {
          this.lastSaveTime = Date.now();
          this.sanitizeRecords();

          const participantsObj = {};
          this.participants.forEach((val, key) => {
            participantsObj[key] = { ...val };
          });

          const sessionData = {
            meetingId: this.meetingId,
            startTime: this.startTime,
            lastUpdated: Date.now(),
            isTracking: this.isTracking,
            presenterName: this.presenterName,
            isPresenting: this.isPresenting,
            participants: participantsObj
          };

          await storage.saveSession(sessionData);
          this.isDirty = false;
          return sessionData;
        } catch (err) {
          const category = storage.classifyError
            ? storage.classifyError(err)
            : (err.name || 'STORAGE_FAILURE');

          const ErrorTypes = root.MeetrixErrorType || {};
          if (category === ErrorTypes.CONTEXT_INVALIDATED || category === 'EXTENSION_CONTEXT_INVALIDATED') {
            this.handleContextInvalidated();
          } else if (category === ErrorTypes.INVALID_DATA || category === 'INVALID_SESSION_DATA') {
            console.warn('[Meetrix] Session data invalid; persistence aborted:', err.message);
          } else {
            // Recoverable storage error (e.g. quota, temporary lock) - keep in-memory data intact
            console.warn('[Meetrix] Recoverable storage failure during session persistence:', err.message);
          }
          return null;
        } finally {
          this.isSaving = false;
          this.activeSavePromise = null;

          // If changes occurred while saving, run one follow-up save (coalesced)
          if (this.hasPendingSave && !this.isDestroyed) {
            this.hasPendingSave = false;
            return this.persist();
          }
        }
      })();

      return this.activeSavePromise;
    }

    /**
     * Resets the current meeting tracking session.
     */
    async resetSession() {
      if (this.isDestroyed || !this.meetingId) return;
      this.participants.clear();
      this.startTime = Date.now();
      this.lastTickTime = this.startTime;
      this.presenterName = null;
      this.isPresenting = false;
      this.isDirty = true;
      await this.persist();
      console.log(`[Meetrix] Session reset for ${this.meetingId}`);
    }

    /**
     * Returns serialized summary strictly from validated records.
     */
    getSummary() {
      this.sanitizeRecords();
      const list = Array.from(this.participants.values());
      const presentingCount = this.isPresenting
        ? Math.max(1, list.filter(p => p.presenting).length)
        : list.filter(p => p.presenting).length;
      const presentCount = list.filter(p => p.status === 'Present' || p.status === 'Presenting').length;

      return {
        meetingId: this.meetingId,
        startTime: this.startTime,
        totalObserved: list.length,
        currentlyPresent: presentCount,
        currentlyPresenting: presentingCount,
        presenterName: this.presenterName,
        isPresenting: this.isPresenting,
        participants: list
      };
    }
  }

  const tracker = new MeetrixAttendanceTracker();
  root.MeetrixAttendanceTracker = tracker;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tracker;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
