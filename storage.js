/**
 * Meetrix - Storage Manager
 * 
 * Provides safe local persistence using chrome.storage.local with in-memory caching.
 * Robustly detects extension context invalidation and classifies errors into clear categories:
 * - EXTENSION_CONTEXT_INVALIDATED
 * - STORAGE_FAILURE
 * - MISSING_MESSAGE_RECEIVER
 * - INVALID_SESSION_DATA
 */

(function (root) {
  'use strict';

  const STORAGE_KEYS = {
    ACTIVE_MEETING: 'meetrix_active_meeting_id',
    SESSIONS: 'meetrix_sessions',
    SETTINGS: 'meetrix_settings'
  };

  const MeetrixErrorType = {
    CONTEXT_INVALIDATED: 'EXTENSION_CONTEXT_INVALIDATED',
    STORAGE_FAILURE: 'STORAGE_FAILURE',
    RECEIVER_MISSING: 'MISSING_MESSAGE_RECEIVER',
    INVALID_DATA: 'INVALID_SESSION_DATA'
  };

  class MeetrixStorageError extends Error {
    constructor(type, message, originalError = null) {
      super(message);
      this.name = type;
      this.type = type;
      this.originalError = originalError;
    }
  }

  class MeetrixStorageManager {
    constructor() {
      this.memCache = {
        sessions: {},
        activeMeetingId: null,
        settings: {
          leaveGracePeriodMs: 25000,
          autoTrack: true
        }
      };
      this.isInitialized = false;
      this.initPromise = this.init();
    }

    /**
     * Checks if the extension execution context is currently valid.
     * In Chrome MV3, chrome.runtime.id becomes undefined immediately when
     * the extension is reloaded, updated, or uninstalled.
     * @returns {boolean}
     */
    isContextValid() {
      try {
        return typeof chrome !== 'undefined' &&
               typeof chrome.runtime !== 'undefined' &&
               Boolean(chrome.runtime.id);
      } catch (e) {
        return false;
      }
    }

    /**
     * Categorizes any error or exception into standardized MeetrixErrorType.
     * @param {any} err 
     * @returns {string} One of MeetrixErrorType values
     */
    classifyError(err) {
      if (!this.isContextValid()) {
        return MeetrixErrorType.CONTEXT_INVALIDATED;
      }
      if (!err) return MeetrixErrorType.STORAGE_FAILURE;
      if (err.type && Object.values(MeetrixErrorType).includes(err.type)) {
        return err.type;
      }
      if (err.name && Object.values(MeetrixErrorType).includes(err.name)) {
        return err.name;
      }

      const msg = (err.message || String(err)).toLowerCase();
      if (msg.includes('context invalidated') || msg.includes('extension context invalidated')) {
        return MeetrixErrorType.CONTEXT_INVALIDATED;
      }
      if (msg.includes('could not establish connection') || msg.includes('receiving end does not exist')) {
        return MeetrixErrorType.RECEIVER_MISSING;
      }
      if (msg.includes('invalid session') || msg.includes('missing meetingid') || msg.includes('invalid') || msg.includes('corrupt')) {
        return MeetrixErrorType.INVALID_DATA;
      }
      return MeetrixErrorType.STORAGE_FAILURE;
    }

    async init() {
      if (this.isInitialized) return;
      if (!this.isContextValid()) {
        this.isInitialized = true;
        return;
      }

      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const data = await new Promise((resolve, reject) => {
            try {
              chrome.storage.local.get([
                STORAGE_KEYS.ACTIVE_MEETING,
                STORAGE_KEYS.SESSIONS,
                STORAGE_KEYS.SETTINGS
              ], (result) => {
                const lastErr = chrome.runtime.lastError;
                if (lastErr) {
                  return reject(new MeetrixStorageError(this.classifyError(lastErr), lastErr.message, lastErr));
                }
                resolve(result || {});
              });
            } catch (syncErr) {
              reject(new MeetrixStorageError(this.classifyError(syncErr), syncErr.message, syncErr));
            }
          });

          if (data[STORAGE_KEYS.SESSIONS]) {
            this.memCache.sessions = data[STORAGE_KEYS.SESSIONS];
          }
          if (data[STORAGE_KEYS.ACTIVE_MEETING]) {
            this.memCache.activeMeetingId = data[STORAGE_KEYS.ACTIVE_MEETING];
          }
          if (data[STORAGE_KEYS.SETTINGS]) {
            this.memCache.settings = { ...this.memCache.settings, ...data[STORAGE_KEYS.SETTINGS] };
          }
        }
      } catch (err) {
        const category = this.classifyError(err);
        if (category !== MeetrixErrorType.CONTEXT_INVALIDATED) {
          console.warn('[MeetrixStorage] Error during initialization:', err.message);
        }
      } finally {
        this.isInitialized = true;
      }
    }

    async getActiveMeetingId() {
      await this.initPromise;
      return this.memCache.activeMeetingId;
    }

    async setActiveMeetingId(meetingId) {
      await this.initPromise;
      this.memCache.activeMeetingId = meetingId;
      if (!this.isContextValid()) return;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          await new Promise((resolve, reject) => {
            try {
              chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_MEETING]: meetingId }, () => {
                if (chrome.runtime.lastError) {
                  return reject(new MeetrixStorageError(this.classifyError(chrome.runtime.lastError), chrome.runtime.lastError.message));
                }
                resolve();
              });
            } catch (e) {
              reject(new MeetrixStorageError(this.classifyError(e), e.message));
            }
          });
        } catch (err) {
          if (this.classifyError(err) !== MeetrixErrorType.CONTEXT_INVALIDATED) {
            console.warn('[MeetrixStorage] Failed to set active meeting ID:', err.message);
          }
        }
      }
    }

    async getSession(meetingId) {
      await this.initPromise;
      if (!meetingId) {
        meetingId = this.memCache.activeMeetingId;
      }
      if (!meetingId) return null;

      // Always check in-memory cache first
      if (this.memCache.sessions && this.memCache.sessions[meetingId]) {
        return this.memCache.sessions[meetingId];
      }

      // Check storage if context is valid
      if (this.isContextValid() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          const data = await new Promise((resolve, reject) => {
            try {
              chrome.storage.local.get([STORAGE_KEYS.SESSIONS], (result) => {
                if (chrome.runtime.lastError) {
                  return reject(new MeetrixStorageError(this.classifyError(chrome.runtime.lastError), chrome.runtime.lastError.message));
                }
                resolve(result || {});
              });
            } catch (e) {
              reject(new MeetrixStorageError(this.classifyError(e), e.message));
            }
          });

          if (data && data[STORAGE_KEYS.SESSIONS]) {
            this.memCache.sessions = data[STORAGE_KEYS.SESSIONS];
            return this.memCache.sessions[meetingId] || null;
          }
        } catch (err) {
          // If context is invalidated, fallback to memory cache without throwing
        }
      }

      return this.memCache.sessions ? (this.memCache.sessions[meetingId] || null) : null;
    }

    async saveSession(sessionData) {
      await this.initPromise;
      if (!sessionData || !sessionData.meetingId || typeof sessionData.meetingId !== 'string') {
        throw new MeetrixStorageError(
          MeetrixErrorType.INVALID_DATA,
          '[MeetrixStorage] Invalid sessionData or missing meetingId'
        );
      }

      if (!this.isContextValid()) {
        throw new MeetrixStorageError(
          MeetrixErrorType.CONTEXT_INVALIDATED,
          'Extension context invalidated'
        );
      }

      // Always maintain in-memory representation so valid session is not discarded
      this.memCache.sessions[sessionData.meetingId] = sessionData;
      this.memCache.activeMeetingId = sessionData.meetingId;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise((resolve, reject) => {
          try {
            chrome.storage.local.set({
              [STORAGE_KEYS.SESSIONS]: this.memCache.sessions,
              [STORAGE_KEYS.ACTIVE_MEETING]: sessionData.meetingId
            }, () => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr) {
                const category = this.classifyError(lastErr);
                return reject(new MeetrixStorageError(category, lastErr.message, lastErr));
              }
              resolve();
            });
          } catch (syncErr) {
            const category = this.classifyError(syncErr);
            reject(new MeetrixStorageError(category, syncErr.message, syncErr));
          }
        });
      }

      return sessionData;
    }

    async clearSession(meetingId) {
      await this.initPromise;
      if (!meetingId) {
        meetingId = this.memCache.activeMeetingId;
      }
      if (!meetingId) return;

      delete this.memCache.sessions[meetingId];
      if (this.memCache.activeMeetingId === meetingId) {
        this.memCache.activeMeetingId = null;
      }

      if (!this.isContextValid()) return;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          await new Promise((resolve, reject) => {
            try {
              chrome.storage.local.set({
                [STORAGE_KEYS.SESSIONS]: this.memCache.sessions,
                [STORAGE_KEYS.ACTIVE_MEETING]: this.memCache.activeMeetingId
              }, () => {
                if (chrome.runtime.lastError) {
                  return reject(new MeetrixStorageError(this.classifyError(chrome.runtime.lastError), chrome.runtime.lastError.message));
                }
                resolve();
              });
            } catch (e) {
              reject(new MeetrixStorageError(this.classifyError(e), e.message));
            }
          });
        } catch (err) {
          // ignore context invalidation on clear
        }
      }
    }

    async getAllSessions() {
      await this.initPromise;
      return { ...this.memCache.sessions };
    }
  }

  root.MeetrixErrorType = MeetrixErrorType;
  root.MeetrixStorageError = MeetrixStorageError;
  const instance = new MeetrixStorageManager();
  root.MeetrixStorage = instance;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MeetrixStorageManager, MeetrixErrorType, MeetrixStorageError, instance };
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
