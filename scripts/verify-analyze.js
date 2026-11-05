// Test script for Edge Function `analyze` - Honest Analytics
import { computeDailyMetrics, handleAnalyzeRequest } from '../supabase/functions/analyze/index.ts';

async function testAnalyzeFunction() {
  console.log('--- Verifying Edge Function `analyze` Honest Analytics ---');

  const deviceId = '12345678-1234-1234-1234-1234567890ab';
  const targetDate = '2026-10-22';

  // --- Test 1: Insufficient data (< 15 min) -> status='insufficient_data' ---
  // Only 5 minutes of readings (30 readings, 10s each)
  const shortReadings = [];
  const baseTime = new Date('2026-10-22T09:00:00Z').getTime();
  for (let i = 0; i < 30; i++) {
    shortReadings.push({
      ts: new Date(baseTime + i * 10000).toISOString(),
      angle: 8.0,
      state: 'good',
      movement: 0.2,
    });
  }

  const shortMetrics = computeDailyMetrics(deviceId, targetDate, shortReadings, []);
  if (shortMetrics.status !== 'insufficient_data') {
    throw new Error(`Test 1 Failed: Expected status insufficient_data, got ${shortMetrics.status}`);
  }
  if (shortMetrics.posture_score !== null || shortMetrics.pfi !== null) {
    throw new Error('Test 1 Failed: score and PFI must be null when data < 15 min');
  }
  if (!shortMetrics.pfi_reason.includes('15 min of readings')) {
    throw new Error(`Test 1 Failed: Expected 15 min reason, got: ${shortMetrics.pfi_reason}`);
  }
  console.log('✓ Test 1: Under 15 minutes of data stores status="insufficient_data" and null score/PFI');

  // --- Test 2: Gaps > 60s counted as "no data" and not posture time ---
  // 1 reading at 09:00:00, then next reading at 09:10:00 (10 min gap)
  const gapReadings = [
    { ts: '2026-10-22T09:00:00Z', angle: 8.0, state: 'good', movement: 0.2 },
    { ts: '2026-10-22T09:10:00Z', angle: 8.0, state: 'good', movement: 0.2 },
  ];
  const gapMetrics = computeDailyMetrics(deviceId, targetDate, gapReadings, []);
  if (gapMetrics.gap_min < 9) {
    throw new Error(`Test 2 Failed: Gap should be at least 9 minutes, got ${gapMetrics.gap_min}`);
  }
  console.log(`✓ Test 2: 10-minute gap correctly tracked as ${gapMetrics.gap_min}m no-data gap`);

  // --- Test 3: Sufficient data (>= 15 min) computes score and provides evidence on recommendations ---
  // 120 readings = 20 minutes (16 min good, 2 min warn, 2 min bad)
  const fullReadings = [];
  for (let i = 0; i < 96; i++) {
    fullReadings.push({
      ts: new Date(baseTime + i * 10000).toISOString(),
      angle: 7.5,
      state: 'good',
      movement: 0.2,
    });
  }
  for (let i = 96; i < 108; i++) {
    fullReadings.push({
      ts: new Date(baseTime + i * 10000).toISOString(),
      angle: 18.0,
      state: 'warning',
      movement: 0.1,
    });
  }
  for (let i = 108; i < 120; i++) {
    fullReadings.push({
      ts: new Date(baseTime + i * 10000).toISOString(),
      angle: 28.0,
      state: 'bad',
      movement: 0.02,
    });
  }

  const fullAlerts = [
    { ts: '2026-10-22T09:18:00Z', level: 'vibration', duration_s: 10, reason: 'forward_lean', recovery_time_s: 15 },
  ];

  const fullMetrics = computeDailyMetrics(deviceId, targetDate, fullReadings, fullAlerts);
  if (fullMetrics.status !== 'completed' || fullMetrics.posture_score === null) {
    throw new Error('Test 3 Failed: Expected completed status and numeric score');
  }
  if (fullMetrics.recommendations.length > 0) {
    for (const rec of fullMetrics.recommendations) {
      if (!rec.evidence) {
        throw new Error(`Test 3 Failed: Recommendation missing evidence: ${JSON.stringify(rec)}`);
      }
    }
    console.log(`✓ Test 3: Rule recommendation has verified evidence: "${fullMetrics.recommendations[0].evidence}"`);
  }
  console.log(`✓ Test 3: 20-minute session computed Posture Score ${fullMetrics.posture_score}/100 and PFI ${fullMetrics.pfi}`);

  console.log('--- Edge Function `analyze` Honest Analytics Verified ---');
}

testAnalyzeFunction().catch((err) => {
  console.error('Analyze verification error:', err);
  process.exit(1);
});
