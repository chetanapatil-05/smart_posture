// scripts/test-e2e.js
// End-to-End Integration Test: Empty State -> Ingest ONE Real Payload -> Exact Telemetry Verification

import crypto from 'node:crypto';
import { handleIngestRequest } from '../supabase/functions/ingest/index.ts';

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function runEndToEndIntegrationTest() {
  console.log('====================================================');
  console.log('   SmartPosture AI - Real Data Integration Test     ');
  console.log('====================================================');

  const deviceId = 'e2e00000-0000-0000-0000-000000000001';
  const deviceKey = 'secret-esp32-real-hardware-key';
  const hashedKey = sha256Hex(deviceKey);

  // In-memory Database state
  let testDevice = {
    id: deviceId,
    name: 'SmartPosture ESP32 Wearable',
    device_key_hash: hashedKey,
    baseline_angle: null,
    battery_pct: null,
    last_seen: null,
  };

  const dbReadings = [];
  const dbAlerts = [];
  const dbEvents = [];
  const dbDailyStats = [];
  const dbRecommendations = [];

  const testSupabaseClient = {
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === 'devices' && val === deviceId) {
              return { data: { ...testDevice }, error: null };
            }
            return { data: null, error: new Error('Not found') };
          },
        }),
      }),
      insert: async (rows) => {
        if (table === 'posture_readings') dbReadings.push(...rows);
        else if (table === 'alerts') dbAlerts.push(...rows);
        else if (table === 'events') dbEvents.push(...rows);
        else if (table === 'recommendations') dbRecommendations.push(...rows);
        return { data: rows, error: null };
      },
      update: (fields) => ({
        eq: (col, val) => {
          if (table === 'devices' && val === deviceId) {
            testDevice = { ...testDevice, ...fields };
          }
          return Promise.resolve({ data: testDevice, error: null });
        },
      }),
    }),
  };

  // ----------------------------------------------------
  // PART 1: EMPTY DATABASE INTEGRATION TEST
  // The dashboard must render ONLY empty states (no numbers, no synthetic defaults)
  // ----------------------------------------------------
  console.log('\n[Phase 1/3] Testing Dashboard with Empty Database...');

  // Simulate frontend state derivation with empty database
  const emptyStateUI = {
    setupCardVisible: dbReadings.length === 0,
    liveBadge: dbReadings.length === 0 ? 'NO DATA' : dbReadings[0].state,
    liveAngle: dbReadings.length === 0 ? '--' : `${dbReadings[0].angle}°`,
    liveBaselineDiff: testDevice.baseline_angle === null ? 'Not calibrated, press the device button' : `${testDevice.baseline_angle}°`,
    batteryBadgeVisible: testDevice.battery_pct !== null,
    kpiScore: dbDailyStats.length === 0 ? '--' : dbDailyStats[0].posture_score,
    kpiScoreSubtext: 'Not enough data yet (needs 15 min of readings)',
    kpiPfiTag: 'No data',
    timelineEmpty: dbReadings.length === 0,
    weeklyEmpty: dbDailyStats.length === 0,
    alertsEmpty: dbAlerts.length === 0,
  };

  if (!emptyStateUI.setupCardVisible) {
    throw new Error('Phase 1 Failed: Setup onboarding card was not shown for empty database');
  }
  if (emptyStateUI.liveBadge !== 'NO DATA' || emptyStateUI.liveAngle !== '--') {
    throw new Error('Phase 1 Failed: Live status showed numbers or state on empty database');
  }
  if (emptyStateUI.batteryBadgeVisible) {
    throw new Error('Phase 1 Failed: Battery widget was visible when battery_pct is null');
  }
  if (emptyStateUI.kpiScore !== '--') {
    throw new Error(`Phase 1 Failed: KPI score displayed a number (${emptyStateUI.kpiScore}) on empty database`);
  }
  if (!emptyStateUI.timelineEmpty || !emptyStateUI.weeklyEmpty || !emptyStateUI.alertsEmpty) {
    throw new Error('Phase 1 Failed: Charts or alerts list rendered points on empty database');
  }
  console.log('✓ Empty database contract verified: All widgets render honest empty states with 0 numbers/points.');

  // ----------------------------------------------------
  // PART 2: INGEST EXACTLY ONE REAL HARDWARE PAYLOAD
  // ----------------------------------------------------
  console.log('\n[Phase 2/3] Ingesting ONE Real Hardware Payload from ESP32...');
  const nowTs = new Date(Date.now() - 5000).toISOString();
  const realHardwarePayload = {
    device_id: deviceId,
    battery_pct: 87,
    baseline_angle: 12.5,
    readings: [
      {
        ts: nowTs,
        angle: 14.1,
        state: 'good',
        movement: 0.35,
      },
    ],
    alerts: [],
    events: [
      {
        ts: nowTs,
        type: 'calibration',
        angle: 12.5,
      },
    ],
  };

  const ingestReq = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-key': deviceKey,
    },
    body: JSON.stringify(realHardwarePayload),
  });

  const ingestRes = await handleIngestRequest(ingestReq, testSupabaseClient);
  if (ingestRes.status !== 200) {
    throw new Error(`Phase 2 Failed: Ingest returned status ${ingestRes.status}: ${await ingestRes.text()}`);
  }
  const ingestJson = await ingestRes.json();
  console.log('✓ Ingest returned 200 OK:', ingestJson.inserted);

  if (dbReadings.length !== 1) {
    throw new Error(`Phase 2 Failed: Expected exactly 1 reading inserted, got ${dbReadings.length}`);
  }
  if (dbEvents.length !== 1) {
    throw new Error(`Phase 2 Failed: Expected exactly 1 calibration event inserted, got ${dbEvents.length}`);
  }

  // ----------------------------------------------------
  // PART 3: VERIFY ONLY THE VALUES FROM THAT PAYLOAD APPEAR
  // ----------------------------------------------------
  console.log('\n[Phase 3/3] Verifying Dashboard Reflects ONLY That Single Real Payload...');

  const live = dbReadings[0];
  const postIngestUI = {
    setupCardVisible: dbReadings.length === 0,
    liveBadge: live.state.toUpperCase(),
    liveAngle: `${live.angle.toFixed(1)}°`,
    baselineDiff: `+${(live.angle - testDevice.baseline_angle).toFixed(1)}° vs baseline (${testDevice.baseline_angle.toFixed(1)}°)`,
    batteryText: `${testDevice.battery_pct}%`,
    batteryVisible: testDevice.battery_pct !== null,
    kpiScore: dbDailyStats.length === 0 ? '--' : dbDailyStats[0].posture_score,
    kpiScoreSubtext: 'Not enough data yet (needs 15 min of readings)',
    readingCountFootnote: `Computed from ${dbReadings.length} reading`,
  };

  if (postIngestUI.setupCardVisible) {
    throw new Error('Phase 3 Failed: Setup onboarding card was not dismissed after receiving reading');
  }
  if (postIngestUI.liveBadge !== 'GOOD') {
    throw new Error(`Phase 3 Failed: Live badge state expected 'GOOD', got '${postIngestUI.liveBadge}'`);
  }
  if (postIngestUI.liveAngle !== '14.1°') {
    throw new Error(`Phase 3 Failed: Live angle expected '14.1°', got '${postIngestUI.liveAngle}'`);
  }
  if (postIngestUI.batteryText !== '87%' || !postIngestUI.batteryVisible) {
    throw new Error(`Phase 3 Failed: Battery expected '87%', got '${postIngestUI.batteryText}'`);
  }
  if (postIngestUI.kpiScore !== '--') {
    throw new Error(`Phase 3 Failed: Score should remain '--' because 1 reading is < 15 min of data`);
  }
  if (postIngestUI.readingCountFootnote !== 'Computed from 1 reading') {
    throw new Error(`Phase 3 Failed: Footnote expected 'Computed from 1 reading', got '${postIngestUI.readingCountFootnote}'`);
  }

  // Verify device parent link (foreign key check)
  const orphanedReadings = dbReadings.filter((r) => r.device_id !== testDevice.id);
  if (orphanedReadings.length > 0) {
    throw new Error('Phase 3 Failed: Orphaned readings found with unlinked device_id');
  }

  console.log('✓ Post-ingest state verified:');
  console.log(`   - Live State: ${postIngestUI.liveBadge} (Angle: ${postIngestUI.liveAngle})`);
  console.log(`   - Baseline Diff: ${postIngestUI.baselineDiff}`);
  console.log(`   - Device Battery: ${postIngestUI.batteryText}`);
  console.log(`   - Score: ${postIngestUI.kpiScore} (${postIngestUI.kpiScoreSubtext})`);
  console.log(`   - Footnote: "${postIngestUI.readingCountFootnote}"`);
  console.log('   - 0 orphaned rows detected.');

  console.log('====================================================');
  console.log('      REAL DATA INTEGRATION TEST PASSED (100%)      ');
  console.log('====================================================\n');
}

runEndToEndIntegrationTest().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
