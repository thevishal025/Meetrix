/**
 * Meetrix - Attendance Report Generator
 * 
 * Generates local, privacy-compliant CSV attendance reports with UTF-8 BOM support.
 * Triggers downloads via chrome.downloads API or Blob anchor fallback.
 */

(function (root) {
  'use strict';

  const resolveBranding = () => {
    if (typeof root !== 'undefined' && root.MeetrixBranding) return root.MeetrixBranding;
    if (typeof window !== 'undefined' && window.MeetrixBranding) return window.MeetrixBranding;
    if (typeof global !== 'undefined' && global.MeetrixBranding) return global.MeetrixBranding;
    try {
      if (typeof require !== 'undefined') return require('./branding.js');
    } catch (_) {}
    return null;
  };

  class MeetrixReportGenerator {
    escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    }

    buildMeetingSummary(transcript) {
      const lines = Array.isArray(transcript) ? transcript : [];
      const speech = lines.map(l => String(l.text || '').trim()).filter(Boolean);
      if (!speech.length) return { available: false, summary: 'A reliable summary could not be generated because no captions were captured.', topics: [], decisions: [], actions: [], questions: [] };
      const sentences = speech.flatMap(t => t.split(/(?<=[.!?।])\s+/)).map(s => s.trim()).filter(s => s.length > 20);
      const topics = [...new Set((sentences.length ? sentences : speech).slice(0, 5))].slice(0, 5);
      const decisions = speech.filter(t => /\b(decided|decision|agreed|approved|confirmed)\b/i.test(t));
      const actions = speech.filter(t => /\b(will|action item|follow up|follow-up|to do|todo)\b/i.test(t));
      const questions = speech.filter(t => /\?|\b(open question|unresolved|follow.?up)\b/i.test(t));
      return { available: true, summary: topics.slice(0, 3).join(' ') || 'Captions were captured, but there is not enough text for a concise summary.', topics, decisions, actions, questions };
    }

    buildHtmlReport(options = {}) {
      const { meetingDetails = {}, participants = [], transcript = [], aiInsight = null } = options;
      const summary = aiInsight
        ? {
            available: true,
            summary: aiInsight.summary || '',
            topics: aiInsight.keyPoints || [],
            decisions: aiInsight.decisions || [],
            actions: aiInsight.actionItems || [],
            questions: aiInsight.followUps || []
          }
        : this.buildMeetingSummary(transcript);

      const e = this.escapeHtml.bind(this);
      const meetingTitleOrId = meetingDetails.title || meetingDetails.meetingId || meetingDetails.id || 'Not recorded';
      const meetingDateTime = meetingDetails.startTime ? new Date(meetingDetails.startTime).toLocaleString() : 'Not recorded';
      const reportGenTime = new Date().toLocaleString();

      let durationText = meetingDetails.duration;
      if (!durationText || durationText === 'Not recorded') {
        if (meetingDetails.startTime) {
          const end = meetingDetails.endTime || Date.now();
          const sec = Math.max(0, Math.round((end - meetingDetails.startTime) / 1000));
          durationText = sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} sec`;
        } else {
          durationText = 'Not recorded';
        }
      }

      const corrected = aiInsight && Array.isArray(aiInsight.correctedCaptions) && aiInsight.correctedCaptions.length === transcript.length
        ? aiInsight.correctedCaptions
        : null;

      // --- SECTION 2: ATTENDANCE ROWS ---
      const sortedParticipants = [...participants].sort((a, b) => {
        if (a.presenting && !b.presenting) return -1;
        if (!a.presenting && b.presenting) return 1;
        return (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '');
      });

      const attendanceRows = sortedParticipants.length ? sortedParticipants.map(p => {
        const name = e(p.displayName || p.name || 'Not recorded');
        const joinRaw = p.firstJoinAt || p.lastJoinAt || p.estimatedJoinTime;
        const joinTime = joinRaw ? e(new Date(joinRaw).toLocaleTimeString()) : 'Not recorded';
        const isLeft = Boolean(p.status && p.status.startsWith('Left'));
        const leaveRaw = p.lastLeaveAt || p.estimatedLeaveTime;
        const leaveTime = isLeft
          ? (leaveRaw ? e(new Date(leaveRaw).toLocaleTimeString()) : 'Not recorded')
          : 'Still present';

        const durSec = p.totalObservedDuration != null ? p.totalObservedDuration : (p.observedDurationSeconds != null ? p.observedDurationSeconds : null);
        let durStr = 'Not recorded';
        if (durSec != null && !isNaN(durSec)) {
          const s = Math.max(0, Math.round(durSec));
          durStr = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} sec` : `${s} sec`;
        }

        const camRaw = p.cameraStatus || 'Unknown';
        let camClass = 'badge-cam-unknown';
        if (camRaw === 'Camera ON') camClass = 'badge-cam-on';
        else if (camRaw === 'Camera OFF') camClass = 'badge-cam-off';

        const devRaw = p.deviceType || 'Unknown';

        const statRaw = p.presenting ? 'Presenting' : (isLeft ? 'Left' : (p.status || 'Present'));
        let statClass = 'badge-stat-present';
        if (statRaw === 'Presenting') statClass = 'badge-stat-presenting';
        else if (statRaw === 'Left') statClass = 'badge-stat-left';

        return `<tr>
          <td><strong>${name}</strong></td>
          <td>${joinTime}</td>
          <td>${leaveTime}</td>
          <td>${durStr}</td>
          <td><span class="badge ${camClass}">${e(camRaw)}</span></td>
          <td><span class="badge badge-device">${e(devRaw)}</span></td>
          <td><span class="badge ${statClass}">${e(statRaw)}</span></td>
        </tr>`;
      }).join('') : `<tr><td colspan="7" class="table-empty">No attendance records observed during this session.</td></tr>`;

      // --- SECTION 3: TRANSCRIPTION ROWS ---
      const transcriptRows = (Array.isArray(transcript) && transcript.length) ? transcript.map((l, i) => {
        const timeStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : 'Time not recorded';
        const speakerStr = l.speaker || 'Speaker not recorded';
        const textStr = corrected ? corrected[i] : (l.text || '');
        return `<div class="transcript-line"><span class="transcript-time">${e(timeStr)}</span> <strong class="transcript-speaker">${e(speakerStr)}</strong><span class="transcript-sep">:</span> <span class="transcript-text">${e(textStr)}</span></div>`;
      }).join('') : '<p class="muted empty-box">No captions were captured during this meeting.</p>';

      // --- SECTION 4: SUMMARY BODY ---
      const summaryBody = (summary.available && summary.summary)
        ? `<div class="summary-box"><p>${e(summary.summary)}</p></div>`
        : `<p class="muted empty-box">A reliable summary could not be generated from the available captions.</p>`;

      // --- SECTION 5: KEY POINTS BODY ---
      const keyPointsBody = (Array.isArray(summary.topics) && summary.topics.length)
        ? `<ul class="bullet-list">${summary.topics.map(t => `<li>${e(t)}</li>`).join('')}</ul>`
        : `<p class="muted empty-box">No key points could be identified from the available captions.</p>`;

      // --- SECTION 6: DECISIONS AND ACTION ITEMS BODY ---
      const decisionsBody = (Array.isArray(summary.decisions) && summary.decisions.length)
        ? `<ul class="bullet-list">${summary.decisions.map(d => `<li>${e(typeof d === 'string' ? d : (d.text || JSON.stringify(d)))}</li>`).join('')}</ul>`
        : `<p class="muted empty-box">No decisions explicitly identified.</p>`;

      const actionsBody = (Array.isArray(summary.actions) && summary.actions.length)
        ? `<ul class="action-list">${summary.actions.map(a => {
            if (typeof a === 'string') return `<li><span class="action-text">${e(a)}</span></li>`;
            const text = e(a.text || a);
            const ownerTag = a.owner ? `<span class="meta-pill">Owner: ${e(a.owner)}</span>` : '';
            const deadlineTag = a.deadline ? `<span class="meta-pill">Deadline: ${e(a.deadline)}</span>` : '';
            return `<li><span class="action-text">${text}</span>${ownerTag ? ' ' + ownerTag : ''}${deadlineTag ? ' ' + deadlineTag : ''}</li>`;
          }).join('')}</ul>`
        : `<p class="muted empty-box">No action items explicitly identified.</p>`;

      const questionsBody = (Array.isArray(summary.questions) && summary.questions.length)
        ? `<ul class="bullet-list">${summary.questions.map(q => `<li>${e(typeof q === 'string' ? q : (q.text || JSON.stringify(q)))}</li>`).join('')}</ul>`
        : `<p class="muted empty-box">None identified in captured captions.</p>`;

      // --- SECTION 7: METADATA & COVERAGE ---
      const activeCount = participants.filter(p => !p.status || !p.status.startsWith('Left')).length;
      const aiModelName = aiInsight && aiInsight.model ? aiInsight.model : (aiInsight ? 'NVIDIA NIM' : 'Local Heuristic Analysis');

      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MEETRIX Meeting Summary &amp; Attendance Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background-color: #f1f5f9;
    color: #1e293b;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14.5px;
    line-height: 1.6;
  }
  .wrap {
    max-width: 1040px;
    margin: 32px auto;
    padding: 0 20px 48px;
  }
  
  /* Section 1: Header Card (matches visual reference) */
  .hero-header {
    position: relative;
    background-color: #0c1728;
    color: #ffffff;
    border-radius: 16px;
    padding: 32px 36px;
    margin-bottom: 20px;
    box-shadow: 0 10px 25px -5px rgba(12, 23, 40, 0.28);
  }
  .hero-brand-lockup {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
  }
  .hero-brand-logo {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    object-fit: cover;
    box-shadow: 0 0 16px rgba(234, 179, 8, 0.45);
    flex-shrink: 0;
  }
  .hero-brand {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #ffffff;
    margin: 0;
    display: flex;
    align-items: center;
    line-height: 1.1;
  }
  .hero-ai-badge {
    background: #facc15;
    color: #09090b;
    font-size: 13.5px;
    font-weight: 800;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    border-radius: 4px;
    margin-left: 6px;
    vertical-align: middle;
  }
  .hero-subtitle {
    font-size: 14.5px;
    color: #94a3b8;
    font-weight: 500;
    margin: 4px 0 0 0;
  }
  .hero-meta {
    font-size: 13.5px;
    color: #cbd5e1;
    line-height: 1.75;
    margin-top: 10px;
  }
  .hero-meta div {
    margin-bottom: 2px;
  }
  .print-btn {
    position: absolute;
    top: 32px;
    right: 36px;
    background-color: #2dd4bf;
    color: #042f2e;
    border: none;
    border-radius: 8px;
    padding: 9px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
    transition: background-color 0.15s ease;
  }
  .print-btn:hover {
    background-color: #14b8a6;
  }

  /* Overview Cards Grid */
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
    margin-bottom: 24px;
  }
  .overview-card {
    background-color: #ffffff;
    border-radius: 14px;
    padding: 24px 22px;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.03);
  }
  .overview-metric {
    font-size: 32px;
    font-weight: 800;
    color: #0d9488;
    line-height: 1.1;
    margin-bottom: 6px;
  }
  .overview-label {
    font-size: 14px;
    color: #475569;
    font-weight: 500;
  }

  /* Section Containers */
  .report-section {
    background-color: #ffffff;
    border-radius: 14px;
    padding: 28px;
    margin-bottom: 22px;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.03);
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #edf2f7;
  }
  .section-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: #0f172a;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .section-subtitle {
    font-size: 14px;
    color: #64748b;
    font-weight: 400;
  }
  .section-desc {
    font-size: 13.5px;
    color: #64748b;
    margin: -6px 0 16px 0;
  }
  .section-note {
    font-size: 12.5px;
    color: #64748b;
    margin-top: 14px;
  }

  /* Attendance Table */
  .table-responsive {
    overflow-x: auto;
    width: 100%;
  }
  table.attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    text-align: left;
  }
  table.attendance-table th {
    background-color: #f8fafc;
    color: #475569;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 12px 14px;
    border-bottom: 2px solid #e2e8f0;
    white-space: nowrap;
  }
  table.attendance-table td {
    padding: 12px 14px;
    border-bottom: 1px solid #f1f5f9;
    color: #1e293b;
    vertical-align: middle;
  }
  table.attendance-table tbody tr:hover {
    background-color: #f8fafc;
  }
  .table-empty {
    text-align: center;
    color: #64748b;
    padding: 24px !important;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
  }
  .badge-cam-on { background-color: #dcfce7; color: #15803d; }
  .badge-cam-off { background-color: #f1f5f9; color: #64748b; }
  .badge-cam-unknown { background-color: #fef9c3; color: #854d0e; }
  .badge-stat-present { background-color: #dcfce7; color: #15803d; }
  .badge-stat-presenting { background-color: #fef08a; color: #854d0e; }
  .badge-stat-left { background-color: #f1f5f9; color: #64748b; }
  .badge-device { background-color: #f1f5f9; color: #334155; }

  .badge-tag {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    background-color: #e2e8f0;
    color: #475569;
    letter-spacing: 0.02em;
  }
  .badge-tag-ai {
    background-color: #fef08a;
    color: #854d0e;
  }

  /* Section 3: Transcription */
  .transcript-list {
    background-color: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 16px 20px;
    max-height: 520px;
    overflow-y: auto;
  }
  .transcript-line {
    padding: 8px 0;
    border-bottom: 1px solid #f1f5f9;
    font-size: 14px;
    line-height: 1.6;
    color: #1e293b;
  }
  .transcript-line:last-child {
    border-bottom: none;
  }
  .transcript-time {
    font-size: 12px;
    color: #64748b;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background-color: #e2e8f0;
    padding: 2px 6px;
    border-radius: 4px;
    margin-right: 8px;
    display: inline-block;
  }
  .transcript-speaker {
    color: #0f172a;
    font-weight: 700;
  }
  .transcript-sep {
    color: #64748b;
    margin-right: 6px;
  }
  .transcript-text {
    color: #334155;
  }

  /* Section 4 & 5: Summary & Key Points */
  .summary-box {
    background-color: #f8fafc;
    border-left: 4px solid #0d9488;
    padding: 18px 22px;
    border-radius: 0 10px 10px 0;
    font-size: 14.5px;
    line-height: 1.7;
    color: #1e293b;
  }
  .summary-box p {
    margin: 0;
  }
  .bullet-list {
    margin: 8px 0;
    padding-left: 22px;
  }
  .bullet-list li {
    margin-bottom: 8px;
    line-height: 1.6;
    color: #334155;
  }
  .bullet-list li:last-child {
    margin-bottom: 0;
  }

  /* Section 6: Decisions & Action Items */
  .sub-block {
    margin-bottom: 22px;
  }
  .sub-block:last-child {
    margin-bottom: 0;
  }
  .sub-block h3 {
    margin: 0 0 10px 0;
    font-size: 15px;
    font-weight: 700;
    color: #0f172a;
    border-left: 3px solid #0d9488;
    padding-left: 10px;
  }
  .action-list {
    list-style: none;
    padding: 0;
    margin: 8px 0;
  }
  .action-list li {
    padding: 11px 14px;
    background-color: #f8fafc;
    border-radius: 8px;
    margin-bottom: 8px;
    border: 1px solid #e2e8f0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .action-list li:last-child {
    margin-bottom: 0;
  }
  .action-text {
    color: #1e293b;
    flex: 1 1 auto;
  }
  .meta-pill {
    font-size: 11.5px;
    background-color: #e2e8f0;
    color: #475569;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
  }

  /* Section 7: Additional Meeting Details Grid */
  .details-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
    gap: 18px;
  }
  .detail-panel {
    background-color: #f8fafc;
    border-radius: 10px;
    padding: 18px 20px;
    border: 1px solid #e2e8f0;
  }
  .detail-panel h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
  }
  .detail-row {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    padding: 6px 0;
    border-bottom: 1px solid #edf2f7;
    color: #334155;
  }
  .detail-row:last-child {
    border-bottom: none;
  }
  .detail-label {
    color: #64748b;
    font-weight: 500;
  }
  .notice-text {
    font-size: 13px;
    color: #64748b;
    line-height: 1.6;
    margin-bottom: 10px;
  }
  .notice-text:last-child {
    margin-bottom: 0;
  }

  /* Empty state */
  .muted {
    color: #64748b;
  }
  .empty-box {
    margin: 0;
    padding: 14px;
    background-color: #f8fafc;
    border-radius: 8px;
    border: 1px dashed #cbd5e1;
    font-style: italic;
    font-size: 13.5px;
  }

  /* Footer */
  .report-footer {
    text-align: center;
    font-size: 12.5px;
    color: #94a3b8;
    margin-top: 32px;
    padding-top: 16px;
    border-top: 1px solid #e2e8f0;
  }

  /* Responsive Layout */
  @media (max-width: 768px) {
    .wrap { padding: 14px; margin: 12px auto; }
    .hero-header { padding: 22px; }
    .print-btn { position: static; margin-top: 16px; display: inline-block; }
    .overview-grid { grid-template-columns: 1fr; gap: 12px; }
    .report-section { padding: 18px; }
    .details-grid { grid-template-columns: 1fr; }
  }

  /* Print Stylesheet */
  @media print {
    body {
      background-color: #ffffff !important;
      color: #000000 !important;
    }
    .wrap {
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .print-btn {
      display: none !important;
    }
    .hero-header {
      background-color: #0c1728 !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      box-shadow: none !important;
      break-inside: avoid;
    }
    .hero-brand-logo {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      box-shadow: none !important;
    }
    .hero-ai-badge {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .overview-grid {
      break-inside: avoid;
    }
    .overview-card, .report-section {
      box-shadow: none !important;
      border: 1px solid #cbd5e1 !important;
    }
    .transcript-list {
      max-height: none !important;
      overflow: visible !important;
      background-color: transparent !important;
      border: none !important;
      padding: 0 !important;
    }
    .report-section.transcript-section {
      break-inside: auto !important;
    }
    .transcript-line {
      break-inside: avoid;
    }
    table.attendance-table tr {
      break-inside: avoid;
    }
    .detail-panel {
      break-inside: avoid;
    }
  }
</style>
</head>
<body>
<div class="wrap">

  <!-- Section 1: Meeting Header and Overview -->
  <header class="hero-header">
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    <div class="hero-brand-lockup">
      ${(resolveBranding() && resolveBranding().logoDataUri) ? `<img src="${resolveBranding().logoDataUri}" class="hero-brand-logo" alt="MEETRIX AI Logo" />` : ''}
      <div>
        <div class="hero-brand">MEETRIX <span class="hero-ai-badge">AI</span></div>
        <div class="hero-subtitle">Meeting Summary &amp; Attendance Report</div>
      </div>
    </div>
    <div class="hero-meta">
      <div>Meeting: ${e(meetingTitleOrId)}</div>
      <div>Date and time: ${e(meetingDateTime)}</div>
      <div>Report generated: ${e(reportGenTime)} · Saved report is self-contained and works offline</div>
    </div>
  </header>

  <div class="overview-grid">
    <div class="overview-card">
      <div class="overview-metric">${participants.length}</div>
      <div class="overview-label">Recorded participants</div>
    </div>
    <div class="overview-card">
      <div class="overview-metric">${transcript.length}</div>
      <div class="overview-label">Captured caption lines</div>
    </div>
    <div class="overview-card">
      <div class="overview-metric">${e(durationText)}</div>
      <div class="overview-label">Meeting duration</div>
    </div>
  </div>

  <!-- Section 2: Attendance -->
  <section class="report-section">
    <div class="section-header">
      <h2>Attendance</h2>
    </div>
    <div class="table-responsive">
      <table class="attendance-table">
        <thead>
          <tr>
            <th>Participant Name</th>
            <th>Join Time</th>
            <th>Leave Time</th>
            <th>Duration</th>
            <th>Camera Status</th>
            <th>Device Type</th>
            <th>Attendance Status</th>
          </tr>
        </thead>
        <tbody>
          ${attendanceRows}
        </tbody>
      </table>
    </div>
    <p class="section-note">Camera status and device classification reflect observed Google Meet DOM states during active tracking.</p>
  </section>

  <!-- Section 3: Complete Captured Transcription -->
  <section class="report-section transcript-section">
    <div class="section-header">
      <h2>Complete Captured Transcription ${corrected ? '<span class="badge-tag badge-tag-ai">AI-reviewed Captions</span>' : '<span class="badge-tag">Complete Captured Transcript</span>'}</h2>
    </div>
    <p class="section-desc">${corrected ? 'NVIDIA NIM suggested caption corrections. Original speaker attribution, timestamps, line order, and transcript content were preserved.' : (transcript.length ? 'Chronological record of all captions captured during the meeting.' : 'No captions were captured during this meeting.')}</p>
    <div class="transcript-list">
      ${transcriptRows}
    </div>
  </section>

  <!-- Section 4: Summary -->
  <section class="report-section">
    <div class="section-header">
      <h2>Summary <span class="section-subtitle">— Executive Summary</span></h2>
    </div>
    ${summaryBody}
  </section>

  <!-- Section 5: Key Points -->
  <section class="report-section">
    <div class="section-header">
      <h2>Key Points</h2>
    </div>
    ${keyPointsBody}
  </section>

  <!-- Section 6: Decisions and Action Items -->
  <section class="report-section">
    <div class="section-header">
      <h2>Decisions and Action Items</h2>
    </div>
    <div class="sub-block">
      <h3>Decisions</h3>
      ${decisionsBody}
    </div>
    <div class="sub-block">
      <h3>Action Items</h3>
      ${actionsBody}
    </div>
    <div class="sub-block">
      <h3>Unresolved Questions &amp; Follow-ups</h3>
      ${questionsBody}
    </div>
  </section>

  <!-- Section 7: Additional Meeting Details -->
  <section class="report-section">
    <div class="section-header">
      <h2>Additional Meeting Details</h2>
    </div>
    <div class="details-grid">
      <div class="detail-panel">
        <h4>Session Metadata</h4>
        <div class="detail-row"><span class="detail-label">Meeting Identifier:</span> <span>${e(meetingTitleOrId)}</span></div>
        <div class="detail-row"><span class="detail-label">Session Started:</span> <span>${e(meetingDetails.startTime ? new Date(meetingDetails.startTime).toLocaleString() : 'Not recorded')}</span></div>
        <div class="detail-row"><span class="detail-label">Report Exported:</span> <span>${e(reportGenTime)}</span></div>
        <div class="detail-row"><span class="detail-label">Observed Attendees:</span> <span>${participants.length}</span></div>
        <div class="detail-row"><span class="detail-label">Active at Export:</span> <span>${activeCount}</span></div>
        <div class="detail-row"><span class="detail-label">Caption Lines:</span> <span>${transcript.length}</span></div>
        <div class="detail-row"><span class="detail-label">AI Engine:</span> <span>${e(aiModelName)}</span></div>
      </div>
      <div class="detail-panel">
        <h4>Data Quality &amp; Coverage Notices</h4>
        <p class="notice-text"><strong>Transcription Source:</strong> Google Meet Live Captions via DOM observation. Caption capture is restricted to active captions displayed during tracking.</p>
        <p class="notice-text"><strong>Device Detection:</strong> Aspect ratio and video tile heuristics (e.g. portrait orientation indicates Mobile). Browser resizing or multi-monitor setups may influence aspect ratios.</p>
        <p class="notice-text"><strong>Summarization:</strong> Executive summary and key points are strictly grounded in captured speech text without hallucination.</p>
        <p class="notice-text"><strong>Offline Storage:</strong> Saved report is self-contained and works offline. Zero external scripts, fonts, or network requests are required.</p>
      </div>
    </div>
  </section>

  <footer class="report-footer">
    <p>Generated by MEETRIX AI · Self-contained offline meeting report · All captured data stored locally</p>
  </footer>

</div>
</body>
</html>`;
    }

    generateHtmlFilename(timestamp = Date.now()) {
      const d = new Date(timestamp), p = n => String(n).padStart(2, '0');
      return `MEETRIX_Meeting_Report_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.html`;
    }
    /**
     * Formats timestamp into local readable format: YYYY-MM-DD HH:mm:ss
     * @param {number|null} timestamp 
     * @returns {string}
     */
    formatLocalTime(timestamp) {
      if (!timestamp || typeof timestamp !== 'number') return 'N/A';
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return 'N/A';

      const pad = (n) => String(n).padStart(2, '0');
      const year = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      const hours = pad(d.getHours());
      const mins = pad(d.getMinutes());
      const secs = pad(d.getSeconds());

      return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
    }

    /**
     * Generates filename: meetrix-attendance-YYYY-MM-DD.csv
     * @returns {string}
     */
    generateFilename() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const year = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      return `meetrix-attendance-${year}-${month}-${day}.csv`;
    }

    /**
     * Safely escapes field content for CSV standards (RFC 4180).
     * @param {string|number|null|undefined} value 
     * @returns {string}
     */
    escapeCsvField(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      // If contains comma, double quote, newline, or carriage return: enclose in quotes and escape quotes
      if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return `"${str}"`;
    }

    /**
     * Generates CSV string from participant records.
     * @param {Array<Object>} participants 
     * @returns {string}
     */
    buildCsvContent(participants = []) {
      const headers = [
        'Participant Name',
        'Participant Identifier',
        'First Observed',
        'Estimated Join Time',
        'Estimated Leave Time',
        'Observed Duration Seconds',
        'Camera Status',
        'Device Type',
        'Presenting',
        'Identity Confidence'
      ];

      const rows = [headers.map(h => this.escapeCsvField(h)).join(',')];

      // Sort participants: currently presenting first, then by name
      const sorted = [...participants].sort((a, b) => {
        if (a.presenting && !b.presenting) return -1;
        if (!a.presenting && b.presenting) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });

      for (const p of sorted) {
        const leaveTimeStr = (p.status && p.status.startsWith('Left') && (p.lastLeaveAt || p.estimatedLeaveTime))
          ? this.formatLocalTime(p.lastLeaveAt || p.estimatedLeaveTime)
          : 'Still Present';

        const row = [
          this.escapeCsvField(p.displayName || p.name || 'Name unavailable'),
          this.escapeCsvField(p.participantId || p.id || 'N/A'),
          this.escapeCsvField(this.formatLocalTime(p.firstJoinAt || p.firstObserved)),
          this.escapeCsvField(this.formatLocalTime(p.lastJoinAt || p.estimatedJoinTime || p.firstJoinAt)),
          this.escapeCsvField(leaveTimeStr),
          this.escapeCsvField(p.totalObservedDuration || p.observedDurationSeconds || 0),
          this.escapeCsvField(p.cameraStatus || 'Unknown'),
          this.escapeCsvField(p.deviceType || 'Unknown'),
          this.escapeCsvField(p.presenting ? 'Yes' : 'No'),
          this.escapeCsvField(p.dataConfidence || p.identityConfidence || 'Medium')
        ];
        rows.push(row.join(','));
      }

      // Prepend UTF-8 BOM (\uFEFF) to guarantee Excel / spreadsheet Unicode rendering
      return '\uFEFF' + rows.join('\r\n');
    }

    /**
     * Generates report filename: MEETRIX_Meeting_Report_YYYY-MM-DD.txt
     * @param {string} [ext='txt']
     * @returns {string}
     */
    generateReportFilename(ext = 'txt') {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const year = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      return `MEETRIX_Meeting_Report_${year}-${month}-${day}.${ext}`;
    }

    /**
     * Builds comprehensive UTF-8 text meeting report containing:
     * 1. Meeting Details
     * 2. Attendance & Participant Data (with camera and device info)
     * 3. Minutes of Meeting (MOM with decisions and action items)
     * 4. Full Finalized Transcript
     * 5. Provider & Limitation Information
     *
     * @param {Object} options
     * @param {Object} [options.meetingDetails]
     * @param {Array<Object>} [options.participants]
     * @param {Array<Object>|string} [options.transcript]
     * @param {string} [options.momText]
     * @param {Object} [options.providerInfo]
     * @returns {string}
     */
    buildCompleteReportText(options = {}) {
      const {
        meetingDetails = {},
        participants = [],
        transcript = [],
        momText = '',
        providerInfo = {}
      } = options;

      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const exportTimeStr = this.formatLocalTime(now.getTime());

      const lines = [];

      lines.push('================================================================================');
      lines.push('                         MEETRIX - MEETING REPORT');
      lines.push('================================================================================');
      lines.push('');

      // --- SECTION 1: MEETING DETAILS ---
      lines.push('--- 1. MEETING DETAILS ---');
      lines.push(`Meeting ID       : ${meetingDetails.meetingId || meetingDetails.id || 'N/A'}`);
      lines.push(`Date             : ${meetingDetails.date || todayStr}`);
      lines.push(`Session Started  : ${meetingDetails.startTime ? this.formatLocalTime(meetingDetails.startTime) : 'N/A'}`);
      lines.push(`Report Exported  : ${exportTimeStr}`);
      lines.push(`Total Observed   : ${participants.length} attendee(s)`);
      const activeCount = participants.filter(p => !p.status || !p.status.startsWith('Left')).length;
      lines.push(`Active at Export : ${activeCount} attendee(s)`);
      lines.push('');

      // --- SECTION 2: ATTENDANCE SUMMARY ---
      lines.push('--- 2. ATTENDANCE & PARTICIPANT SUMMARY ---');
      if (participants.length === 0) {
        lines.push('No participant attendance records observed.');
      } else {
        const sorted = [...participants].sort((a, b) => {
          if (a.presenting && !b.presenting) return -1;
          if (!a.presenting && b.presenting) return 1;
          return (a.name || '').localeCompare(b.name || '');
        });

        // Format duration helper
        const fmtDur = (s) => {
          if (!s || s <= 0) return '0s';
          const mins = Math.floor(s / 60);
          const rem = Math.round(s % 60);
          return mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
        };

        // Table header
        const colName = 24;
        const colJoin = 20;
        const colLeave = 20;
        const colDur = 12;
        const colCam = 12;
        const colDev = 12;
        const colStat = 10;

        const padEnd = (str, len) => {
          const s = String(str || '');
          return s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len, ' ');
        };

        const headerLine = [
          padEnd('Participant Name', colName),
          padEnd('Estimated Join', colJoin),
          padEnd('Estimated Leave', colLeave),
          padEnd('Duration', colDur),
          padEnd('Camera', colCam),
          padEnd('Device', colDev),
          padEnd('Status', colStat)
        ].join(' ');

        lines.push(headerLine);
        lines.push('-'.repeat(headerLine.length));

        for (const p of sorted) {
          const name = p.displayName || p.name || 'Participant';
          const joinTime = this.formatLocalTime(p.lastJoinAt || p.estimatedJoinTime || p.firstJoinAt);
          const isLeft = p.status && p.status.startsWith('Left');
          const leaveTime = isLeft
            ? this.formatLocalTime(p.lastLeaveAt || p.estimatedLeaveTime)
            : 'Still Present';
          const durStr = fmtDur(p.totalObservedDuration || p.observedDurationSeconds || 0);
          const cam = p.cameraStatus || 'Unknown';
          const dev = p.deviceType || 'Unknown';
          const stat = p.presenting ? 'Presenting' : isLeft ? 'Left' : 'Present';

          const rowStr = [
            padEnd(name, colName),
            padEnd(joinTime, colJoin),
            padEnd(leaveTime, colLeave),
            padEnd(durStr, colDur),
            padEnd(cam, colCam),
            padEnd(dev, colDev),
            padEnd(stat, colStat)
          ].join(' ');

          lines.push(rowStr);
        }
      }
      lines.push('');

      // --- SECTION 3: MINUTES OF MEETING (MOM) ---
      lines.push('--- 3. MINUTES OF MEETING (MOM) ---');
      if (momText && momText.trim().length > 0) {
        lines.push(momText.trim());
      } else {
        lines.push('Minutes of Meeting (MOM) was not generated for this session.');
        lines.push('(Use "Generate MOM" in the Meetrix popup with an NVIDIA NIM API key to generate an automated executive summary).');
      }
      lines.push('');

      // --- SECTION 4: FULL FINALIZED TRANSCRIPT ---
      lines.push('--- 4. FULL FINALIZED TRANSCRIPT ---');
      let transcriptText = '';
      if (typeof transcript === 'string') {
        transcriptText = transcript.trim();
      } else if (Array.isArray(transcript)) {
        if (transcript.length === 0) {
          transcriptText = 'No transcript captured for this meeting session.';
        } else {
          transcriptText = transcript.map(l => {
            const timeStr = l.timestamp ? this.formatLocalTime(l.timestamp).split(' ')[1] : '--:--:--';
            const speakerStr = l.speaker ? l.speaker : 'Unknown';
            return `[${timeStr}] ${speakerStr}: ${l.text}`;
          }).join('\n');
        }
      }

      lines.push(transcriptText || 'No transcript available.');
      lines.push('');

      // --- SECTION 5: PROVIDER & SYSTEM INFORMATION ---
      lines.push('--- 5. PROVIDER & SYSTEM INFORMATION ---');
      lines.push(`Transcription Source : Google Meet Live Captions (DOM-level observation)`);
      lines.push(`MOM AI Engine        : ${providerInfo.model || 'NVIDIA NIM (nvidia/nemotron-3.5-lightning-30b-a3b)'}`);
      lines.push(`Language Support     : Multilingual (English, Hindi, Hinglish, UTF-8 Unicode)`);
      lines.push(`Report Encoding      : UTF-8 with Byte Order Mark (BOM)`);
      lines.push(`Device Inference     : Stream resolution & video tile aspect ratio heuristics`);
      lines.push('Accuracy Limitations :');
      lines.push('  - Transcription relies on Google Meet closed caption accuracy and microphone clarity.');
      lines.push('  - Remote participant device types represent screen shape heuristics (ratio < 0.80 indicates Mobile);');
      lines.push('    window tiling or external monitor setups may influence aspect ratio.');
      lines.push('  - MOM is synthesized from finalized transcript text using strict non-hallucination constraints.');
      lines.push('================================================================================');

      // Prepend UTF-8 BOM (\uFEFF) for universal multi-device rendering
      return '\uFEFF' + lines.join('\r\n');
    }

    /**
     * Downloads comprehensive UTF-8 text report.
     * @param {Object} reportData
     * @param {string} [customFilename]
     * @returns {Promise<boolean>}
     */
    async downloadCompleteReport(reportData = {}, customFilename) {
      const textContent = this.buildCompleteReportText(reportData);
      const filename = customFilename || this.generateReportFilename('txt');

      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
        try {
          await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
          });
          return true;
        } catch (downloadErr) {
          console.warn('[Meetrix] chrome.downloads.download failed, falling back to anchor trigger:', downloadErr);
        }
      }

      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 5000);

      return true;
    }

    /**
     * Downloads CSV attendance report.
     * @param {Array<Object>} participants 
     * @param {string} [customFilename] 
     * @returns {Promise<boolean>}
     */
    async downloadReport(participants = [], customFilename) {
      if (!participants || participants.length === 0) {
        throw new Error('No participant data available to export.');
      }

      const csvContent = this.buildCsvContent(participants);
      const filename = customFilename || this.generateFilename();

      // Convert to Blob data URL
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      // Attempt Chrome Downloads API
      if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
        try {
          await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
          });
          return true;
        } catch (downloadErr) {
          console.warn('[Meetrix] chrome.downloads.download failed, falling back to anchor trigger:', downloadErr);
        }
      }

      // Anchor element fallback
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 5000);

      return true;
    }
  }

  const generator = new MeetrixReportGenerator();
  root.MeetrixReportGenerator = generator;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = generator;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
