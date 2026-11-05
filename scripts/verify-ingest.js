// Test script for Edge Function `ingest` - Real Data Strict Validation
import crypto from 'node:crypto';
import { handleIngestRequest } from '../supabase/functions/ingest/index.ts';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function testIngestFunction() {
  console.log('--- Verifying Edge Function `ingest` Strict Source of Truth ---');

  const testSecretKey = 'my-esp32-secret-key-123';
  const hashedKey = sha256Hex(testSecretKey);
  const deviceId = '12345678-1234-1234-1234-1234567890ab';

  let testDevice = {
    id: deviceId,
    device_key_hash: hashedKey,
    baseline_angle: null,
    battery_pct: null,
    last_seen: null,
  };

  const insertedData = {
    posture_readings: [],
    alerts: [],
    events: [],
  };

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
        if (!insertedData[table]) insertedData[table] = [];
        insertedData[table].push(...rows);
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

  const now = new Date().toISOString();

  // Test 1: Reject angle outside -90..90 -> 422
  const reqBadAngle = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      readings: [{ ts: now, angle: 95.5, state: 'bad', movement: 0.1 }],
    }),
  });
  const resBadAngle = await handleIngestRequest(reqBadAngle, testSupabaseClient);
  if (resBadAngle.status !== 422) {
    throw new Error(`Test 1 Failed: Expected status 422 for angle > 90, got ${resBadAngle.status}`);
  }
  console.log('✓ Test 1: Rejects angle outside [-90, 90] with 422');

  // Test 2: Reject timestamp > 5 min in future -> 422
  const futureTs = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const reqFutureTs = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      readings: [{ ts: futureTs, angle: 10.0, state: 'good', movement: 0.2 }],
    }),
  });
  const resFutureTs = await handleIngestRequest(reqFutureTs, testSupabaseClient);
  if (resFutureTs.status !== 422) {
    throw new Error(`Test 2 Failed: Expected status 422 for future ts, got ${resFutureTs.status}`);
  }
  console.log('✓ Test 2: Rejects timestamp > 5m in future with 422');

  // Test 3: Reject timestamp > 24 hours in past when buffered is false -> 422
  const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const reqOldTs = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      readings: [{ ts: oldTs, angle: 10.0, state: 'good', movement: 0.2 }],
    }),
  });
  const resOldTs = await handleIngestRequest(reqOldTs, testSupabaseClient);
  if (resOldTs.status !== 422) {
    throw new Error(`Test 3 Failed: Expected status 422 for >24h old ts without buffered flag, got ${resOldTs.status}`);
  }
  console.log('✓ Test 3: Rejects timestamp > 24h old without buffered: true with 422');

  // Test 4: Allow historical timestamp when buffered: true -> 200
  const reqBuffered = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      buffered: true,
      readings: [{ ts: oldTs, angle: 10.0, state: 'good', movement: 0.2 }],
    }),
  });
  const resBuffered = await handleIngestRequest(reqBuffered, testSupabaseClient);
  if (resBuffered.status !== 200) {
    throw new Error(`Test 4 Failed: Expected status 200 for buffered batch, got ${resBuffered.status}`);
  }
  console.log('✓ Test 4: Accepts historical timestamp when buffered: true');

  // Test 5: Reject unknown state -> 422
  const reqBadState = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      readings: [{ ts: now, angle: 10.0, state: 'slouching_unknown', movement: 0.2 }],
    }),
  });
  const resBadState = await handleIngestRequest(reqBadState, testSupabaseClient);
  if (resBadState.status !== 422) {
    throw new Error(`Test 5 Failed: Expected status 422 for unknown state, got ${resBadState.status}`);
  }
  console.log('✓ Test 5: Rejects unknown posture state with 422');

  // Test 6: Preserves original ts and populates received_at
  const validReading = insertedData.posture_readings[0];
  if (!validReading || !validReading.received_at || validReading.ts !== oldTs) {
    throw new Error('Test 6 Failed: Original ts overwritten or received_at missing');
  }
  console.log('✓ Test 6: Original device timestamp preserved and server received_at populated');

  // Test 7: Null battery_pct stored as null
  const reqNullBattery = new Request('http://localhost/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-key': testSecretKey },
    body: JSON.stringify({
      device_id: deviceId,
      battery_pct: null,
      readings: [{ ts: now, angle: 8.0, state: 'good', movement: 0.2 }],
    }),
  });
  await handleIngestRequest(reqNullBattery, testSupabaseClient);
  if (testDevice.battery_pct !== null) {
    throw new Error('Test 7 Failed: battery_pct was not set to null');
  }
  console.log('✓ Test 7: Null battery_pct stored as null in devices table');

  console.log('--- Edge Function `ingest` Strict Source of Truth Verified ---');
}

testIngestFunction().catch((err) => {
  console.error('Ingest verification error:', err);
  process.exit(1);
});
