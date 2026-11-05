// Supabase Edge Function: analyze
// Rule-based daily aggregation, Posture Fatigue Index (PFI), and recommendations
// Real hardware data only: requires >= 15 min of readings, handles >60s gaps as no-data, provides evidence strings.

import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export interface AnalyzeResult {
  device_id: string;
  date: string;
  good_min: number;
  warning_min: number;
  bad_min: number;
  total_min: number;
  gap_min: number;
  alert_count: number;
  avg_recovery_s: number;
  inactivity_min: number;
  posture_score: number | null;
  pfi: "Low" | "Moderate" | "High" | null;
  pfi_reason: string;
  status: "completed" | "insufficient_data";
  recommendations: Array<{ text: string; evidence: string; severity: "info" | "warn" | "high"; source: "rule" }>;
}

export function computeDailyMetrics(
  deviceId: string,
  targetDate: string,
  readings: Array<{ ts: string; angle: number; state: "good" | "warning" | "bad"; movement: number }>,
  alerts: Array<{ ts: string; level: string; duration_s: number; reason: string; recovery_time_s?: number | null }>
): AnalyzeResult {
  // Sort readings chronologically
  const sortedReadings = [...readings].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  let goodSec = 0;
  let warnSec = 0;
  let badSec = 0;
  let gapSec = 0;
  let inactiveSec = 0;
  let movementSum = 0;

  for (let i = 0; i < sortedReadings.length; i++) {
    const cur = sortedReadings[i];
    let durationSec = 10; // default duration per reading if single
    if (i < sortedReadings.length - 1) {
      const next = sortedReadings[i + 1];
      const diffSec = (new Date(next.ts).getTime() - new Date(cur.ts).getTime()) / 1000;
      if (diffSec > 60) {
        // Gaps > 60s counted as "no data", NEVER as good or bad time
        gapSec += (diffSec - 10);
        durationSec = 10;
      } else if (diffSec > 0) {
        durationSec = diffSec;
      }
    }

    if (cur.state === "good") goodSec += durationSec;
    else if (cur.state === "warning") warnSec += durationSec;
    else if (cur.state === "bad") badSec += durationSec;

    if (cur.movement <= 0.05) {
      inactiveSec += durationSec;
    }
    movementSum += cur.movement;
  }

  const good_min = Math.round(goodSec / 60);
  const warning_min = Math.round(warnSec / 60);
  const bad_min = Math.round(badSec / 60);
  const gap_min = Math.round(gapSec / 60);
  const inactivity_min = Math.round(inactiveSec / 60);
  const total_min = good_min + warning_min + bad_min;

  // Alerts analysis
  const alert_count = alerts.length;
  const recoveries = alerts
    .map((a) => a.recovery_time_s)
    .filter((s): s is number => typeof s === "number" && s > 0);
  const avg_recovery_s =
    recoveries.length > 0
      ? Math.round((recoveries.reduce((acc, v) => acc + v, 0) / recoveries.length) * 10) / 10
      : 0;

  // Requirement: Require at least 15 minutes of readings before computing score and PFI
  if (total_min < 15) {
    return {
      device_id: deviceId,
      date: targetDate,
      good_min,
      warning_min,
      bad_min,
      total_min,
      gap_min,
      alert_count,
      avg_recovery_s,
      inactivity_min,
      posture_score: null,
      pfi: null,
      pfi_reason: "Not enough data yet (needs 15 min of readings)",
      status: "insufficient_data",
      recommendations: [],
    };
  }

  // 1. Posture Score Calculation (0-100)
  // Penalties: bad minute share, alert count, slow recovery
  const badRatio = bad_min / total_min;
  const warnRatio = warning_min / total_min;
  const badPenalty = badRatio * 50;
  const warnPenalty = warnRatio * 20;
  const alertPenalty = Math.min(25, alert_count * 2.5);
  const recoveryPenalty = avg_recovery_s > 30 ? Math.min(15, (avg_recovery_s - 30) * 0.5) : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - badPenalty - warnPenalty - alertPenalty - recoveryPenalty)));

  // 2. Posture Fatigue Index (PFI) & Reason
  // Uses strictly MPU6050 metrics: bad-posture duration, inactivity, movement level, sitting time
  const avgMovement = sortedReadings.length > 0 ? movementSum / sortedReadings.length : 0.5;

  let pfi: "Low" | "Moderate" | "High" = "Low";
  let pfi_reason = "Low fatigue: healthy posture alignment and active micro-movements maintained.";

  if (
    bad_min >= 45 ||
    inactivity_min >= 120 ||
    (bad_min >= 25 && inactivity_min >= 60) ||
    (avgMovement < 0.05 && total_min >= 60)
  ) {
    pfi = "High";
    const reasons: string[] = [];
    if (bad_min >= 45) reasons.push(`${bad_min}m sustained bad posture`);
    if (inactivity_min >= 120) reasons.push(`${inactivity_min}m static sitting`);
    if (avgMovement < 0.05) reasons.push("near-zero spinal movement");
    pfi_reason = `High fatigue: ${reasons.join(", ") || "elevated slouch duration and stillness"}.`;
  } else if (bad_min >= 15 || inactivity_min >= 60 || alert_count >= 5) {
    pfi = "Moderate";
    const reasons: string[] = [];
    if (bad_min >= 15) reasons.push(`${bad_min}m slouch time`);
    if (inactivity_min >= 60) reasons.push(`${inactivity_min}m static sitting`);
    if (alert_count >= 5) reasons.push(`${alert_count} posture alerts triggered`);
    pfi_reason = `Moderate fatigue: ${reasons.join(", ")}.`;
  }

  // 3. Rule-based recommendations with required evidence text
  const recommendations: Array<{ text: string; evidence: string; severity: "info" | "warn" | "high"; source: "rule" }> = [];

  if (inactivity_min >= 45) {
    recommendations.push({
      text: "Movement break recommended: Take a 2-minute walking or stretching break.",
      evidence: `Accumulated ${inactivity_min} min of static sitting with movement ≤ 0.05`,
      severity: "warn",
      source: "rule",
    });
  }

  const forwardLeanAlerts = alerts.filter((a) => a.reason === "forward_lean").length;
  if (forwardLeanAlerts >= 3) {
    recommendations.push({
      text: "Frequent forward leaning detected: Elevate your display to eye level to reduce neck strain.",
      evidence: `${forwardLeanAlerts} forward lean alert triggers recorded today`,
      severity: "warn",
      source: "rule",
    });
  }

  if (avg_recovery_s >= 35) {
    recommendations.push({
      text: "Delayed slouch correction: Respond promptly when the vibration motor triggers.",
      evidence: `Average alert recovery time is ${avg_recovery_s}s (target < 30s)`,
      severity: "high",
      source: "rule",
    });
  }

  if (score >= 85 && pfi === "Low") {
    recommendations.push({
      text: "Great posture habits today: Core alignment is stable and movement frequency is optimal.",
      evidence: `Posture score ${score}/100 with ${good_min} of ${total_min} monitored minutes in good alignment`,
      severity: "info",
      source: "rule",
    });
  }

  return {
    device_id: deviceId,
    date: targetDate,
    good_min,
    warning_min,
    bad_min,
    total_min,
    gap_min,
    alert_count,
    avg_recovery_s,
    inactivity_min,
    posture_score: score,
    pfi,
    pfi_reason,
    status: "completed",
    recommendations,
  };
}

export async function handleAnalyzeRequest(req: Request, supabaseOverride?: any): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase =
    supabaseOverride ||
    createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

  let targetDeviceId: string | null = null;
  let targetDate = new Date().toISOString().split("T")[0];

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body.device_id) targetDeviceId = body.device_id;
      if (body.date) targetDate = body.date;
    } catch {
      // Empty body is acceptable
    }
  }

  // Find target devices
  let deviceQuery = supabase.from("devices").select("id");
  if (targetDeviceId) {
    deviceQuery = deviceQuery.eq("id", targetDeviceId);
  }
  const { data: devices, error: devErr } = await deviceQuery;

  if (devErr || !devices || devices.length === 0) {
    return new Response(JSON.stringify({ error: "No target devices found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startOfDay = `${targetDate}T00:00:00.000Z`;
  const endOfDay = `${targetDate}T23:59:59.999Z`;

  const results: AnalyzeResult[] = [];

  for (const dev of devices) {
    const { data: readings } = await supabase
      .from("posture_readings")
      .select("ts, angle, state, movement")
      .eq("device_id", dev.id)
      .gte("ts", startOfDay)
      .lte("ts", endOfDay);

    const { data: alerts } = await supabase
      .from("alerts")
      .select("ts, level, duration_s, reason, recovery_time_s")
      .eq("device_id", dev.id)
      .gte("ts", startOfDay)
      .lte("ts", endOfDay);

    const metrics = computeDailyMetrics(
      dev.id,
      targetDate,
      readings || [],
      alerts || []
    );

    // Upsert into daily_stats table
    await supabase.from("daily_stats").upsert(
      {
        device_id: metrics.device_id,
        date: metrics.date,
        good_min: metrics.good_min,
        warning_min: metrics.warning_min,
        bad_min: metrics.bad_min,
        alert_count: metrics.alert_count,
        avg_recovery_s: metrics.avg_recovery_s,
        inactivity_min: metrics.inactivity_min,
        posture_score: metrics.posture_score,
        pfi: metrics.pfi,
        pfi_reason: metrics.pfi_reason,
        status: metrics.status,
      },
      { onConflict: "device_id, date" }
    );

    // Insert recommendations only when evidence was found
    if (metrics.recommendations.length > 0) {
      const recRows = metrics.recommendations.map((r) => ({
        device_id: dev.id,
        ts: new Date().toISOString(),
        text: r.text,
        evidence: r.evidence,
        severity: r.severity,
        source: r.source,
      }));
      await supabase.from("recommendations").insert(recRows);
    }

    results.push(metrics);
  }

  return new Response(JSON.stringify({ ok: true, analyzed: results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

if (import.meta.main) {
  // @ts-ignore Deno namespace
  Deno.serve((req: Request) => handleAnalyzeRequest(req));
}
