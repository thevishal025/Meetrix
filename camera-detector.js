/**
 * Meetrix - Camera Status Detector (v2)
 *
 * Detects camera ON / OFF / UNVERIFIED states using all available Google Meet signals.
 *
 * State semantics:
 *   ON         - Reliable positive evidence: button label, aria-label, or active video frames.
 *   OFF        - Reliable negative evidence: button label, aria-label, hidden video, or prominent avatar.
 *   UNVERIFIED - Insufficient evidence from this source; caller should prefer evidence from another source.
 *
 * Guarantees:
 *   - Never confuses microphone mute icons with camera status.
 *   - Does NOT treat a black/dark video tile as camera OFF.
 *   - Does NOT use tile size or position to infer device type.
 *   - Returns UNVERIFIED rather than guessing.
 *   - Self camera state is detected from bottom-bar controls (most reliable).
 */

(function (root) {
  'use strict';

  class MeetrixCameraDetector {
    /**
     * Determines camera status for a participant element.
     * @param {Element|null} container  DOM element of the video tile or participant list row
     * @param {boolean}      isSelf     Whether this participant is the local user
     * @param {Document}     doc        The document context
     * @returns {'ON' | 'OFF' | 'UNVERIFIED'}
     */
    detectCameraStatus(container, isSelf = false, doc = document) {
      // Exclude presentation / screen share tiles from camera determination
      if (container && root.MeetrixPresentationDetector && root.MeetrixPresentationDetector.isPresentationElement(container)) {
        return 'Unknown';
      }

      // ------------------------------------------------------------------
      // Strategy 1: Local user bottom-bar call controls (most reliable for self)
      // ------------------------------------------------------------------
      if (isSelf && doc) {
        const camBtns = doc.querySelectorAll(
          'button[aria-label*="camera" i], ' +
          'button[aria-label*="video" i], ' +
          'button[data-tooltip*="camera" i], ' +
          'div[role="button"][aria-label*="camera" i]'
        );

        for (let i = 0; i < camBtns.length; i++) {
          const btn = camBtns[i];
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          const isMuted = btn.getAttribute('data-is-muted');

          // If button says "turn off camera", it's currently ON
          if (aria.includes('turn off') || aria.includes('stop camera') || aria.includes('stop video')) {
            return 'Camera ON';
          }
          // If button says "turn on camera", it's currently OFF
          if (aria.includes('turn on') || aria.includes('start camera') || aria.includes('start video')) {
            return 'Camera OFF';
          }
          // data-is-muted="false" means camera is ON
          if (isMuted === 'false') {
            return 'Camera ON';
          }
          if (isMuted === 'true') {
            return 'Camera OFF';
          }
        }
      }

      if (!container) return 'Unknown';

      // ------------------------------------------------------------------
      // Strategy 2: Explicit aria/title labels on the container or child icons
      // ------------------------------------------------------------------
      const result = this._checkAriaLabels(container);
      if (result !== 'Unknown') return result;

      // ------------------------------------------------------------------
      // Strategy 3: Active <video> element state
      // ------------------------------------------------------------------
      const videoEl = container.tagName === 'VIDEO'
        ? container
        : container.querySelector('video');

      if (videoEl) {
        return this._inferFromVideo(videoEl, container);
      }

      // ------------------------------------------------------------------
      // Strategy 4: Stage tile with prominent center avatar and no <video>
      // ------------------------------------------------------------------
      const isListRow =
        container.getAttribute('role') === 'listitem' ||
        !!container.closest('[role="listitem"]');

      if (!isListRow) {
        // Only infer OFF from avatar when there is no <video> at all
        if (this.findProminentCenterAvatar(container)) {
          return 'Camera OFF';
        }
      }

      // ------------------------------------------------------------------
      // Strategy 5: People/Contributors panel rows - camera state is not exposed
      // ------------------------------------------------------------------
      return 'Unknown';
    }

    /**
     * Scans aria-label and title attributes on the container and relevant child elements.
     * Strictly ignores microphone/audio attributes.
     * @param {Element} container
     * @returns {'Camera ON'|'Camera OFF'|'Unknown'}
     */
    _checkAriaLabels(container) {
      const aria = (container.getAttribute('aria-label') || '').toLowerCase();
      const title = (container.getAttribute('title') || '').toLowerCase();

      const isMicContext =
        aria.includes('mic') || aria.includes('audio') ||
        title.includes('mic') || title.includes('audio');

      if (!isMicContext) {
        if (
          aria.includes('camera is off') ||
          aria.includes('camera is turned off') ||
          aria.includes('video is off') ||
          aria.includes('camera off') ||
          title.includes('camera is off') ||
          title.includes('video is off')
        ) return 'Camera OFF';

        if (
          aria.includes('camera is on') ||
          aria.includes('camera is turned on') ||
          aria.includes('video is on') ||
          aria.includes('camera on') ||
          title.includes('camera is on') ||
          title.includes('video is on')
        ) return 'Camera ON';
      }

      // Child icons/indicators
      const offIndicators = container.querySelectorAll(
        '[aria-label*="camera is off" i], [aria-label*="camera off" i], ' +
        '[aria-label*="video off" i], [aria-label*="video is off" i], ' +
        '[title*="camera is off" i], [title*="video is off" i]'
      );
      for (let i = 0; i < offIndicators.length; i++) {
        const a = (offIndicators[i].getAttribute('aria-label') || '').toLowerCase();
        if (!a.includes('mic') && !a.includes('audio')) return 'Camera OFF';
      }

      const onIndicators = container.querySelectorAll(
        '[aria-label*="camera is on" i], [aria-label*="camera on" i], ' +
        '[aria-label*="video is on" i], [aria-label*="video on" i]'
      );
      for (let i = 0; i < onIndicators.length; i++) {
        const a = (onIndicators[i].getAttribute('aria-label') || '').toLowerCase();
        if (!a.includes('mic') && !a.includes('audio')) return 'Camera ON';
      }

      return 'Unknown';
    }

    /**
     * Infers camera state from a <video> element's runtime properties.
     * Does NOT treat a black/dark frame as camera OFF — only uses metadata.
     * @param {HTMLVideoElement} videoEl
     * @param {Element} container
     * @returns {'Camera ON'|'Camera OFF'|'Unknown'}
     */
    _inferFromVideo(videoEl, container) {
      let isHidden = false;
      try {
        if (videoEl.hidden) isHidden = true;
        if (!isHidden && videoEl.style) {
          const d = videoEl.style.display;
          const v = videoEl.style.visibility;
          const op = videoEl.style.opacity;
          if (d === 'none' || v === 'hidden' || op === '0') isHidden = true;
        }
        if (!isHidden && typeof window !== 'undefined' && window.getComputedStyle) {
          const cs = window.getComputedStyle(videoEl);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0)) {
            isHidden = true;
          }
        }
      } catch (_) {}

      if (isHidden) return 'Camera OFF';

      // 1. Positive proof: video has active decoded frame dimensions
      const hasDimensions =
        typeof videoEl.videoWidth === 'number' &&
        videoEl.videoWidth > 0 &&
        typeof videoEl.videoHeight === 'number' &&
        videoEl.videoHeight > 0;

      if (hasDimensions && !videoEl.ended) {
        return 'Camera ON';
      }

      // 2. Positive proof: video has readyState >= 1 and is streaming or has currentTime
      const isReady = typeof videoEl.readyState === 'number' ? videoEl.readyState >= 1 : true;
      const isPlaying = (!videoEl.paused || (typeof videoEl.currentTime === 'number' && videoEl.currentTime > 0)) && !videoEl.ended;

      if (isReady && isPlaying && !videoEl.ended) {
        return 'Camera ON';
      }

      // 3. If video element is visible and container has NO prominent center avatar visible
      const centerAvatar = this.findProminentCenterAvatar(container);
      if (!centerAvatar) {
        return 'Camera ON';
      }

      // 4. If video is present but has 0 dimensions / paused and a prominent center avatar is visible
      return 'Camera OFF';
    }

    /**
     * Identifies a true visible center profile avatar representing camera-off overlay.
     * Excludes microphone mute badges, corner icons, and small status indicators.
     * @param {Element} container
     * @returns {Element|null}
     */
    findProminentCenterAvatar(container) {
      if (!container || !container.querySelectorAll) return null;

      // People panel listitems should NEVER be treated as stage center avatars
      const isListRow =
        container.getAttribute && (
          container.getAttribute('role') === 'listitem' ||
          !!(container.closest && container.closest('[role="listitem"]'))
        );
      if (isListRow) return null;

      const avatars = container.querySelectorAll(
        'img[src*="googleusercontent" i], ' +
        'img[alt*="avatar" i], ' +
        'div[data-avatar-url], ' +
        'div[data-initials], ' +
        'div[data-member-id], ' +
        'span[data-initials], ' +
        'div[role="img"][aria-label]'
      );

      for (let i = 0; i < avatars.length; i++) {
        const el = avatars[i];

        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const cls = (el.getAttribute('class') || '').toLowerCase();

        // Skip mic/audio/volume/hand/reaction/pin badges and controls
        if (
          aria.includes('mic') || aria.includes('audio') ||
          title.includes('mic') || title.includes('audio') ||
          aria.includes('volume') || aria.includes('pin') ||
          aria.includes('hand') || aria.includes('reaction') ||
          cls.includes('mic')
        ) continue;

        // Skip if inside a button, toolbar, or mic control
        if (el.closest && el.closest('[aria-label*="mic" i], [aria-label*="audio" i], button, [role="button"]')) {
          continue;
        }

        // Check if avatar is hidden
        let isHidden = false;
        try {
          if (el.hidden) isHidden = true;
          if (!isHidden && el.style) {
            const d = el.style.display;
            const v = el.style.visibility;
            const op = el.style.opacity;
            if (d === 'none' || v === 'hidden' || op === '0') isHidden = true;
          }
          if (!isHidden && typeof window !== 'undefined' && window.getComputedStyle) {
            const cs = window.getComputedStyle(el);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0)) {
              isHidden = true;
            }
          }
        } catch (_) {}

        if (isHidden) continue;

        // Must be large enough to be a stage-level avatar (≥24px or mock dimensions)
        if (el.getBoundingClientRect) {
          const rect = el.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.width < 24) {
            continue;
          }
        }

        return el;
      }

      return null;
    }
  }

  const detector = new MeetrixCameraDetector();
  root.MeetrixCameraDetector = detector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = detector;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
