// Test script for Edge Function `insights` - Real Data Only & Anti-Hallucination
import {
  parseAndValidateGeminiResponse,
  extractInputNumbers,
  handleInsightsRequest,
} from '../supabase/functions/insights/index.ts';

async function testInsightsFunction() {
  console.log('--- Verifying Edge Function `insights` Real Data Only ---');

  const deviceId = '12345678-1234-1234-1234-1234567890ab';
  const dateRange = '2026-10-21 to 2026-10-22';

  const testDailyStats = [
    {
      date: '2026-10-21',
      good_min: 240,
      warning_min: 30,
      bad_min: 20,
      alert_count: 3,
      posture_score: 88,
      status: 'completed',
    },
  ];
  const testTopReasons = { forward_lean: 3 };
  const allowedNumbers = extractInputNumbers(testDailyStats, testTopReasons);

  // --- Test 1: Anti-hallucination rejection of non-input numbers ---
  const hallucinatedGeminiJson = JSON.stringify({
    summary: 'You improved your posture by 88 points.',
    fatigue_explanation: 'Fatigue was minimal.',
    suggestions: [
      { text: 'You had 999 unverified slouch events yesterday.', severity: 'high' }, // 999 is NOT in input numbers!
      { text: 'Raise your screen to eye level to prevent forward tilt.', severity: 'info' }, // No hallucinated numbers
    ],
  });

  const validated = parseAndValidateGeminiResponse(hallucinatedGeminiJson, allowedNumbers, dateRange);
  if (!validated || validated.suggestions.length !== 1) {
    throw new Error('Test 1 Failed: Hallucinated suggestion with number 999 was not rejected!');
  }
  if (validated.suggestions[0].text.includes('999')) {
    throw new Error('Test 1 Failed: Hallucinated suggestion leaked through validator!');
  }
  console.log('✓ Test 1: Suggestions with hallucinated statistics/numbers are strictly rejected');

  // --- Test 2: If < 1 day of data, return "Not enough data for AI insights yet." ---
  const emptySupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () => ({
              order: async () => ({ data: [], error: null }),
            }),
          }),
          gte: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
        limit: () => ({
          single: async () => ({ data: { id: deviceId }, error: null }),
        }),
      }),
      insert: async () => ({ data: [], error: null }),
    }),
  };

  const reqEmpty = new Request('http://localhost/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  });

  const resEmpty = await handleInsightsRequest(reqEmpty, emptySupabase);
  const bodyEmpty = await resEmpty.json();
  if (!bodyEmpty.insights.summary.includes('Not enough data')) {
    throw new Error(`Test 2 Failed: Expected not enough data notice, got: ${bodyEmpty.insights.summary}`);
  }
  if (bodyEmpty.insights.suggestions.length !== 0) {
    throw new Error('Test 2 Failed: Suggestions should be empty when no days of data exist');
  }
  console.log('✓ Test 2: Returns "Not enough data for AI insights yet." with 0 suggestions when < 1 full day of data exists');

  // --- Test 3: Valid Gemini response tagged with date range and source ---
  const validGeminiJson = JSON.stringify({
    summary: 'Your posture score averaged 88 with 3 alert triggers across the session.',
    fatigue_explanation: 'Fatigue remained stable with prompt recovery.',
    suggestions: [
      { text: 'Maintain screen at eye level to prevent forward lean.', severity: 'warn' },
    ],
  });

  const validParsed = parseAndValidateGeminiResponse(validGeminiJson, allowedNumbers, dateRange);
  if (!validParsed || validParsed.date_range !== dateRange || validParsed.source !== 'gemini') {
    throw new Error('Test 3 Failed: Date range or source tag missing');
  }
  console.log(`✓ Test 3: Suggestions tagged with verified date range: "${validParsed.date_range}" and source: "${validParsed.source}"`);

  console.log('--- Edge Function `insights` Real Data Only Verified ---');
}

testInsightsFunction().catch((err) => {
  console.error('Insights verification failed:', err);
  process.exit(1);
});
