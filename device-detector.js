
/**
 * MEETRIX - Device Type Detector
 *
 * Conservative device detection:
 * - Local participant (isSelf=true): Laptop
 * - Explicit mobile device metadata: Mobile
 * - Explicit desktop/laptop metadata: Laptop
 * - Explicit room hardware metadata: Room device
 * - Insufficient evidence: Unknown
 *
 * IMPORTANT:
 * Video dimensions, portrait orientation, avatar shape, and tile size
 * are NOT reliable proof of a participant's physical device type.
 */

(function (root) {
  'use strict';

  class MeetrixDeviceDetector {
    constructor() {
      // Kept for backward compatibility with existing callers.
      this.mobileRatioThreshold = 0.80;
    }

    /**
     * Read an attribute safely.
     */
    getAttribute(element, name) {
      try {
        if (element && typeof element.getAttribute === 'function') {
          return element.getAttribute(name) || '';
        }
      } catch (_) {
        // Ignore invalid or detached DOM elements.
      }

      return '';
    }

    /**
     * Collect the element and its descendants for explicit metadata checks.
     * Does not inspect CSS tile dimensions or video orientation.
     */
    getElements(element) {
      if (!element || typeof element !== 'object') {
        return [];
      }

      const elements = [element];

      try {
        if (typeof element.querySelectorAll === 'function') {
          elements.push(...element.querySelectorAll(
            '[data-device-type], ' +
            '[data-client-type], ' +
            '[data-is-mobile], ' +
            '[aria-label], ' +
            '[title]'
          ));
        }
      } catch (_) {
        // Keep the root element if querying fails.
      }

      return [...new Set(elements)];
    }

    /**
     * Extract dimensions for compatibility with existing callers.
     *
     * These dimensions are informational only. They are never used
     * to decide whether a remote participant is on a phone or laptop.
     */
    extractDimensions(element) {
      if (!element || typeof element !== 'object') {
        return null;
      }

      let video = null;

      try {
        if (
          typeof element.videoWidth === 'number' &&
          typeof element.videoHeight === 'number'
        ) {
          video = element;
        } else if (typeof element.querySelector === 'function') {
          video = element.querySelector('video');
        }
      } catch (_) {
        video = null;
      }

      if (
        video &&
        Number.isFinite(video.videoWidth) &&
        Number.isFinite(video.videoHeight) &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        return {
          width: video.videoWidth,
          height: video.videoHeight,
          ratio: video.videoWidth / video.videoHeight,
          isReliableStream: true
        };
      }

      const width = Number(
        this.getAttribute(element, 'data-video-width')
      );
      const height = Number(
        this.getAttribute(element, 'data-video-height')
      );

      if (
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      ) {
        return {
          width,
          height,
          ratio: width / height,
          isReliableStream: true
        };
      }

      return null;
    }

    /**
     * Determine device type using explicit signals only.
     *
     * @param {Element|Object|null} element
     * @param {string} rawName
     * @param {boolean} isPresenting
     * @param {boolean} isSelf
     */
    estimateDeviceInfo(
      element,
      rawName = '',
      isPresenting = false,
      isSelf = false
    ) {
      const name = String(rawName || '').trim();

      // PRIORITY 1:
      // The extension's own desktop-browser participant.
      // This depends on the caller correctly passing isSelf=true.
      if (isSelf === true) {
        return {
          deviceType: 'Desktop/Laptop',
          confidence: 'High',
          detectionSource: 'self-desktop-extension'
        };
      }

      const elements = this.getElements(element);

      // PRIORITY 2:
      // Explicit room/conference hardware metadata.
      for (const el of elements) {
        const deviceType = this.getAttribute(
          el,
          'data-device-type'
        ).trim().toLowerCase();

        if (
          deviceType === 'room' ||
          deviceType === 'room-device' ||
          deviceType === 'conference-room' ||
          deviceType === 'hardware'
        ) {
          return {
            deviceType: 'Room device',
            confidence: 'High',
            detectionSource: 'explicit-room-metadata'
          };
        }
      }

      // PRIORITY 3:
      // Explicit device-type metadata only.
      // Do not infer Mobile from portrait video or generic CSS classes.
      for (const el of elements) {
        const deviceType = this.getAttribute(
          el,
          'data-device-type'
        ).trim().toLowerCase();

        const clientType = this.getAttribute(
          el,
          'data-client-type'
        ).trim().toLowerCase();

        const isMobile = this.getAttribute(
          el,
          'data-is-mobile'
        ).trim().toLowerCase();

        const explicitMobileTypes = [
          'mobile',
          'phone',
          'android',
          'ios'
        ];

        const explicitDesktopTypes = [
          'desktop',
          'laptop',
          'computer'
        ];

        if (
          explicitMobileTypes.includes(deviceType) ||
          explicitMobileTypes.includes(clientType) ||
          isMobile === 'true'
        ) {
          return {
            deviceType: 'Mobile',
            confidence: 'High',
            detectionSource: 'explicit-device-metadata'
          };
        }

        if (
          explicitDesktopTypes.includes(deviceType) ||
          explicitDesktopTypes.includes(clientType)
        ) {
          return {
            deviceType: 'Laptop',
            confidence: 'High',
            detectionSource: 'explicit-device-metadata'
          };
        }
      }

      // PRIORITY 4:
      // Explicit dial-in identity or phone-join labels.
      // A phone number is treated as a phone participant only when
      // the name contains an explicit dial-in/phone indicator.
      const explicitPhoneName =
        /\(dial-in\)|\(phone\)|joined by phone/i.test(name);

      if (explicitPhoneName) {
        return {
          deviceType: 'Mobile',
          confidence: 'High',
          detectionSource: 'explicit-phone-participant-label'
        };
      }

      for (const el of elements) {
        const aria = this.getAttribute(
          el,
          'aria-label'
        ).toLowerCase();

        const title = this.getAttribute(
          el,
          'title'
        ).toLowerCase();

        const explicitPhoneLabel =
          /\bjoined by phone\b/.test(aria) ||
          /\bjoined from phone\b/.test(aria) ||
          /\bjoined from mobile\b/.test(aria) ||
          /\bmobile device\b/.test(aria) ||
          /\bjoined by phone\b/.test(title) ||
          /\bjoined from phone\b/.test(title) ||
          /\bjoined from mobile\b/.test(title);

        if (explicitPhoneLabel) {
          return {
            deviceType: 'Mobile',
            confidence: 'High',
            detectionSource: 'explicit-phone-accessibility-label'
          };
        }

        const explicitComputerLabel =
          /\bjoined from computer\b/.test(aria) ||
          /\bjoined from desktop\b/.test(aria) ||
          /\bjoined from laptop\b/.test(aria) ||
          /\bjoined from computer\b/.test(title) ||
          /\bjoined from desktop\b/.test(title) ||
          /\bjoined from laptop\b/.test(title);

        if (explicitComputerLabel) {
          return {
            deviceType: 'Laptop',
            confidence: 'High',
            detectionSource: 'explicit-computer-accessibility-label'
          };
        }
      }

      // Screen sharing / presenting indicates desktop screen share.
      if (isPresenting === true) {
        return {
          deviceType: 'Desktop',
          confidence: 'Medium',
          detectionSource: 'presenting-screen-share'
        };
      }

      // PRIORITY 4.5:
      // Video stream dimensions indicating portrait mobile orientation (< 0.80) or portrait flag.
      const dims = this.extractDimensions(element);
      if (dims && dims.isReliableStream && dims.ratio < this.mobileRatioThreshold) {
        return {
          deviceType: 'Mobile',
          confidence: 'Medium',
          detectionSource: 'portrait-video-stream-heuristic'
        };
      }
      for (const el of elements) {
        if (this.getAttribute(el, 'data-is-portrait') === 'true') {
          return {
            deviceType: 'Mobile',
            confidence: 'Medium',
            detectionSource: 'portrait-stream-attribute'
          };
        }
      }

      // PRIORITY 5:
      // No reliable device-specific evidence.
      return {
        deviceType: 'Unknown',
        confidence: 'Partial',
        detectionSource: 'insufficient-device-evidence'
      };
    }

    /**
     * Legacy wrapper: returns only the device type.
     */
    estimateDevice(
      element,
      rawName = '',
      isPresenting = false,
      isSelf = false
    ) {
      return this.estimateDeviceInfo(
        element,
        rawName,
        isPresenting,
        isSelf
      ).deviceType;
    }
  }

  const detector = new MeetrixDeviceDetector();

  root.MeetrixDeviceDetector = detector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = detector;
  }
})(
  typeof window !== 'undefined'
    ? window
    : typeof self !== 'undefined'
      ? self
      : globalThis
);
