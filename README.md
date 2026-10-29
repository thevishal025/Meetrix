# Meetrix — Smart Meeting Attendance Tracker
> **Platform:** Google Chrome Extension (Manifest V3)  

Meetrix is a lightweight, local-first meeting attendance and participant tracking Chrome extension for **Google Meet**. It provides real-time participant tracking, presentation status detection, camera status verification, device estimation, and downloadable CSV attendance reports.

Meetrix operates **100% locally in your browser**. It requires no paid APIs, no API keys, no subscriptions, no backend server, and makes zero external network requests. All logic is implemented purely using vanilla JavaScript, the Chrome Extension Manifest V3 APIs, and DOM MutationObservers.

---

## Key Features

1. **Accurate Participant Detection**:
   - Extracts real display names from both the Google Meet People panel and video tile grids.
   - Robust Unicode support (Hindi, Japanese, Arabic, Cyrillic, accented characters, emojis) and multi-word names.
   - Graceful fallback: If identity cannot be established reliably, displays `Name unavailable` instead of fabricating names.
   - Identical display name handling via unique Meet identifiers.

2. **Screen Sharing & Presentation Protection (Zero Duplicate Participants)**:
   - Screen-sharing tiles and presentation elements are **never** counted as separate or "Unknown" participants.
   - Automatically associates the presentation with the actual presenter (e.g. `Vishal Maurya | Presenting`).
   - If presenter identity cannot be established from the DOM, displays `Presenter identity unavailable`.
   - Removes presentation status immediately when screen sharing ends.

3. **Camera Status Detection**:
   - Detects `ON`, `OFF`, or `UNKNOWN` using visible Google Meet interface indicators (active video feeds, avatar overlays, camera off badges).
   - Never guesses camera state without concrete evidence.

4. **Legitimate Device Type Estimation**:
   - Detects `Mobile`, `Desktop/Laptop`, or `Unknown`.
   - Identifies dial-in telephone numbers and phone badges as `Mobile`.
   - Identifies screen share capabilities as `Desktop/Laptop`.
   - Falls back honestly to `Unknown` if no definitive evidence exists (never infers device solely from aspect ratio).

5. **Attendance Timeline & Duration Calculation**:
   - Records `First Observed`, `Estimated Join Time`, `Estimated Leave Time`, and `Observed Duration Seconds`.
   - Utilizes a configurable 25-second grace period to prevent false "left" triggers caused by Meet tile repagination or layout toggles.
   - Distinguishes exact observations from estimates; never fabricates historical timestamps.

6. **Local Persistence & Tab Reload Resilience**:
   - Automatically saves meeting session state to `chrome.storage.local`.
   - Closing and reopening the popup preserves all meeting data.
   - Meeting tab reloads automatically restore the active session.
   - Provides a "New Session" button with a confirmation modal to avoid accidental data loss.

7. **Downloadable CSV Attendance Reports**:
   - Exports reports named `meetrix-attendance-YYYY-MM-DD.csv`.
   - Includes UTF-8 Byte Order Mark (`\uFEFF`) and RFC 4180 quotation escaping for clean opening in Microsoft Excel and Google Sheets.
   - Uses the Chrome Downloads API with fallback to Blob anchor downloads.

8. **Compact, Premium Dark Popup**:
   - Minimalist, dark-themed UI (390px width) matching modern developer tools.
   - Real-time live status indicator and participant summary.
   - Clickable participant rows with an inspection drawer showing identifiers, join/leave timestamps, and confidence ratings.

---

## Project Structure

```text
meetrix/
├── manifest.json              # Chrome Extension Manifest V3 configuration
├── popup.html                 # Compact popup UI
├── popup.css                  # Dark-themed responsive styling
├── popup.js                   # Popup controller and live sync logic
├── content.js                 # Content script for Meet DOM observing and event handling
├── background.js              # Ephemeral MV3 service worker for badge updates and downloads
├── attendance.js              # Attendance tracking, duration calculation, and lifecycle
├── participant-detector.js    # Multi-strategy participant DOM scanner and deduplicator
├── presentation-detector.js   # Presentation exclusion and presenter attribution
├── camera-detector.js         # Camera status detector (ON, OFF, UNKNOWN)
├── device-detector.js         # Evidence-based device estimator
├── storage.js                 # Local persistence layer over chrome.storage.local
├── report-generator.js        # CSV report generator with UTF-8 BOM
├── test-suite.js              # Automated Node.js validation test suite
└── icons/                     # Extension branding icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation in Google Chrome

1. **Download or Locate the Project Folder**:
   The extension source code is located at:
   `C:\Users\vkmga\OneDrive\Desktop\intern\Meetrix`

2. **Open Extensions in Chrome**:
   In Google Chrome, navigate to:
   ```text
   chrome://extensions
   ```

3. **Enable Developer Mode**:
   Toggle the **Developer mode** switch in the top-right corner of the page.

4. **Load the Extension**:
   - Click the **Load unpacked** button in the top-left corner.
   - In the file picker, select the `Meetrix` directory (`C:\Users\vkmga\OneDrive\Desktop\intern\Meetrix`).
   - Click **Select Folder**.

5. **Pin Meetrix for Easy Access**:
   Click the puzzle piece icon (Extensions) on the Chrome toolbar, find **Meetrix - Smart Meeting Attendance Tracker**, and click the Pin icon.

6. **Use with Google Meet**:
   - Open or join any Google Meet call at `https://meet.google.com/`.
   - Click the Meetrix icon in the Chrome toolbar to view the live attendance dashboard.

---

## Testing & Verification Checklist

| # | Test Scenario | Expected Outcome | Verification Status |
|---|---|---|---|
| 1 | One participant joins | Detected with Join Time and Present status | Verified |
| 2 | Multiple participants join | All participants listed with deduplication | Verified |
| 3 | Participant leaves & returns | Marked 'Left' after grace period; restored to 'Present' on return | Verified |
| 4 | Identical display names | Distinct participant IDs preserve separate records | Verified |
| 5 | Participant starts screen share | Attributed to presenter; **NO** duplicate or "Unknown" record created | Verified |
| 6 | Screen share stops | Presenter status reverts from 'Presenting' to 'Present' | Verified |
| 7 | Camera status changes | Detected as 'ON' or 'OFF' based on visible video/avatar | Verified |
| 8 | Popup closed & reopened | All session records and duration counters preserved | Verified |
| 9 | Meeting tab reloaded | Session automatically resumes from `chrome.storage.local` | Verified |
| 10 | Tracking begins mid-meeting | Records current observation time; never fabricates past timestamps | Verified |
| 11 | Participant name unavailable | Displays `Name unavailable` without inventing names | Verified |
| 12 | CSV report download | Valid `meetrix-attendance-YYYY-MM-DD.csv` with UTF-8 Unicode names | Verified |

To run the automated test suite locally:
```bash
node test-suite.js
```

---

## Known Limitations & Honest Fallbacks

- **Google Meet DOM Updates**: Google Meet does not provide a public DOM API. Meetrix employs multi-tiered selectors (aria-labels, role attributes, data-participant-id, and class patterns). If Google significantly alters internal class names, aria-labels and semantic DOM fallback strategies maintain functionality.
- **Side Panel Inactive**: If the "People" tab in Google Meet is closed, Meetrix reads visible participant tiles from the stage grid. Opening the People panel provides the highest accuracy.
- **Device Type Fallbacks**: In compliance with privacy guidelines, Meetrix does not inspect hardware or guess device type from video aspect ratios. When conclusive badges (phone dial-in or screen share) are absent, it displays `Unknown`.
- **Camera Status**: If a participant is only listed in the side panel without video tile visibility and no muted camera icon, camera status is reported as `UNKNOWN`.

---

## Privacy Notice

Meetrix operates with a strict local privacy architecture:
- Zero telemetry or analytics.
- Zero audio or video stream recording.
- No network requests to external servers.
- All attendance records remain within the user's browser `chrome.storage.local`.
