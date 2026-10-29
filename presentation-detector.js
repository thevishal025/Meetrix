/**
 * Meetrix - Presentation Detector (v2)
 * 
 * Accurately tracks screen-sharing and presentations in Google Meet.
 * Critical guarantees:
 * 1. Screen shares and presentation tiles are NEVER counted as participants.
 * 2. Accurately detects local ("You are presenting") and remote presentations.
 * 3. Associates presentation with the presenter name.
 */

(function (root) {
  'use strict';

  class MeetrixPresentationDetector {
    constructor() {
      this.patterns = [
        /^presentation\s*\((.+?)\)$/i,
        /^(.+?)\s*\((?:presentation|presenting)\)$/i,
        /^(.+?)'s\s+(?:presentation|screen)$/i,
        /^(.+?)\s+is\s+presenting$/i,
        /^you\s+(?:are|'re)\s+presenting/i,
        /^stop\s+presenting/i
      ];
    }

    /**
     * Checks if a DOM element is a presentation tile, presentation list item, or screen share element.
     * @param {Element} element 
     * @returns {boolean}
     */
    isPresentationElement(element) {
      if (!element || !(element instanceof Element)) return false;

      // 1. Explicit attributes used by Google Meet for presentations
      if (
        element.getAttribute('data-is-screen-share') === 'true' ||
        element.getAttribute('data-is-presentation') === 'true' ||
        (element.getAttribute('data-requested-participant-id') || '').includes('screenshare') ||
        (element.getAttribute('data-stream-type') || '').includes('presentation')
      ) {
        return true;
      }

      // Check inner elements for presentation attributes
      if (
        element.querySelector('[data-is-screen-share="true"]') ||
        element.querySelector('[data-stream-type*="presentation"]') ||
        element.querySelector('[data-requested-participant-id*="screenshare"]')
      ) {
        return true;
      }

      // 2. Check for Stop presenting button inside or on element
      if (
        element.querySelector('button[aria-label*="stop presenting" i]') ||
        element.querySelector('button[aria-label*="stop sharing" i]')
      ) {
        return true;
      }

      // 3. Aria-labels or text indicating presentation
      const aria = (element.getAttribute('aria-label') || '').toLowerCase();
      if (
        aria.includes('you are presenting') ||
        aria.includes("you're presenting") ||
        aria.includes('your presentation') ||
        aria.includes('stop presenting') ||
        aria.includes('is presenting') ||
        aria.includes("'s presentation") ||
        aria.includes('(presentation)') ||
        aria.includes('(presenting)') ||
        aria === 'presentation' ||
        aria === 'screen share'
      ) {
        return true;
      }

      // 4. Visible text content check
      const fullText = (element.innerText || element.textContent || '').trim();
      if (
        /you\s+(?:are|'re)\s+presenting/i.test(fullText) ||
        /stop\s+presenting/i.test(fullText) ||
        /infinity\s+mirror/i.test(fullText) ||
        /share\s+your\s+entire\s+screen/i.test(fullText) ||
        /your\s+presentation/i.test(fullText) ||
        /'s\s+presentation/i.test(fullText) ||
        /\bis\s+presenting\b/i.test(fullText) ||
        /\((?:presentation|presenting)\)/i.test(fullText) ||
        /^presentation$/i.test(fullText)
      ) {
        return true;
      }

      return false;
    }

    /**
     * Checks whether a string represents a presentation indicator.
     * @param {string} str 
     * @returns {boolean}
     */
    matchesPresentationString(str) {
      if (!str) return false;
      const clean = str.trim();

      if (
        /^presentation$/i.test(clean) ||
        /^screen share$/i.test(clean) ||
        /^your presentation$/i.test(clean) ||
        /you\s+(?:are|'re)\s+presenting/i.test(clean) ||
        /stop\s+presenting/i.test(clean) ||
        /infinity\s+mirror/i.test(clean) ||
        /share\s+your\s+entire/i.test(clean) ||
        /\((?:presentation|presenting)\)/i.test(clean) ||
        /\bis\s+presenting\b/i.test(clean) ||
        /'s\s+(?:presentation|screen)$/i.test(clean)
      ) {
        return true;
      }

      for (let i = 0; i < this.patterns.length; i++) {
        if (this.patterns[i].test(clean)) {
          return true;
        }
      }

      return false;
    }

    /**
     * Extracts the participant's name from a presentation label if available.
     * @param {string} rawString e.g. "Presentation (Vishal Maurya)" or "Vishal Maurya (Presentation)"
     * @param {string} selfName Optional display name of self (for "You're presenting")
     * @returns {string|null} The presenter's name, or null if cannot be extracted
     */
    extractPresenterNameFromText(rawString, selfName = '') {
      if (!rawString) return null;
      const clean = rawString.trim();

      // Check for self presenting
      if (
        /you're presenting/i.test(clean) ||
        /you are presenting/i.test(clean) ||
        /^your presentation$/i.test(clean) ||
        /\(you\)\s*\(presentation\)/i.test(clean) ||
        /presentation\s*\(\s*you\s*\)/i.test(clean)
      ) {
        return selfName || 'You';
      }

      for (let i = 0; i < this.patterns.length; i++) {
        const match = clean.match(this.patterns[i]);
        if (match) {
          const candidate = (match[1] || match[2] || '').trim();
          if (candidate && !/^presentation$/i.test(candidate)) {
            return candidate.replace(/\s*\(you\)/i, '').trim();
          }
        }
      }

      return null;
    }

    /**
     * Scans the document for any active presentation and determines the presenter.
     * @param {Document|Element} rootEl 
     * @param {string} selfName 
     * @returns {{ isPresenting: boolean, presenterName: string | null }}
     */
    detectActivePresentation(rootEl = document, selfName = '') {
      // 1. Direct check: Is local user presenting?
      // Look for "Stop presenting" button in bottom bar or stage
      const stopPresentingBtn = rootEl.querySelector(
        'button[aria-label*="stop presenting" i], ' +
        'button[aria-label*="stop sharing" i], ' +
        'button[aria-label*="you are presenting" i], ' +
        'button[aria-label*="you\'re presenting" i], ' +
        'button[aria-pressed="true"][aria-label*="present" i], ' +
        'button[aria-pressed="true"][aria-label*="screen" i]'
      );
      if (stopPresentingBtn) {
        return {
          isPresenting: true,
          presenterName: selfName || 'You'
        };
      }

      // 2. Check for buttons with visible text "Stop presenting"
      const allButtons = rootEl.querySelectorAll('button, div[role="button"]');
      for (let i = 0; i < allButtons.length; i++) {
        const b = allButtons[i];
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const bText = (b.innerText || b.textContent || '').trim().toLowerCase();
        if (
          aria.includes('stop presenting') ||
          aria.includes('stop sharing') ||
          bText.includes('stop presenting') ||
          bText.includes('stop sharing')
        ) {
          return {
            isPresenting: true,
            presenterName: selfName || 'You'
          };
        }
      }

      // Check banners/headings: "You are presenting"
      const headings = rootEl.querySelectorAll('h1, h2, h3, div, span, p');
      for (let i = 0; i < headings.length; i++) {
        const text = (headings[i].innerText || headings[i].textContent || '').trim().toLowerCase();
        if (
          (text.includes('you are presenting') || text.includes("you're presenting")) &&
          text.length < 500
        ) {
          return {
            isPresenting: true,
            presenterName: selfName || 'You'
          };
        }
      }

      // 3. Check bottom bar status or notification banners
      const statusElements = rootEl.querySelectorAll(
        'div[role="status"], ' +
        'div[aria-live="polite"], ' +
        'div[aria-label*="presenting" i], ' +
        'div[aria-label*="presentation" i], ' +
        'span[aria-label*="presenting" i]'
      );

      for (let i = 0; i < statusElements.length; i++) {
        const el = statusElements[i];
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();

        if (/you(?:'re| are) presenting/i.test(text)) {
          return {
            isPresenting: true,
            presenterName: selfName || 'You'
          };
        }

        const match = text.match(/([^\n\r.]+?)\s+is presenting/i);
        if (match && match[1]) {
          const name = match[1].trim();
          if (name.length > 0 && !/^someone$/i.test(name)) {
            return {
              isPresenting: true,
              presenterName: name.replace(/\s*\(you\)/i, '').trim()
            };
          }
        }
      }

      // 4. Check for remote presentation video tiles
      const presentationTiles = rootEl.querySelectorAll(
        '[data-is-screen-share="true"], ' +
        '[data-stream-type*="presentation"], ' +
        '[data-requested-participant-id*="screenshare"]'
      );

      if (presentationTiles.length > 0) {
        for (let i = 0; i < presentationTiles.length; i++) {
          const tile = presentationTiles[i];
          const text = (tile.getAttribute('aria-label') || tile.innerText || '').trim();
          const extracted = this.extractPresenterNameFromText(text, selfName);
          if (extracted) {
            return {
              isPresenting: true,
              presenterName: extracted
            };
          }
        }

        return {
          isPresenting: true,
          presenterName: selfName || 'Presenter'
        };
      }

      return {
        isPresenting: false,
        presenterName: null
      };
    }
  }

  const detector = new MeetrixPresentationDetector();
  root.MeetrixPresentationDetector = detector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = detector;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
