/**
 * Meetrix - Participant Detector (v2)
 *
 * Robust DOM-based participant name detection, validation, and deduplication.
 *
 * Guarantees:
 * - Detects participants whether cameras are ON or OFF.
 * - Detects participants whether the People side panel is OPEN or CLOSED.
 * - Uses multiple complementary discovery strategies:
 *     1. Direct Stage Nameplate scan (div.zWGUib, span.notranslate, div.PoLmKc, etc.)
 *     2. Active Stage Video stream scan (<video> elements)
 *     3. Allocated & Identified Stage Tiles (data-participant-id, data-allocation-index, etc.)
 *     4. Stage Avatar scan for camera-off participants (img[alt], avatar initials)
 *     5. People / Contributors side panel & global listitem scan
 *     6. Self-participant guarantee from local call signals
 * - Strictly excludes UI controls, notifications, region bars, buttons, menus, and chat messages.
 * - Filters out screen shares and presentation surfaces completely.
 * - Accurately passes local vs remote identity to camera and device detectors.
 * - Seamlessly reconciles names across DOM re-renders without duplicates.
 */

(function (root) {
  'use strict';

  // Strict list of disallowed UI strings and labels
  const UI_CONTROL_BLOCKLIST = new Set([
    'people', 'chat', 'activities', 'details', 'info',
    'meeting details', 'chat with everyone', 'host controls',
    'turn on microphone', 'turn off microphone',
    'turn on camera', 'turn off camera',
    'microphone is off', 'microphone is on',
    'camera is off', 'camera is on',
    'video is off', 'video is on',
    'audio is off', 'audio is on',
    'mute', 'unmute', 'muted', 'unmuted',
    'more options', 'pin', 'unpin', 'raise hand', 'lower hand',
    'presentation', 'screen share', 'your presentation',
    'someone is presenting', 'leave call', 'end call',
    'call controls', 'call feature notifications', 'devices',
    'call details', 'device settings', 'audio settings', 'video settings',
    'microphone', 'speakers', 'camera', 'captions', 'turn on captions',
    'turn off captions', 'whiteboard', 'breakout rooms',
    'add people', 'mute all', 'host management',
    'meeting safety', 'send a message to everyone',
    'participant list', 'participants', 'in call',
    'rejoin', 'return to home screen', 'cancel', 'dismiss',
    'jump to bottom', 'back to call', 'switch camera', 'full screen',
    'exit full screen', 'settings', 'help', 'report a problem',
    'waiting for meet participants to load', 'no participants detected yet',
    'user profile picture', 'profile picture', 'profile photo', 'google account',
    'you are presenting', 'stop presenting', 'share your entire screen anyway',
    'to avoid an infinity mirror'
  ]);

  const INVALID_PATTERNS = [
    /^user\s+profile/i,
    /^profile\s+(?:picture|photo)/i,
    /^google\s+account/i,
    /^you\s+(?:are|'re)\s+presenting/i,
    /^stop\s+presenting/i,
    /^infinity\s+mirror/i,
    /^share\s+your\s+entire/i,
    /^call\s+controls$/i,
    /^call\s+feature\s+notifications$/i,
    /^devices?$/i,
    /^device\s+settings$/i,
    /^audio\s+settings$/i,
    /^video\s+settings$/i,
    /^meeting\s+details$/i,
    /^chat\s+with/i,
    /^chat$/i,
    /^people$/i,
    /^activities$/i,
    /^info$/i,
    /^details$/i,
    /^host\s+controls$/i,
    /^turn\s+(?:on|off)/i,
    /^microphone\s+(?:is\s+)?(?:on|off)/i,
    /^camera\s+(?:is\s+)?(?:on|off)/i,
    /^video\s+(?:is\s+)?(?:on|off)/i,
    /^audio\s+(?:is\s+)?(?:on|off)/i,
    /^(?:un)?mute(?:d)?(?:\s+(?:microphone|audio|camera))?$/i,
    /^more\s+options$/i,
    /^pin/i,
    /^unpin/i,
    /^raise\s+hand/i,
    /^lower\s+hand/i,
    /^presentation/i,
    /^screen\s+share/i,
    /^your\s+presentation/i,
    /^someone\s+is\s+presenting/i,
    /^leave\s+call/i,
    /^end\s+call/i,
    /^rejoin/i,
    /^participant\s+list/i,
    /^participants?$/i,
    /^contributors?$/i,
    /^add\s+people/i,
    /^mute\s+all/i,
    /^speakers?$/i,
    /^microphones?$/i,
    /^cameras?$/i,
    /^captions?$/i,
    /^whiteboard/i,
    /^send\s+a\s+message/i,
    /^meeting\s+safety/i,
    /^show\s+everyone/i,
    /controls$/i,
    /notifications?$/i,
    /settings$/i
  ];

  class MeetrixParticipantDetector {
    constructor() {
      this.selfName = '';
      this.elementIdMap = new WeakMap();
      this.nextFallbackSeq = 1;
    }

    /**
     * Strictly validates whether a string can be a genuine participant name.
     * @param {string} raw
     * @returns {boolean}
     */
    isValidParticipantName(raw) {
      if (!raw || typeof raw !== 'string') return false;
      const clean = raw.trim();

      if (clean.length < 2 || clean.length > 70) return false;

      const lower = clean.toLowerCase();
      if (UI_CONTROL_BLOCKLIST.has(lower)) return false;

      for (let i = 0; i < INVALID_PATTERNS.length; i++) {
        if (INVALID_PATTERNS[i].test(clean)) return false;
      }

      if (root.MeetrixPresentationDetector && root.MeetrixPresentationDetector.matchesPresentationString(clean)) {
        return false;
      }

      // Must contain at least one valid Unicode letter or digit
      if (!/[\p{L}\p{N}]/u.test(clean)) return false;

      // Pure digits check: phone numbers must have at least 7 digits
      if (/^\d+$/.test(clean.replace(/[\s\-()+]/g, ''))) {
        const digits = clean.replace(/\D/g, '');
        if (digits.length < 7) return false;
      }

      return true;
    }

    /**
     * Cleans and normalizes participant name.
     * Preserves Unicode, removes tags like (You), (Guest), extra spaces, and Meet prefixes/suffixes.
     * @param {string} rawName
     * @returns {string} Cleaned name or ''
     */
    cleanName(rawName) {
      if (!rawName || typeof rawName !== 'string') return '';

      let name = rawName.trim();

      // Immediately reject presentation strings
      if (root.MeetrixPresentationDetector && root.MeetrixPresentationDetector.matchesPresentationString(name)) {
        return '';
      }
      if (/\((?:presentation|presenting)\)/i.test(name)) {
        return '';
      }

      // Immediately reject microphone and camera states
      if (/^(?:microphone|camera|video|audio)\s+is\s+(?:on|off)/i.test(name)) {
        return '';
      }
      if (/^(?:turn\s+(?:on|off)\s+)?(?:microphone|camera|video|audio)/i.test(name)) {
        return '';
      }

      // Immediately reject profile pictures, Google account, and presentation labels
      if (
        /user\s+profile/i.test(name) ||
        /profile\s+(?:picture|photo)/i.test(name) ||
        /google\s+account/i.test(name) ||
        /you\s+(?:are|'re)\s+presenting/i.test(name) ||
        /stop\s+presenting/i.test(name) ||
        /infinity\s+mirror/i.test(name)
      ) {
        return '';
      }

      // Remove common Meet accessibility prefixes
      name = name.replace(/^(?:avatar\s+(?:for|of)|profile\s+(?:photo|picture)\s+(?:for|of)|video\s+(?:feed\s+for|of)|tile\s+for|participant\s+|photo\s+of)\s+/i, '');

      // Remove trailing video/presentation labels
      name = name.replace(/'s\s+(?:video|presentation|screen)$/i, '');

      // If string contains separators like '·', '•', '-', '|', ':', or ',',
      // test whether the first segment is a valid participant name
      const sepMatch = name.match(/^(.+?)\s*(?:[·•|:]|\s-\s|,)\s*(.+)$/);
      if (sepMatch) {
        const candidate = sepMatch[1].trim();
        // Check if the candidate before the separator looks like a valid participant name
        if (this.isValidParticipantName(candidate) && !candidate.toLowerCase().includes('participant')) {
          name = candidate;
        }
      }

      // Strip parenthesized role annotations commonly attached by Google Meet
      name = name.replace(/\s*\((?:you|guest|dial-in|phone|host|co-host|meeting host|external|organizer|organiser|contributor|presentation|presenting)\)/gi, '');

      // Strip leading and trailing punctuation (middle dots, commas, hyphens, colons)
      name = name.replace(/^[\s,.:;·•\-]+|[\s,.:;·•\-]+$/g, '');
      name = name.replace(/\s+/g, ' ');

      if (!this.isValidParticipantName(name)) {
        return '';
      }

      return name;
    }

    /**
     * Attempts to find the current user's display name.
     * @param {Document|Element} doc
     * @returns {string}
     */
    detectSelfName(doc = document) {
      // 1. Direct data-self-name attribute
      const selfEl = doc.querySelector('[data-self-name]');
      if (selfEl) {
        const val = selfEl.getAttribute('data-self-name');
        const cleaned = this.cleanName(val);
        if (cleaned) {
          this.selfName = cleaned;
          return this.selfName;
        }
      }

      // 2. Element explicitly containing '(You)'
      const youSelectors = [
        'span[title*="(You)" i]',
        'span.notranslate',
        'div.zWGUib',
        'div[role="listitem"] span.notranslate'
      ];
      const allNotranslate = doc.querySelectorAll(youSelectors.join(', '));
      for (let i = 0; i < allNotranslate.length; i++) {
        const text = (allNotranslate[i].textContent || allNotranslate[i].getAttribute('title') || '').trim();
        if (/\(you\)/i.test(text)) {
          const cleaned = this.cleanName(text);
          if (cleaned) {
            this.selfName = cleaned;
            return this.selfName;
          }
        }
      }

      // 3. People panel search
      const peopleList = this.findPeoplePanel(doc);
      if (peopleList) {
        const youEl = peopleList.querySelector('[data-self-name], span[title*="(You)" i], div[role="listitem"] span.notranslate');
        if (youEl) {
          const raw = youEl.getAttribute('data-self-name') || youEl.getAttribute('title') || youEl.textContent;
          const cleaned = this.cleanName(raw);
          if (cleaned) {
            this.selfName = cleaned;
            return this.selfName;
          }
        }
      }

      return this.selfName;
    }

    /**
     * Locates the verified Google Meet People or Contributors panel container.
     * Specifically excludes chat and activities panels.
     * @param {Document|Element} doc
     * @returns {Element|null}
     */
    findPeoplePanel(doc = document) {
      return doc.querySelector(
        'div[role="tabpanel"][aria-label*="participant" i], ' +
        'div[role="tabpanel"][aria-label*="people" i], ' +
        'div[role="tabpanel"][aria-label*="contributor" i], ' +
        'div[role="tabpanel"][aria-label*="in the meeting" i], ' +
        'div[role="tabpanel"][aria-label*="everyone" i], ' +
        'div[data-panel-id="1"], ' +
        'aside[aria-label*="participant" i], ' +
        'aside[aria-label*="people" i], ' +
        'aside[aria-label*="contributor" i], ' +
        'div[role="list"][aria-label*="participant" i], ' +
        'div[role="list"][aria-label*="contributor" i]'
      );
    }

    /**
     * Checks if an element is part of a non-participant interface component.
     * Does NOT treat stage participant tiles or nameplates as controls.
     * @param {Element} el
     * @returns {boolean}
     */
    isInterfaceControl(el) {
      if (!el || !(el instanceof Element)) return false;

      const controlAncestor = el.closest(
        '[aria-label*="Call controls" i], ' +
        '[aria-label*="Call feature notifications" i], ' +
        '[role="toolbar"], ' +
        '[role="dialog"], ' +
        'div[aria-label*="bottom bar" i], ' +
        'div[data-call-ended], ' +
        'div[role="tabpanel"][aria-label*="chat" i], ' +
        'aside[aria-label*="chat" i], ' +
        'div[data-panel-id="2"], ' +
        'div[role="tabpanel"][aria-label*="activities" i], ' +
        'div[data-panel-id="3"]'
      );

      return !!controlAncestor;
    }

    /**
     * Finds the single participant tile container enclosing a given child element.
     * Walks up the DOM tree and stops before hitting the whole stage or grid container.
     * @param {Element} el
     * @param {Document|Element} doc
     * @returns {Element|null}
     */
    findTileForElement(el, doc = document) {
      if (!el || !(el instanceof Element)) return null;

      // 1. Check if el itself has tile markers
      const isDirectTile = el.hasAttribute('data-participant-id') ||
                           el.hasAttribute('data-allocation-index') ||
                           el.hasAttribute('data-self-name');
      if (isDirectTile && !this._isContainerTooBroad(el)) {
        return el;
      }

      // 2. Look for closest element with specific tile markers
      const markedTile = el.closest(
        '[data-participant-id], ' +
        '[data-requested-participant-id], ' +
        '[data-initial-participant-id], ' +
        '[data-allocation-index], ' +
        '[data-self-name], ' +
        '[data-tile-id], ' +
        '[data-ssrc], ' +
        'div[role="listitem"], ' +
        'li[role="listitem"]'
      );

      if (markedTile && !this._isContainerTooBroad(markedTile)) {
        // If markedTile is an inner video wrapper (e.g. div[data-allocation-index]),
        // check if parent contains the nameplate and is bounded
        const parent = markedTile.parentElement || markedTile.parentNode;
        if (parent && !this._isContainerTooBroad(parent)) {
          const hasName = parent.querySelector(
            'div.zWGUib, span.notranslate, div.PoLmKc, div.XEAZBc, div.dwSJ2e, div.j1841c, div.A37uJ, [data-self-name], [data-participant-name]'
          );
          if (hasName) {
            return parent;
          }
        }
        return markedTile;
      }

      // 3. Otherwise walk up 1-8 levels to find bounded tile container
      let curr = el.parentElement || el.parentNode;
      let best = curr;
      let foundVideoTile = null;

      for (let i = 0; i < 8 && curr && curr !== doc.body; i++) {
        if (this._isContainerTooBroad(curr)) {
          break;
        }
        best = curr;
        if (curr.querySelector && curr.querySelector('video') && !foundVideoTile) {
          foundVideoTile = curr;
        }
        curr = curr.parentElement || curr.parentNode;
      }

      return foundVideoTile || best;
    }

    /**
     * Helper to verify if an element is a large multi-participant container
     * (such as the entire stage, grid, or body).
     * @param {Element} el
     * @returns {boolean}
     */
    _isContainerTooBroad(el) {
      if (!el) return true;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html' || tag === 'main') return true;

      if (el.querySelectorAll) {
        // If an element contains 2 or more distinct <video> elements, it is a multi-tile grid
        const vids = el.querySelectorAll('video');
        if (vids.length > 1) {
          return true;
        }

        // If it contains multiple distinct allocation indices or participant tiles:
        const subTiles = el.querySelectorAll('[data-allocation-index], [data-participant-id]');
        if (subTiles.length > 1) {
          return true;
        }

        // If it contains multiple distinct main nameplates:
        const mainPlates = el.querySelectorAll('div.zWGUib, [data-self-name]');
        if (mainPlates.length > 1) {
          return true;
        }
      }

      return false;
    }

    /**
     * Extracts a stable identifier for an element if possible.
     * @param {Element} el
     * @param {string} fallbackPrefix
     * @returns {string}
     */
    getOrCreateElementId(el, cleanedName = '', source = 'p') {
      if (!el) {
        const slug = cleanedName ? cleanedName.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'unknown';
        return `p_${slug}`;
      }

      // 1. Direct native ID attributes on el
      const nativeId =
        el.getAttribute('data-participant-id') ||
        el.getAttribute('data-requested-participant-id') ||
        el.getAttribute('data-initial-participant-id');

      if (nativeId && !nativeId.includes('screenshare')) {
        return `meet_${nativeId}`;
      }

      // 2. Parent with native ID
      const parentWithId = el.closest('[data-participant-id], [data-requested-participant-id], [data-initial-participant-id]');
      if (parentWithId) {
        const pId = parentWithId.getAttribute('data-participant-id') ||
                    parentWithId.getAttribute('data-requested-participant-id') ||
                    parentWithId.getAttribute('data-initial-participant-id');
        if (pId && !pId.includes('screenshare')) {
          return `meet_${pId}`;
        }
      }

      // 3. Child with native ID
      const childWithId = el.querySelector('[data-participant-id], [data-requested-participant-id], [data-initial-participant-id]');
      if (childWithId) {
        const pId = childWithId.getAttribute('data-participant-id') ||
                    childWithId.getAttribute('data-requested-participant-id') ||
                    childWithId.getAttribute('data-initial-participant-id');
        if (pId && !pId.includes('screenshare')) {
          return `meet_${pId}`;
        }
      }

      // 4. Stable avatar photo identifier (e.g. googleusercontent.com user avatar path)
      const avatarImg = (el.tagName === 'IMG' && (el.getAttribute('src') || '').includes('googleusercontent'))
        ? el
        : el.querySelector('img[src*="googleusercontent" i]');
      if (avatarImg) {
        const src = avatarImg.getAttribute('src') || '';
        const userMatch = src.match(/\/a[/-]([^=?/]+)/i);
        if (userMatch && userMatch[1] && userMatch[1].length >= 8) {
          return `meet_user_${userMatch[1]}`;
        }
      }

      // 5. Check WeakMap for this specific element instance
      if (this.elementIdMap.has(el)) {
        return this.elementIdMap.get(el);
      }

      // 6. Deterministic name-based fallback (ensures recreated DOM nodes map to the same participant)
      if (cleanedName) {
        const slug = cleanedName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const deterministicId = `p_${slug}`;
        this.elementIdMap.set(el, deterministicId);
        return deterministicId;
      }

      const generatedId = `p_${source}_${this.nextFallbackSeq++}`;
      this.elementIdMap.set(el, generatedId);
      return generatedId;
    }

    /**
     * Primary participant scan.
     * Employs multiple complementary discovery strategies:
     *   1. Stage Nameplate discovery (works for cameras ON and OFF)
     *   2. Active Video Tiles discovery (<video> elements on stage)
     *   3. Explicit Participant Tiles (data-allocation-index, data-participant-id, etc.)
     *   4. Stage Avatars (profile images and initial circles for camera-off tiles)
     *   5. Verified People / Contributors Panel and listitems
     *   6. Local user guarantee from bottom-bar controls
     *
     * @param {Document|Element} doc
     * @returns {Array<Object>} List of currently observed participants
     */
    scanParticipants(doc = document) {
      const presentationDetector = root.MeetrixPresentationDetector;
      const cameraDetector = root.MeetrixCameraDetector;
      const deviceDetector = root.MeetrixDeviceDetector;

      this.detectSelfName(doc);
      const activePresentation = presentationDetector
        ? presentationDetector.detectActivePresentation(doc, this.selfName)
        : { isPresenting: false, presenterName: null };

      const discovered = [];
      const isDebug = !!(root.__meetrix_debug || (typeof window !== 'undefined' && window.__meetrix_debug));

      /**
       * Internal helper to register or update a discovered participant.
       */
      const addParticipant = (rawName, element, source, forcedCamera = null) => {
        const cleanedName = this.cleanName(rawName);
        if (!cleanedName) return;

        const isSelf = Boolean(
          (this.selfName && cleanedName.toLowerCase() === this.selfName.toLowerCase()) ||
          (element && (element.hasAttribute('data-self-name') || (element.getAttribute('aria-label') || '').includes('(You)'))) ||
          (rawName && rawName.includes('(You)'))
        );

        if (isSelf && !this.selfName) {
          this.selfName = cleanedName;
        }

        const isPresenting = Boolean(
          activePresentation.isPresenting && (
            (activePresentation.presenterName && activePresentation.presenterName.toLowerCase() === cleanedName.toLowerCase()) ||
            (isSelf && activePresentation.presenterName === 'You')
          )
        );

        // Detect camera status:
        // Priority: forcedCamera > cameraDetector.detectCameraStatus > Unknown
        let cameraStatus = forcedCamera;
        if (!cameraStatus && cameraDetector) {
          cameraStatus = cameraDetector.detectCameraStatus(element, isSelf, doc);
        }
        if (!cameraStatus) {
          cameraStatus = 'Unknown';
        }

        // Estimate device type
        const deviceType = deviceDetector
          ? deviceDetector.estimateDevice(element, cleanedName, isPresenting, isSelf)
          : 'Unknown';

        const stableId = this.getOrCreateElementId(
          element,
          cleanedName,
          source
        );

        // Conservative participant correlation:
        // 1. Direct element or stableId match
        // 2. Correlate stage observations with an existing panel entry only if unique
        let existing = null;
        if (element) {
          existing = discovered.find(p => p.element === element || p.id === stableId);
        }
        if (!existing) {
          existing = discovered.find(p => p.id === stableId);
        }
        if (!existing) {
          const sameName = discovered.filter(p => p.name.toLowerCase() === cleanedName.toLowerCase());
          if (sameName.length === 1) {
            existing = sameName[0];
            if (source !== 'panel') existing._stageBound = true;
          }
        }

        if (existing) {
          // Update camera status:
          const isDefinitive = (s) => s === 'Camera ON' || s === 'Camera OFF' || s === 'ON' || s === 'OFF';
          const isOn = (s) => s === 'ON' || s === 'Camera ON';
          const isOff = (s) => s === 'OFF' || s === 'Camera OFF';

          if (isDefinitive(cameraStatus)) {
            if (isOn(cameraStatus)) {
              existing.cameraStatus = 'Camera ON';
            } else if (isOff(cameraStatus)) {
              // Only apply Camera OFF if active video hasn't confirmed Camera ON in this cycle
              if (!isOn(existing.cameraStatus)) {
                existing.cameraStatus = 'Camera OFF';
              }
            }
          }

          // Update device type
          const isWeakDev = (d) => !d || d === 'Unknown' || d === 'Desktop (est.)';
          if (!isWeakDev(deviceType) && isWeakDev(existing.deviceType)) {
            existing.deviceType = deviceType;
          }

          if (isPresenting) {
            existing.presenting = true;
          }

          if (isSelf) {
            existing.isSelf = true;
          }
        } else {
          discovered.push({
            id: stableId,
            participantId: stableId,
            name: cleanedName,
            displayName: cleanedName,
            cameraStatus,
            deviceType,
            presenting: isPresenting,
            identityConfidence: isSelf ? 'High' : (source === 'panel' ? 'High' : 'Medium'),
            dataConfidence: isSelf ? 'High' : (source === 'panel' ? 'High' : 'Medium'),
            source,
            element,
            isSelf,
            _stageBound: source !== 'panel'
          });
        }
      };

      // -------------------------------------------------------------
      // Strategy 1: Scan Verified People / Contributors Panel
      // -------------------------------------------------------------
      const peoplePanel = this.findPeoplePanel(doc);
      if (peoplePanel) {
        const listItems = peoplePanel.querySelectorAll('div[role="listitem"], li[role="listitem"]');
        for (let i = 0; i < listItems.length; i++) {
          const item = listItems[i];
          if (this.isInterfaceControl(item)) continue;
          if (presentationDetector && presentationDetector.isPresentationElement(item)) continue;

          let rawName = item.getAttribute('data-self-name') || '';

          if (!rawName) {
            const nameEl = item.querySelector(
              'span.notranslate, ' +
              'span[title], ' +
              'div.zWGUib, ' +
              'div[role="heading"], ' +
              'span[aria-label]'
            );
            if (nameEl) {
              rawName = nameEl.getAttribute('title') || nameEl.getAttribute('aria-label') || nameEl.textContent;
            }
          }

          if (!rawName && item.hasAttribute('aria-label')) {
            rawName = item.getAttribute('aria-label') || '';
          }

          addParticipant(rawName, item, 'panel');
        }
      }

      // -------------------------------------------------------------
      // Strategy 2: Direct Stage Nameplate Discovery
      // (Crucial: finds participant names whether camera is ON or OFF!)
      // -------------------------------------------------------------
      const nameplateSelectors = [
        'div.zWGUib',
        'span.notranslate',
        'div.PoLmKc',
        'div.XEAZBc',
        'div.j1841c',
        'div.dwSJ2e',
        'div.YVvsv',
        'div.poVWob',
        'div.A37uJ',
        '[data-self-name]',
        '[data-participant-name]'
      ];

      const allNameplates = doc.querySelectorAll(nameplateSelectors.join(', '));
      for (let i = 0; i < allNameplates.length; i++) {
        const plate = allNameplates[i];
        if (this.isInterfaceControl(plate)) continue;
        if (presentationDetector && presentationDetector.isPresentationElement(plate)) continue;

        const raw =
          plate.getAttribute('data-self-name') ||
          plate.getAttribute('data-participant-name') ||
          plate.getAttribute('title') ||
          plate.getAttribute('aria-label') ||
          plate.textContent;

        const cleaned = this.cleanName(raw);
        if (!cleaned) continue;

        // Locate enclosing tile container for camera & device inspection
        const tile = this.findTileForElement(plate, doc);
        addParticipant(cleaned, tile || plate, 'nameplate');
      }

      // -------------------------------------------------------------
      // Strategy 3: Scan Stage Video Elements (<video>)
      // -------------------------------------------------------------
      const allVideos = doc.querySelectorAll('video');
      for (let i = 0; i < allVideos.length; i++) {
        const v = allVideos[i];
        if (this.isInterfaceControl(v)) continue;
        if (presentationDetector && presentationDetector.isPresentationElement(v)) continue;

        const tileContainer = this.findTileForElement(v, doc);
        if (!tileContainer || this.isInterfaceControl(tileContainer)) continue;
        if (presentationDetector && presentationDetector.isPresentationElement(tileContainer)) continue;

        let rawName = tileContainer.getAttribute('data-self-name') || tileContainer.getAttribute('data-participant-name') || '';

        if (!rawName) {
          const nameplate = tileContainer.querySelector(
            'div.zWGUib, span.notranslate, div.PoLmKc, div.XEAZBc, div.j1841c, div.dwSJ2e, div.YVvsv, div.poVWob, div.A37uJ, [data-self-name], [data-participant-name], [data-name], span[title]'
          );
          if (nameplate) {
            rawName = nameplate.getAttribute('data-self-name') || nameplate.getAttribute('data-participant-name') || nameplate.getAttribute('data-name') || nameplate.getAttribute('title') || nameplate.textContent;
          }
        }

        // If not found directly in tileContainer, check immediate parent wrapper
        const parentWrapper = tileContainer.parentElement || tileContainer.parentNode;
        if (!rawName && parentWrapper && !this._isContainerTooBroad(parentWrapper)) {
          const pNameplate = parentWrapper.querySelector(
            'div.zWGUib, span.notranslate, div.PoLmKc, div.XEAZBc, div.j1841c, div.dwSJ2e, div.YVvsv, div.poVWob, div.A37uJ, [data-self-name], [data-participant-name], [data-name], span[title]'
          );
          if (pNameplate) {
            rawName = pNameplate.getAttribute('data-self-name') || pNameplate.getAttribute('data-participant-name') || pNameplate.getAttribute('data-name') || pNameplate.getAttribute('title') || pNameplate.textContent;
          }
        }

        if (!rawName && tileContainer.hasAttribute('aria-label')) {
          rawName = tileContainer.getAttribute('aria-label') || '';
        }

        if (!rawName && v.hasAttribute('aria-label')) {
          rawName = v.getAttribute('aria-label') || '';
        }

        if (!rawName && v.parentElement && v.parentElement.hasAttribute('aria-label')) {
          rawName = v.parentElement.getAttribute('aria-label') || '';
        }

        let videoCamStatus = null;
        if (cameraDetector) {
          const vStatus = cameraDetector.detectCameraStatus(v, false, doc);
          const tStatus = cameraDetector.detectCameraStatus(tileContainer, false, doc);
          if (vStatus === 'Camera ON' || tStatus === 'Camera ON') {
            videoCamStatus = 'Camera ON';
          } else if (vStatus === 'Camera OFF' || tStatus === 'Camera OFF') {
            videoCamStatus = 'Camera OFF';
          }
        }

        addParticipant(rawName, tileContainer, 'video_tile', videoCamStatus);
      }

      // -------------------------------------------------------------
      // Strategy 4: Explicit Participant Tiles (data attributes)
      // -------------------------------------------------------------
      const explicitTiles = doc.querySelectorAll(
        'div[data-allocation-index], ' +
        'div[data-participant-id], ' +
        'div[data-requested-participant-id], ' +
        'div[data-initial-participant-id], ' +
        'div[data-self-name], ' +
        'div[data-tile-id], ' +
        'div[data-ssrc], ' +
        'div[data-stream-type*="video"]'
      );

      for (let i = 0; i < explicitTiles.length; i++) {
        const tile = explicitTiles[i];
        if (this.isInterfaceControl(tile)) continue;
        if (presentationDetector && presentationDetector.isPresentationElement(tile)) continue;

        let rawName = tile.getAttribute('data-self-name') || tile.getAttribute('data-participant-name') || '';

        if (!rawName) {
          const nameplate = tile.querySelector(
            'div.zWGUib, span.notranslate, div.PoLmKc, div.XEAZBc, div.j1841c, div.dwSJ2e, div.YVvsv, div.poVWob, div.A37uJ, [data-name]'
          );
          if (nameplate) {
            rawName = nameplate.getAttribute('data-self-name') || nameplate.getAttribute('data-name') || nameplate.textContent;
          }
        }

        if (!rawName && tile.hasAttribute('aria-label')) {
          rawName = tile.getAttribute('aria-label') || '';
        }

        if (!rawName) {
          const avatar = tile.querySelector('img[alt]');
          if (avatar) rawName = avatar.getAttribute('alt') || '';
        }

        addParticipant(rawName, tile, 'tile');
      }

      // -------------------------------------------------------------
      // Strategy 5: Stage Avatars (for participants with camera OFF)
      // -------------------------------------------------------------
      const avatarElements = doc.querySelectorAll(
        'img[src*="googleusercontent" i], ' +
        'img[alt*="avatar" i], ' +
        'div[data-avatar-url], ' +
        'div[data-initials], ' +
        'div[role="img"][aria-label]'
      );

      for (let i = 0; i < avatarElements.length; i++) {
        const av = avatarElements[i];
        if (this.isInterfaceControl(av)) continue;
        // Strictly exclude avatars in toolbar, header, and People/Contributors panel
        if (av.closest('header, nav, [role="banner"], [role="toolbar"], button, [role="button"], [aria-label*="Google Account" i], [role="tabpanel"], [role="list"], [role="listitem"]')) {
          continue;
        }

        const aria = (av.getAttribute('aria-label') || '').toLowerCase();
        // Strictly ignore microphone, audio, camera, reaction, pin, or volume badges
        if (
          aria.includes('mic') || aria.includes('audio') ||
          aria.includes('camera') || aria.includes('video') ||
          aria.includes('hand') || aria.includes('pin') ||
          aria.includes('volume') || aria.includes('speaker') ||
          aria.includes('reaction') || aria.includes('caption') ||
          aria.includes('turn on') || aria.includes('turn off')
        ) {
          continue;
        }

        if (av.tagName === 'DIV' && av.getAttribute('role') === 'img') {
          const isTrueAvatar =
            av.hasAttribute('data-avatar-url') ||
            av.hasAttribute('data-initials') ||
            aria.includes('avatar') ||
            aria.includes('profile') ||
            aria.includes('photo');
          if (!isTrueAvatar) continue;
        }

        const alt = av.getAttribute('alt') || av.getAttribute('aria-label') || '';
        const cleaned = this.cleanName(alt);
        if (cleaned) {
          const tile = this.findTileForElement(av, doc);
          // Only infer OFF if there is no video in this tile and a prominent avatar is present
          const hasVideo = tile && tile.querySelector('video');
          const isProminent = !hasVideo && cameraDetector && cameraDetector.findProminentCenterAvatar(tile || av);
          addParticipant(cleaned, tile || av, 'avatar', hasVideo ? null : (isProminent ? 'Camera OFF' : null));
        }
      }

      // -------------------------------------------------------------
      // Strategy 6: Scan Global [role="listitem"]
      // (Catches participant rows even if panel wrapper selector differs)
      // -------------------------------------------------------------
      const globalListItems = doc.querySelectorAll('div[role="listitem"], li[role="listitem"]');
      for (let i = 0; i < globalListItems.length; i++) {
        const item = globalListItems[i];
        if (this.isInterfaceControl(item)) continue;
        if (presentationDetector && presentationDetector.isPresentationElement(item)) continue;

        const nameEl = item.querySelector('span.notranslate, div.zWGUib, [data-self-name]');
        if (nameEl) {
          const raw = nameEl.getAttribute('data-self-name') || nameEl.textContent;
          addParticipant(raw, item, 'listitem');
        }
      }

      // -------------------------------------------------------------
      // Strategy 7: Self-Participant Guarantee
      // (Guarantees local user is ALWAYS counted even if tile minimized)
      // -------------------------------------------------------------
      if (this.selfName && !discovered.some(p => p.name.toLowerCase() === this.selfName.toLowerCase())) {
        const selfCam = cameraDetector
          ? cameraDetector.detectCameraStatus(null, true, doc)
          : 'Unknown';

        const isSelfPresenting = Boolean(
          activePresentation.isPresenting &&
          (activePresentation.presenterName === 'You' ||
           (activePresentation.presenterName && activePresentation.presenterName.toLowerCase() === this.selfName.toLowerCase()))
        );

        discovered.push({
          id: `self_${this.selfName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          participantId: `self_${this.selfName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          name: this.selfName,
          displayName: this.selfName,
          cameraStatus: selfCam,
          deviceType: 'Desktop',
          presenting: isSelfPresenting,
          identityConfidence: 'High',
          dataConfidence: 'High',
          source: 'self_signal',
          element: null,
          isSelf: true
        });
      }

      // Update presentation status for all participants
      const results = discovered;

      if (activePresentation.isPresenting && activePresentation.presenterName) {
        const pNameLower = activePresentation.presenterName.toLowerCase();
        for (const p of results) {
          if (p.name.toLowerCase() === pNameLower || (p.isSelf && pNameLower === 'you')) {
            p.presenting = true;
          }
        }
      }

      if (isDebug) {
        console.group('[Meetrix Debug] Participant Scan Cycle');
        console.log(`Self Name: ${this.selfName || 'Undetected'}`);
        console.log(`Active Presenter: ${activePresentation.presenterName || 'None'}`);
        console.log(`Total Observed: ${results.length}`);
        results.forEach(p => {
          console.log(`- ${p.name} | Camera: ${p.cameraStatus} | Device: ${p.deviceType} | Presenting: ${p.presenting} | Source: ${p.source} | isSelf: ${p.isSelf}`);
        });
        console.groupEnd();
      }

      return results;
    }
  }

  const detector = new MeetrixParticipantDetector();
  root.MeetrixParticipantDetector = detector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = detector;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
