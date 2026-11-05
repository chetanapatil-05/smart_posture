// Supabase Edge Function: ingest
// Validates ESP32 device credentials and ingests posture readings, alerts, and events
// Real hardware data only: strictly validates angles, timestamp bounds, states, and stores received_at.

import { createClient } from "npm:@supabase/supabase-js@2";

// CORS headers
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rate limiter: max 120 requests per minute per device (allows 1-2 req/sec streaming)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(deviceId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(deviceId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(deviceId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  entry.count++;
  return true;
}

// Compute SHA-256 hash
async function sha256Hex(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Validate ISO8601 date string
function isValidDate(dateStr: unknown): boolean {
  if (typeof dateStr !== "string") return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

interface IngestReading {
  ts: string;
  angle: number;
  state: "good" | "warning" | "bad";
  movement: number;
}

interface IngestAlert {
  ts: string;
  level: "vibration" | "buzzer";
  duration_s: number;
  reason: "forward_lean" | "slouch" | "sideways";
  recovery_time_s?: number | null;
}

interface IngestEvent {
  ts: string;
  type: string;
  angle?: number | null;
}

interface IngestPayload {
  device_id: string;
  battery_pct?: number | null;
  baseline_angle?: number | null;
  buffered?: boolean;
  readings?: IngestReading[];
  alerts?: IngestAlert[];
  events?: IngestEvent[];
}

export async function handleIngestRequest(req: Request, supabaseOverride?: any): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const deviceKey = req.headers.get("x-device-key");
  if (!deviceKey) {
    return new Response(JSON.stringify({ error: "Missing x-device-key header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let payload: IngestPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 422,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Contract validation
  if (!payload || typeof payload !== "object") {
    return new Response(JSON.stringify({ error: "Payload must be a JSON object" }), {
      status: 422,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!payload.device_id || !uuidRegex.test(payload.device_id)) {
    return new Response(JSON.stringify({ error: "device_id must be a valid UUID" }), {
      status: 422,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Rate limiting check
  if (!checkRateLimit(payload.device_id)) {
    return new Response(JSON.stringify({ error: "Too many requests. Rate limit exceeded." }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const readings = Array.isArray(payload.readings) ? payload.readings : [];
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const events = Array.isArray(payload.events) ? payload.events : [];

  const totalRows = readings.length + alerts.length + events.length;
  if (totalRows > 500) {
    return new Response(
      JSON.stringify({ error: `Batch size (${totalRows}) exceeds 500 rows maximum limit` }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const nowMs = Date.now();
  const maxFutureMs = nowMs + 5 * 60 * 1000; // max 5 minutes in future
  const maxPastMs = nowMs - 24 * 60 * 60 * 1000; // max 24 hours in past (unless buffered: true)
  const isBuffered = payload.buffered === true;

  // Validate readings: angle -90..90, strict ts bounds, state, movement
  for (const r of readings) {
    if (!isValidDate(r.ts) || typeof r.angle !== "number" || isNaN(r.angle)) {
      return new Response(JSON.stringify({ error: "Invalid reading: valid ISO ts and numeric angle required" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (r.angle < -90.0 || r.angle > 90.0) {
      return new Response(
        JSON.stringify({ error: `Reading angle (${r.angle}) outside valid range [-90, 90]` }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const rTime = new Date(r.ts).getTime();
    if (!isBuffered) {
      if (rTime > maxFutureMs) {
        return new Response(
          JSON.stringify({ error: `Reading timestamp (${r.ts}) is more than 5 minutes in the future` }),
          { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (rTime < maxPastMs) {
        return new Response(
          JSON.stringify({ error: `Reading timestamp (${r.ts}) is older than 24 hours. Set buffered: true for historical batches.` }),
          { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (!["good", "warning", "bad"].includes(r.state)) {
      return new Response(JSON.stringify({ error: `Invalid reading state: ${r.state}. Must be good, warning, or bad.` }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof r.movement !== "number" || r.movement < 0 || r.movement > 1) {
      return new Response(JSON.stringify({ error: "Reading movement must be between 0.0 and 1.0" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Validate alerts
  for (const a of alerts) {
    if (!isValidDate(a.ts) || typeof a.duration_s !== "number") {
      return new Response(JSON.stringify({ error: "Invalid alert: valid ISO ts and numeric duration_s required" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aTime = new Date(a.ts).getTime();
    if (!isBuffered && (aTime > maxFutureMs || aTime < maxPastMs)) {
      return new Response(
        JSON.stringify({ error: `Alert timestamp (${a.ts}) outside allowed bounds [-24h, +5m]` }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!["vibration", "buzzer"].includes(a.level)) {
      return new Response(JSON.stringify({ error: `Invalid alert level: ${a.level}` }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!["forward_lean", "slouch", "sideways"].includes(a.reason)) {
      return new Response(JSON.stringify({ error: `Invalid alert reason: ${a.reason}` }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Validate events
  for (const e of events) {
    if (!isValidDate(e.ts) || typeof e.type !== "string" || !e.type) {
      return new Response(JSON.stringify({ error: "Invalid event: valid ISO ts and string type required" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Supabase client initialization
  const supabase =
    supabaseOverride ||
    createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

  // Authenticate device key
  const { data: device, error: devErr } = await supabase
    .from("devices")
    .select("id, device_key_hash, baseline_angle")
    .eq("id", payload.device_id)
    .single();

  if (devErr || !device) {
    return new Response(JSON.stringify({ error: "Device not found" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const keyHash = await sha256Hex(deviceKey);
  if (device.device_key_hash !== keyHash && device.device_key_hash !== deviceKey) {
    return new Response(JSON.stringify({ error: "Invalid device key" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const serverReceivedAt = new Date().toISOString();

  // Insert readings with original device ts and separate server received_at
  if (readings.length > 0) {
    const readingRows = readings.map((r) => ({
      device_id: payload.device_id,
      ts: r.ts, // original device timestamp
      received_at: serverReceivedAt, // server receipt timestamp
      angle: r.angle,
      state: r.state,
      movement: r.movement,
    }));
    const { error: insErr } = await supabase.from("posture_readings").insert(readingRows);
    if (insErr) {
      return new Response(JSON.stringify({ error: `Failed to insert readings: ${insErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Insert alerts with original device ts and separate received_at
  if (alerts.length > 0) {
    const alertRows = alerts.map((a) => ({
      device_id: payload.device_id,
      ts: a.ts,
      received_at: serverReceivedAt,
      level: a.level,
      duration_s: a.duration_s,
      reason: a.reason,
      recovery_time_s: a.recovery_time_s ?? null,
    }));
    const { error: insErr } = await supabase.from("alerts").insert(alertRows);
    if (insErr) {
      return new Response(JSON.stringify({ error: `Failed to insert alerts: ${insErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Insert events with original device ts and separate received_at
  if (events.length > 0) {
    const eventRows = events.map((e) => ({
      device_id: payload.device_id,
      ts: e.ts,
      received_at: serverReceivedAt,
      type: e.type,
      angle: typeof e.angle === "number" ? e.angle : null,
    }));
    const { error: insErr } = await supabase.from("events").insert(eventRows);
    if (insErr) {
      return new Response(JSON.stringify({ error: `Failed to insert events: ${insErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Update device metadata:
  // If battery_pct is absent or null, store NULL (do not invent or keep unverified values)
  const deviceUpdate: Record<string, any> = {
    last_seen: serverReceivedAt,
  };

  if (payload.battery_pct === null) {
    deviceUpdate.battery_pct = null;
  } else if (typeof payload.battery_pct === "number") {
    deviceUpdate.battery_pct = Math.max(0, Math.min(100, Math.round(payload.battery_pct)));
  }

  // Update baseline angle ONLY on real calibration event
  const calEvent = events.find((e) => e.type === "calibration");
  if (calEvent && typeof calEvent.angle === "number") {
    deviceUpdate.baseline_angle = calEvent.angle;
  }

  await supabase.from("devices").update(deviceUpdate).eq("id", payload.device_id);

  return new Response(
    JSON.stringify({
      ok: true,
      inserted: {
        readings: readings.length,
        alerts: alerts.length,
        events: events.length,
      },
      last_seen: deviceUpdate.last_seen,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

// Deno serve entrypoint
if (import.meta.main) {
  // @ts-ignore Deno namespace
  Deno.serve((req: Request) => handleIngestRequest(req));
}
