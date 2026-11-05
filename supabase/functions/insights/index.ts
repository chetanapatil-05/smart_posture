// Supabase Edge Function: insights
// Aggregates real stored 7-day posture metrics, invokes Gemini API with strict real-data rules,
// validates against hallucinated statistics, and tags each suggestion with source and date range.

import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export interface InsightSuggestion {
  text: string;
  severity: "info" | "warn" | "high";
  evidence?: string;
}

export interface InsightsResponse {
  summary: string;
  fatigue_explanation: string;
  suggestions: InsightSuggestion[];
  disclaimer: string;
  source: "gemini" | "rule";
  date_range: string;
  cached?: boolean;
}

// Extract all numbers present in the input telemetry for anti-hallucination validation
export function extractInputNumbers(dailyStats: any[], topReasons: Record<string, number>): Set<number> {
  const nums = new Set<number>();
  dailyStats.forEach((s) => {
    ['good_min', 'warning_min', 'bad_min', 'alert_count', 'posture_score'].forEach((k) => {
      if (typeof s[k] === 'number') nums.add(s[k]);
    });
    if (typeof s.avg_recovery_s === 'number') {
      nums.add(Math.round(s.avg_recovery_s));
      nums.add(Math.floor(s.avg_recovery_s));
    }
  });
  Object.values(topReasons).forEach((v) => nums.add(v));
  nums.add(dailyStats.length); // day count
  return nums;
}

export function generateRuleBasedFallback(
  dailyStats: any[],
  topReasons: Record<string, number>,
  dateRange: string
): InsightsResponse {
  if (dailyStats.length === 0) {
    return {
      summary: "Not enough data for AI insights yet.",
      fatigue_explanation: "",
      suggestions: [],
      disclaimer: "Not medical advice. For ergonomic posture wellness only.",
      source: "rule",
      date_range: "",
    };
  }

  const validScores = dailyStats
    .map((s) => s.posture_score)
    .filter((score): score is number => typeof score === 'number');

  const avgScore = validScores.length > 0
    ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
    : null;

  const totalBadMin = dailyStats.reduce((acc, s) => acc + (s.bad_min || 0), 0);
  const totalAlerts = dailyStats.reduce((acc, s) => acc + (s.alert_count || 0), 0);

  let summary = `Over ${dailyStats.length} recorded day${dailyStats.length === 1 ? '' : 's'}`;
  if (avgScore !== null) {
    summary += `, your average posture score is ${avgScore}/100 with ${totalAlerts} alerts logged.`;
  } else {
    summary += `, ${totalAlerts} alerts were logged.`;
  }

  const primaryReason = Object.entries(topReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const fatigue_explanation = primaryReason
    ? `The most common posture lapse recorded by your device is ${primaryReason.replace('_', ' ')} (${topReasons[primaryReason]} occurrences).`
    : `Posture fatigue remains within normal ranges based on monitored device data.`;

  const suggestions: InsightSuggestion[] = [];

  if (totalBadMin >= 30) {
    suggestions.push({
      text: "Position your screen so the top third is at eye level to prevent forward tilt.",
      severity: "warn",
      evidence: `${totalBadMin} min cumulative bad posture recorded in period`,
    });
  }

  if (totalAlerts >= 5) {
    suggestions.push({
      text: "Take a 2-minute mobility break every 45 minutes to reset spinal alignment.",
      severity: "info",
      evidence: `${totalAlerts} hardware alerts recorded by wearable`,
    });
  }

  return {
    summary,
    fatigue_explanation,
    suggestions: suggestions.slice(0, 4),
    disclaimer: "Not medical advice. For ergonomic posture wellness only.",
    source: "rule",
    date_range: dateRange,
  };
}

export function parseAndValidateGeminiResponse(
  rawText: string,
  allowedNumbers: Set<number>,
  dateRange: string
): InsightsResponse | null {
  try {
    let clean = rawText.trim();
    if (clean.startsWith("```json")) {
      clean = clean.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
      clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const data = JSON.parse(clean);
    if (!data || typeof data !== "object") return null;
    if (typeof data.summary !== "string" || !data.summary) return null;
    if (typeof data.fatigue_explanation !== "string" || !data.fatigue_explanation) return null;
    if (!Array.isArray(data.suggestions) || data.suggestions.length === 0) return null;

    const validatedSuggestions: InsightSuggestion[] = [];
    for (const item of data.suggestions.slice(0, 4)) {
      if (typeof item.text === "string" && item.text.trim()) {
        const text = item.text.trim();
        // Anti-hallucination check: reject any suggestion quoting a number not in the input data
        // Match numbers with word boundaries
        const quotedNums = (text.match(/\b\d+\b/g) || []).map(Number);
        const hasHallucinatedNumber = quotedNums.some((n) => !allowedNumbers.has(n));

        if (!hasHallucinatedNumber) {
          const sev = ["info", "warn", "high"].includes(item.severity) ? item.severity : "info";
          validatedSuggestions.push({ text, severity: sev });
        }
      }
    }

    if (validatedSuggestions.length === 0) return null;

    return {
      summary: data.summary.trim(),
      fatigue_explanation: data.fatigue_explanation.trim(),
      suggestions: validatedSuggestions,
      disclaimer: "Not medical advice. For ergonomic posture wellness only.",
      source: "gemini",
      date_range: dateRange,
    };
  } catch {
    return null;
  }
}

export async function handleInsightsRequest(
  req: Request,
  supabaseOverride?: any,
  geminiFetchOverride?: typeof fetch
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase =
    supabaseOverride ||
    createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

  let deviceId: string | null = null;
  let forceRefresh = false;

  if (req.method === "POST") {
    try {
      const body = await req.json();
      deviceId = body.device_id ?? null;
      forceRefresh = !!body.force;
    } catch {
      // Allow empty body
    }
  }

  if (!deviceId) {
    const { data: firstDev } = await supabase.from("devices").select("id").limit(1).single();
    deviceId = firstDev?.id ?? null;
  }

  if (!deviceId) {
    return new Response(JSON.stringify({ error: "No device found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const today = new Date().toISOString().split("T")[0];
  const startOfDay = `${today}T00:00:00.000Z`;

  // Check cache: 1 result per device per day
  if (!forceRefresh) {
    const { data: cachedRows } = await supabase
      .from("recommendations")
      .select("ts, text, evidence, severity, source")
      .eq("device_id", deviceId)
      .eq("source", "gemini")
      .gte("ts", startOfDay)
      .order("ts", { ascending: false });

    if (cachedRows && cachedRows.length > 0) {
      const summaryItem = cachedRows.find((r: any) => r.text.startsWith("Summary:"));
      const summaryText = summaryItem
        ? summaryItem.text.replace(/^Summary:\s*/, "")
        : cachedRows[0].text;

      const suggestionItems = cachedRows
        .filter((r: any) => !r.text.startsWith("Summary:") && !r.text.startsWith("Fatigue:"))
        .map((r: any) => ({ text: r.text, severity: r.severity, evidence: r.evidence }));

      return new Response(
        JSON.stringify({
          ok: true,
          cached: true,
          insights: {
            summary: summaryText,
            fatigue_explanation: "Cached daily analysis from earlier assessment.",
            suggestions: suggestionItems,
            disclaimer: "Not medical advice. For ergonomic posture wellness only.",
            source: "gemini",
            date_range: today,
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // Fetch 7-day daily_stats aggregates from real stored rows
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const { data: statsRows } = await supabase
    .from("daily_stats")
    .select("date, good_min, warning_min, bad_min, alert_count, avg_recovery_s, posture_score, pfi, pfi_reason, status")
    .eq("device_id", deviceId)
    .gte("date", sevenDaysAgo)
    .order("date", { ascending: true });

  const dailyStats = (statsRows || []).filter((s: any) => s.status !== 'insufficient_data');

  // Requirement: If there is fewer than 1 full day of data, do not call Gemini.
  if (dailyStats.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        cached: false,
        insights: {
          summary: "Not enough data for AI insights yet.",
          fatigue_explanation: "",
          suggestions: [],
          disclaimer: "Not medical advice. For ergonomic posture wellness only.",
          source: "rule",
          date_range: "",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Fetch top alert reasons
  const { data: alertsRows } = await supabase
    .from("alerts")
    .select("reason")
    .eq("device_id", deviceId)
    .gte("ts", `${sevenDaysAgo}T00:00:00.000Z`);

  const topReasons: Record<string, number> = {};
  (alertsRows || []).forEach((a: any) => {
    topReasons[a.reason] = (topReasons[a.reason] || 0) + 1;
  });

  const dateRange = `${dailyStats[0].date} to ${dailyStats[dailyStats.length - 1].date}`;
  const allowedNumbers = extractInputNumbers(dailyStats, topReasons);
  let insightsResponse: InsightsResponse | null = null;

  // @ts-ignore Deno env check
  const geminiApiKey = typeof Deno !== "undefined" ? Deno.env.get("GEMINI_API_KEY") : process.env.GEMINI_API_KEY;
  // @ts-ignore Deno env check
  const geminiModel = (typeof Deno !== "undefined" ? Deno.env.get("GEMINI_MODEL") : process.env.GEMINI_MODEL) || "gemini-1.5-flash";

  if (geminiApiKey) {
    try {
      const fetchFn = geminiFetchOverride || fetch;
      // Strict real data prompt contract
      const prompt = `You are an ergonomic posture assistant analyzing wearable sensor statistics.
Use ONLY the numbers provided. Do not invent statistics, trends, times or medical claims. If data is insufficient, say so.

Context aggregates for the date range (${dateRange}):
- Daily posture stats: ${JSON.stringify(dailyStats)}
- Alert triggers by posture type: ${JSON.stringify(topReasons)}

Rules:
1. Provide plain language, friendly and constructive ergonomic guidance.
2. DO NOT give medical diagnosis or medical advice.
3. Return STRICT JSON with this schema:
{
  "summary": "1-2 sentence overall trend summary using only provided numbers",
  "fatigue_explanation": "1-2 sentences explaining posture fatigue factors and recovery patterns",
  "suggestions": [
    { "text": "actionable ergonomic tip without invented numbers (max 4 tips)", "severity": "info" | "warn" | "high" }
  ]
}`;

      const res = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      if (res.ok) {
        const geminiJson = await res.json();
        const rawContent = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawContent) {
          insightsResponse = parseAndValidateGeminiResponse(rawContent, allowedNumbers, dateRange);
        }
      }
    } catch {
      insightsResponse = null;
    }
  }

  // Resilient fallback to rule-based insights if Gemini unavailable, failed, or hallucinated numbers
  if (!insightsResponse) {
    insightsResponse = generateRuleBasedFallback(dailyStats, topReasons, dateRange);
  }

  // Store in recommendations table
  const recsToInsert = [
    {
      device_id: deviceId,
      ts: new Date().toISOString(),
      text: `Summary: ${insightsResponse.summary}`,
      evidence: `Period: ${dateRange}`,
      severity: "info",
      source: insightsResponse.source,
    },
    ...insightsResponse.suggestions.map((s) => ({
      device_id: deviceId,
      ts: new Date().toISOString(),
      text: s.text,
      evidence: s.evidence || `Period: ${dateRange}`,
      severity: s.severity,
      source: insightsResponse!.source,
    })),
  ];

  await supabase.from("recommendations").insert(recsToInsert);

  return new Response(
    JSON.stringify({
      ok: true,
      cached: false,
      insights: insightsResponse,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

if (import.meta.main) {
  // @ts-ignore Deno namespace
  Deno.serve((req: Request) => handleInsightsRequest(req));
}
