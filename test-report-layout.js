const assert = require('node:assert/strict');
const reports = require('./report-generator.js');

const mockReport = reports.buildHtmlReport({
  meetingDetails: {
    meetingId: 'znm-jeaj-htq',
    startTime: Date.now() - 360000,
    endTime: Date.now(),
    duration: '6 min'
  },
  participants: [
    { displayName: 'Vishal Maurya', firstJoinAt: Date.now() - 360000, cameraStatus: 'Camera ON', deviceType: 'Desktop/Laptop', status: 'Present' },
    { displayName: 'vxExplains', firstJoinAt: Date.now() - 300000, cameraStatus: 'Camera OFF', deviceType: 'Mobile', status: 'Present' }
  ],
  transcript: [
    { timestamp: Date.now() - 300000, speaker: 'Vishal Maurya', text: 'Welcome everyone to the meeting.' },
    { timestamp: Date.now() - 240000, speaker: 'vxExplains', text: 'We agreed to finalize the design today.' },
    { timestamp: Date.now() - 180000, speaker: 'Vishal Maurya', text: 'I will prepare the deployment checklist.' }
  ]
});

// Check exact vertical order of sections
const idxHero = mockReport.indexOf('hero-header');
const idxOverview = mockReport.indexOf('overview-grid');
const idxAttendance = mockReport.indexOf('<h2>Attendance</h2>');
const idxTranscript = mockReport.indexOf('Complete Captured Transcription');
const idxSummary = mockReport.indexOf('<h2>Summary');
const idxKeyPoints = mockReport.indexOf('<h2>Key Points</h2>');
const idxDecisions = mockReport.indexOf('<h2>Decisions and Action Items</h2>');
const idxDetails = mockReport.indexOf('<h2>Additional Meeting Details</h2>');

assert.ok(idxHero !== -1 && idxOverview !== -1, 'Section 1 (Header and Overview) present');
assert.ok(idxAttendance !== -1, 'Section 2 (Attendance) present');
assert.ok(idxTranscript !== -1, 'Section 3 (Complete Captured Transcription) present');
assert.ok(idxSummary !== -1, 'Section 4 (Summary) present');
assert.ok(idxKeyPoints !== -1, 'Section 5 (Key Points) present');
assert.ok(idxDecisions !== -1, 'Section 6 (Decisions and Action Items) present');
assert.ok(idxDetails !== -1, 'Section 7 (Additional Meeting Details) present');

assert.ok(idxHero < idxOverview, 'Hero before overview');
assert.ok(idxOverview < idxAttendance, 'Section 1 before Section 2');
assert.ok(idxAttendance < idxTranscript, 'Section 2 before Section 3');
assert.ok(idxTranscript < idxSummary, 'Section 3 before Section 4');
assert.ok(idxSummary < idxKeyPoints, 'Section 4 before Section 5');
assert.ok(idxKeyPoints < idxDecisions, 'Section 5 before Section 6');
assert.ok(idxDecisions < idxDetails, 'Section 6 before Section 7');

// Check overview card metrics
assert.ok(mockReport.includes('<div class="overview-metric">2</div>'), 'Overview has participant count 2');
assert.ok(mockReport.includes('<div class="overview-metric">3</div>'), 'Overview has caption count 3');
assert.ok(mockReport.includes('<div class="overview-metric">6 min</div>'), 'Overview has duration 6 min');

// Check attendance table columns
const columns = ['Participant Name', 'Join Time', 'Leave Time', 'Duration', 'Camera Status', 'Device Type', 'Attendance Status'];
columns.forEach(col => assert.ok(mockReport.includes(col), 'Table missing column: ' + col));

// Check print button and print style
assert.ok(mockReport.includes('Print / Save as PDF'));
assert.ok(mockReport.includes('@media print'));

// Check empty state handling
const emptyReport = reports.buildHtmlReport({
  meetingDetails: {},
  participants: [],
  transcript: []
});
assert.ok(emptyReport.includes('No captions were captured during this meeting.'));
assert.ok(emptyReport.includes('No attendance records observed during this session.'));
assert.ok(emptyReport.includes('A reliable summary could not be generated'));

console.log('✓ All layout, section order, metric, and table checks passed successfully!');
