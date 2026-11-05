-- ====================================================================
-- SmartPosture AI - Complete Database Schema & Initial Device Setup
-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/rsswlgklrjysitrcjcpt/sql/new
-- ====================================================================

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Devices table
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    device_key_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'SmartPosture Wearable',
    battery_pct INT CHECK (battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100)),
    last_seen TIMESTAMPTZ DEFAULT now(),
    baseline_angle DOUBLE PRECISION DEFAULT 8.0,
    warn_deg DOUBLE PRECISION DEFAULT 15.0,
    bad_deg DOUBLE PRECISION DEFAULT 25.0,
    alert_delay_s INT DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Posture readings (telemetry)
CREATE TABLE IF NOT EXISTS public.posture_readings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    angle DOUBLE PRECISION NOT NULL CHECK (angle >= -90.0 AND angle <= 90.0),
    state TEXT NOT NULL CHECK (state IN ('good', 'warning', 'bad')),
    movement DOUBLE PRECISION NOT NULL CHECK (movement >= 0.0 AND movement <= 1.0)
);

-- 4. Alerts (vibration, buzzer)
CREATE TABLE IF NOT EXISTS public.alerts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    level TEXT NOT NULL CHECK (level IN ('vibration', 'buzzer')),
    duration_s INT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('forward_lean', 'slouch', 'sideways')),
    recovery_time_s INT
);

-- 5. Events (e.g. calibration)
CREATE TABLE IF NOT EXISTS public.events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    type TEXT NOT NULL,
    angle DOUBLE PRECISION
);

-- 6. Daily aggregated statistics & PFI
CREATE TABLE IF NOT EXISTS public.daily_stats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    good_min INT NOT NULL DEFAULT 0,
    warning_min INT NOT NULL DEFAULT 0,
    bad_min INT NOT NULL DEFAULT 0,
    alert_count INT NOT NULL DEFAULT 0,
    avg_recovery_s DOUBLE PRECISION DEFAULT 0.0,
    inactivity_min INT NOT NULL DEFAULT 0,
    posture_score INT CHECK (posture_score IS NULL OR (posture_score >= 0 AND posture_score <= 100)),
    pfi TEXT CHECK (pfi IS NULL OR pfi IN ('Low', 'Moderate', 'High')),
    pfi_reason TEXT NOT NULL DEFAULT 'Not enough data yet (needs 15 min of readings)',
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'insufficient_data')),
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_device_date UNIQUE (device_id, date)
);

-- 7. Recommendations (rule-based and Gemini AI)
CREATE TABLE IF NOT EXISTS public.recommendations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    text TEXT NOT NULL,
    evidence TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'high')),
    source TEXT NOT NULL CHECK (source IN ('rule', 'gemini'))
);

-- 8. Indexes on (device_id, ts) or date
CREATE INDEX IF NOT EXISTS idx_posture_readings_device_ts ON public.posture_readings (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON public.alerts (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON public.events (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_daily_stats_device_date ON public.daily_stats (device_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_device_ts ON public.recommendations (device_id, ts DESC);

-- 9. Row Level Security (RLS)
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posture_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;

-- Anonymous/Public access policies for dashboard without login
CREATE POLICY "Public read devices" ON public.devices FOR SELECT USING (true);
CREATE POLICY "Public update devices" ON public.devices FOR UPDATE USING (true);
CREATE POLICY "Public read readings" ON public.posture_readings FOR SELECT USING (true);
CREATE POLICY "Public read alerts" ON public.alerts FOR SELECT USING (true);
CREATE POLICY "Public read events" ON public.events FOR SELECT USING (true);
CREATE POLICY "Public read daily_stats" ON public.daily_stats FOR SELECT USING (true);
CREATE POLICY "Public read recommendations" ON public.recommendations FOR SELECT USING (true);

-- Authenticated user policies
CREATE POLICY "Users can manage their own devices" ON public.devices FOR ALL USING (auth.uid() = user_id);

-- 10. Enable Supabase Realtime
DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.posture_readings;
    EXCEPTION WHEN duplicate_object THEN
        NULL;
    END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
    EXCEPTION WHEN duplicate_object THEN
        NULL;
    END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
    EXCEPTION WHEN duplicate_object THEN
        NULL;
    END;
END $$;

-- 11. Data retention function
CREATE OR REPLACE FUNCTION public.clean_old_posture_data(retention_days INT DEFAULT 90)
RETURNS void AS $$
BEGIN
    DELETE FROM public.posture_readings WHERE ts < now() - (retention_days || ' days')::INTERVAL;
    DELETE FROM public.alerts WHERE ts < now() - (retention_days || ' days')::INTERVAL;
    DELETE FROM public.events WHERE ts < now() - (retention_days || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. Register default ESP32 Device
INSERT INTO public.devices (id, device_key_hash, name, baseline_angle, warn_deg, bad_deg, alert_delay_s)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'smartposture-esp32-key-2026',
    'SmartPosture Wearable',
    8.0,
    15.0,
    25.0,
    10
)
ON CONFLICT (id) DO UPDATE SET
    device_key_hash = EXCLUDED.device_key_hash,
    name = EXCLUDED.name;

