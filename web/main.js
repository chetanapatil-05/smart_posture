// SmartPosture AI - Frontend Application Logic (Real Hardware Data Only)
import { createClient } from '@supabase/supabase-js';

let chartModule = null;

// Configuration from environment
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const OFFLINE_AFTER_S = Number(import.meta.env.VITE_OFFLINE_AFTER_S || 120);

// Initialize Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Application State - Strictly Data-Driven
const state = {
  theme: localStorage.getItem('smartposture_theme') || 'dark',
  device: null,
  liveReading: null,
  stateDurationSec: 0,
  lastState: null,
  lastCalibrationTime: null,
  dailyStats: [],
  todayReadings: [],
  allAlerts: [],
  recommendations: [],
  user: null,
};

// DOM Elements
// Dynamic DOM Elements Proxy for reliable retrieval
const idMap = {
  statusBadge: 'status-badge',
  statusText: 'status-text',
  batteryBadge: 'battery-badge',
  batteryText: 'battery-text',
  deviceName: 'device-name-display',
  setupCard: 'setup-card',
  liveCard: 'live-card',
  liveSyncIndicator: 'live-sync-indicator',
  liveBadge: 'live-state-badge',
  liveAngle: 'live-angle-display',
  liveBaselineDiff: 'live-baseline-diff',
  liveTimer: 'live-state-timer',
  liveLastCalibrated: 'live-last-calibrated',
  liveLastReadingTime: 'live-last-reading-time',
  offlineCallout: 'offline-callout',
  kpiScore: 'kpi-score',
  kpiScoreSub: 'kpi-score-sub',
  kpiScoreFootnote: 'kpi-score-footnote',
  kpiPfiTag: 'kpi-pfi-tag',
  kpiPfiReason: 'kpi-pfi-reason',
  kpiAlerts: 'kpi-alerts',
  kpiRecovery: 'kpi-recovery',
  timelineEmptyState: 'timeline-empty-state',
  timelineFootnote: 'timeline-footnote',
  weeklyEmptyState: 'weekly-empty-state',
  weeklyFootnote: 'weekly-footnote',
  alertsTbody: 'alerts-tbody',
  alertsFilter: 'alerts-day-filter',
  alertsFootnote: 'alerts-footnote',
  insightsSummary: 'insights-summary-text',
  insightsFatigue: 'insights-fatigue-text',
  suggestionsGrid: 'suggestions-grid',
  insightsSourceTag: 'insights-source-tag',
  refreshInsightsBtn: 'refresh-insights-btn',
  refreshBtnText: 'refresh-btn-text',
  insightsFootnote: 'insights-footnote',
  settingBaseline: 'setting-baseline',
  settingWarnDeg: 'setting-warn-deg',
  settingBadDeg: 'setting-bad-deg',
  settingAlertDelay: 'setting-alert-delay',
  saveSettingsBtn: 'save-settings-btn',
  exportCsvBtn: 'export-csv-btn',
  themeToggleBtn: 'theme-toggle-btn',
  authStatusText: 'auth-status-text',
  authEmailInput: 'auth-email-input',
  authSubmitBtn: 'auth-submit-btn',
  authControls: 'auth-controls',
};

const safeNoop = new Proxy(function() {}, {
  get: () => safeNoop,
  set: () => true,
  apply: () => safeNoop,
});

const el = new Proxy({}, {
  get: (_, prop) => {
    const id = idMap[prop] || prop;
    const found = typeof document !== 'undefined' ? document.getElementById(id) : null;
    return found || safeNoop;
  },
});

// Apply Theme
function applyTheme(newTheme) {
  state.theme = newTheme;
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('smartposture_theme', newTheme);
  updateCharts();
}

// Relative Time Helper
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (isNaN(seconds) || seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Format Seconds to MM:SS
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 1. Update Header
function updateHeader() {
  try {
    if (!state.device || !state.device.last_seen) {
      if (el.statusBadge) el.statusBadge.className = 'badge badge-offline';
      if (el.statusText) el.statusText.textContent = 'No device paired';
      if (el.batteryBadge) el.batteryBadge.style.display = 'none';
      if (el.deviceName) el.deviceName.textContent = 'SmartPosture Wearable';
      return;
    }

    if (el.deviceName) el.deviceName.textContent = state.device.name || 'SmartPosture Wearable';

    const lastSeenDate = new Date(state.device.last_seen);
    const diffSec = (Date.now() - lastSeenDate.getTime()) / 1000;
    const isOnline = diffSec <= OFFLINE_AFTER_S;

    if (isOnline) {
      if (el.statusBadge) el.statusBadge.className = 'badge badge-online';
      if (el.statusText) el.statusText.textContent = 'Online';
    } else {
      if (el.statusBadge) el.statusBadge.className = 'badge badge-offline';
      if (el.statusText) el.statusText.textContent = `Offline (${timeAgo(state.device.last_seen)})`;
    }

    // Battery: if null or undefined, hide battery widget completely
    if (state.device.battery_pct !== null && state.device.battery_pct !== undefined) {
      if (el.batteryBadge) el.batteryBadge.style.display = 'inline-flex';
      if (el.batteryText) el.batteryText.textContent = `${state.device.battery_pct}%`;
    } else {
      if (el.batteryBadge) el.batteryBadge.style.display = 'none';
    }
  } catch (err) {
    console.warn('Error in updateHeader:', err);
  }
}

// 2. Update Live Status Card
function updateLiveCard() {
  try {
    const r = state.liveReading;
    const dev = state.device;

    // If no readings have ever arrived, prompt onboarding
    if (!r) {
      if (el.setupCard) el.setupCard.style.display = 'block';
      if (el.liveBadge) {
        el.liveBadge.className = 'state-badge-large';
        el.liveBadge.textContent = 'NO DATA';
      }
      if (el.liveAngle) el.liveAngle.textContent = '--';
      if (el.liveBaselineDiff) el.liveBaselineDiff.textContent = 'Waiting for device readings';
      if (el.liveTimer) el.liveTimer.textContent = '--:--';
      if (el.liveLastReadingTime) el.liveLastReadingTime.textContent = 'No reading received yet';
      if (el.liveLastCalibrated) el.liveLastCalibrated.textContent = 'Not calibrated, press the device button';
      return;
    }

    if (el.setupCard) el.setupCard.style.display = 'none';

    // Check online vs offline
    const lastSeenDate = dev?.last_seen ? new Date(dev.last_seen) : new Date(r.ts);
    const diffSec = (Date.now() - lastSeenDate.getTime()) / 1000;
    const isOnline = diffSec <= OFFLINE_AFTER_S;

    if (!isOnline) {
      if (el.liveCard) el.liveCard.classList.add('offline');
      if (el.offlineCallout) {
        el.offlineCallout.style.display = 'block';
        el.offlineCallout.textContent = `Device offline, last seen ${timeAgo(lastSeenDate)}`;
      }
    } else {
      if (el.liveCard) el.liveCard.classList.remove('offline');
      if (el.offlineCallout) el.offlineCallout.style.display = 'none';
    }

    // Update State & Timer
    if (r.state !== state.lastState) {
      state.lastState = r.state;
      state.stateDurationSec = 0;
    }

    if (el.liveCard) el.liveCard.className = `card live-card state-${r.state} ${isOnline ? '' : 'offline'}`;
    if (el.liveBadge) {
      el.liveBadge.className = `state-badge-large ${r.state}`;
      el.liveBadge.textContent = (r.state || 'NO DATA').toUpperCase();
    }

    // Angle & Baseline
    const angleNum = typeof r.angle === 'number' ? r.angle : Number(r.angle || 0);
    if (el.liveAngle) el.liveAngle.textContent = `${angleNum.toFixed(1)}°`;

    const hasBaseline = dev && typeof dev.baseline_angle === 'number';
    if (hasBaseline) {
      const diff = angleNum - dev.baseline_angle;
      const diffSign = diff >= 0 ? '+' : '';
      if (el.liveBaselineDiff) el.liveBaselineDiff.textContent = `${diffSign}${diff.toFixed(1)}° vs baseline (${dev.baseline_angle.toFixed(1)}°)`;
    } else {
      if (el.liveBaselineDiff) el.liveBaselineDiff.textContent = 'Not calibrated, press the device button';
    }

    if (el.liveTimer) el.liveTimer.textContent = formatDuration(state.stateDurationSec);
    if (el.liveLastReadingTime) el.liveLastReadingTime.textContent = `Last reading: ${new Date(r.ts).toLocaleTimeString()}`;

    if (state.lastCalibrationTime) {
      if (el.liveLastCalibrated) el.liveLastCalibrated.textContent = state.lastCalibrationTime;
    } else if (hasBaseline) {
      if (el.liveLastCalibrated) el.liveLastCalibrated.textContent = `Calibrated at ${dev.baseline_angle.toFixed(1)}°`;
    } else {
      if (el.liveLastCalibrated) el.liveLastCalibrated.textContent = 'Not calibrated, press the device button';
    }
  } catch (err) {
    console.warn('Error in updateLiveCard:', err);
  }
}

// 3. Update KPI Row
function updateKpis() {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayStat = state.dailyStats.find((s) => s.date === todayStr);

    const readingCount = state.todayReadings.length;
    if (el.kpiScoreFootnote) el.kpiScoreFootnote.textContent = `Computed from ${readingCount} reading${readingCount === 1 ? '' : 's'}`;

    // Honest Analytics check: Needs at least 15 min of data
    const hasFifteenMin = todayStat && (todayStat.good_min + todayStat.warning_min + todayStat.bad_min >= 15);

    if (!todayStat || todayStat.status === 'insufficient_data' || !hasFifteenMin) {
      if (el.kpiScore) el.kpiScore.innerHTML = `--`;
      if (el.kpiScoreSub) el.kpiScoreSub.textContent = 'Not enough data yet (needs 15 min of readings)';

      if (el.kpiPfiTag) {
        el.kpiPfiTag.className = 'pfi-tag';
        el.kpiPfiTag.textContent = 'No data';
      }
      if (el.kpiPfiReason) el.kpiPfiReason.textContent = 'Not enough data yet (needs 15 min of readings)';
    } else {
      if (el.kpiScore) el.kpiScore.innerHTML = `${todayStat.posture_score}<span style="font-size: 1rem; color: var(--text-muted);">/100</span>`;
      if (el.kpiScoreSub) el.kpiScoreSub.textContent = 'Based on stored session data';

      if (el.kpiPfiTag) {
        el.kpiPfiTag.className = `pfi-tag pfi-${todayStat.pfi}`;
        el.kpiPfiTag.textContent = `${todayStat.pfi} Fatigue`;
      }
      if (el.kpiPfiReason) el.kpiPfiReason.textContent = todayStat.pfi_reason || 'Healthy alignment observed.';
    }

    // Alerts
    if (state.allAlerts.length > 0) {
      if (el.kpiAlerts) el.kpiAlerts.textContent = state.allAlerts.length;
      const recoveries = state.allAlerts
        .map((a) => a.recovery_time_s)
        .filter((s) => typeof s === 'number' && s > 0);

      if (recoveries.length > 0) {
        const avgRec = Math.round(recoveries.reduce((a, b) => a + b, 0) / recoveries.length);
        if (el.kpiRecovery) el.kpiRecovery.innerHTML = `${avgRec}<span style="font-size: 1rem; color: var(--text-muted);">s</span>`;
      } else {
        if (el.kpiRecovery) el.kpiRecovery.textContent = '--';
      }
    } else {
      if (el.kpiAlerts) el.kpiAlerts.textContent = '0';
      if (el.kpiRecovery) el.kpiRecovery.textContent = '--';
    }
  } catch (err) {
    console.warn('Error in updateKpis:', err);
  }
}

// 4 & 5. Update Charts
async function updateCharts() {
  try {
    const isDark = state.theme === 'dark';

    if (!chartModule) {
      try {
        chartModule = await import('./charts.js');
      } catch {
        return;
      }
    }

    // Today's Hourly Timeline
    if (!state.todayReadings || state.todayReadings.length === 0) {
      if (el.timelineEmptyState) el.timelineEmptyState.style.display = 'block';
      if (el.timelineFootnote) el.timelineFootnote.textContent = 'No readings recorded today';
    } else {
      if (el.timelineEmptyState) el.timelineEmptyState.style.display = 'none';
      if (el.timelineFootnote) el.timelineFootnote.textContent = `Aggregated from ${state.todayReadings.length} stored telemetry readings`;

      const hourly = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        good_min: 0,
        warning_min: 0,
        bad_min: 0,
        gap_min: 0,
      }));

      // Sort chronologically to detect > 60s gaps
      const sorted = [...state.todayReadings].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i];
        const hour = new Date(cur.ts).getUTCHours();
        let diffSec = 10;
        if (i < sorted.length - 1) {
          const next = sorted[i + 1];
          diffSec = (new Date(next.ts).getTime() - new Date(cur.ts).getTime()) / 1000;
        }

        if (hour >= 0 && hour < 24) {
          if (diffSec > 60) {
            // Count gap as "no data" separate grey segment
            hourly[hour].gap_min += Math.min(60, Math.round(diffSec / 60));
          } else {
            const durationMin = Math.round(diffSec / 60 * 10) / 10 || 0.2;
            if (cur.state === 'good') hourly[hour].good_min += durationMin;
            else if (cur.state === 'warning') hourly[hour].warning_min += durationMin;
            else if (cur.state === 'bad') hourly[hour].bad_min += durationMin;
          }
        }
      }

      hourly.forEach((h) => {
        h.good_min = Math.min(60, Math.round(h.good_min));
        h.warning_min = Math.min(60, Math.round(h.warning_min));
        h.bad_min = Math.min(60, Math.round(h.bad_min));
        h.gap_min = Math.min(60, Math.round(h.gap_min));
      });

      if (chartModule?.renderTimelineChart) {
        chartModule.renderTimelineChart('timeline-chart', hourly, isDark);
      }
    }

    // Weekly Trend
    if (!state.dailyStats || state.dailyStats.length === 0) {
      if (el.weeklyEmptyState) el.weeklyEmptyState.style.display = 'block';
      if (el.weeklyFootnote) el.weeklyFootnote.textContent = 'No historical daily_stats records available';
    } else {
      if (el.weeklyEmptyState) el.weeklyEmptyState.style.display = 'none';
      if (el.weeklyFootnote) el.weeklyFootnote.textContent = `Plotting ${state.dailyStats.length} verified daily summary record${state.dailyStats.length === 1 ? '' : 's'}`;
      if (chartModule?.renderWeeklyTrendChart) {
        chartModule.renderWeeklyTrendChart('weekly-chart', state.dailyStats, isDark);
      }
    }
  } catch (err) {
    console.warn('Error in updateCharts:', err);
  }
}

// 6. Update Alerts Table
function updateAlertsTable() {
  try {
    const filter = el.alertsFilter?.value || 'week';
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const yesterdayDate = new Date(now.getTime() - 86400000);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

    let filtered = [...state.allAlerts];
    if (filter === 'today') {
      filtered = filtered.filter((a) => a.ts.startsWith(todayStr));
    } else if (filter === 'yesterday') {
      filtered = filtered.filter((a) => a.ts.startsWith(yesterdayStr));
    }

    filtered.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    if (filtered.length === 0) {
      if (el.alertsTbody) el.alertsTbody.innerHTML = `<tr><td colspan="5" class="empty-state">No alerts recorded by device for this period.</td></tr>`;
      if (el.alertsFootnote) el.alertsFootnote.textContent = 'No hardware alerts logged';
      return;
    }

    if (el.alertsFootnote) el.alertsFootnote.textContent = `Showing ${filtered.length} verified hardware alert${filtered.length === 1 ? '' : 's'}`;

    if (el.alertsTbody) {
      el.alertsTbody.innerHTML = filtered
        .slice(0, 50)
        .map((a) => {
          const timeStr = new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const dateStr = new Date(a.ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
          const levelIcon = a.level === 'buzzer' ? '🔔 Buzzer' : '📳 Vibration';
          const reasonLabel = a.reason ? a.reason.replace('_', ' ') : 'Slouch';

          return `
            <tr>
              <td><span style="font-weight: 600;">${timeStr}</span> <span style="font-size: 0.75rem; color: var(--text-muted);">${dateStr}</span></td>
              <td><span class="level-icon">${levelIcon}</span></td>
              <td>${a.duration_s || 10}s</td>
              <td style="text-transform: capitalize;">${reasonLabel}</td>
              <td>${a.recovery_time_s ? `${a.recovery_time_s}s` : '--'}</td>
            </tr>
          `;
        })
        .join('');
    }
  } catch (err) {
    console.warn('Error in updateAlertsTable:', err);
  }
}

// 7. Update Insights & Suggestions
function updateInsights(insightsData) {
  try {
    if (!insightsData || !insightsData.summary) {
      if (el.insightsSummary) el.insightsSummary.textContent = 'Not enough data for AI insights yet. Requires at least 1 day of posture data.';
      if (el.insightsFatigue) el.insightsFatigue.style.display = 'none';
      if (el.insightsSourceTag) el.insightsSourceTag.style.display = 'none';
      if (el.suggestionsGrid) el.suggestionsGrid.innerHTML = `<div class="empty-state">No recommendations triggered by current data.</div>`;
      return;
    }

    if (el.insightsSummary) el.insightsSummary.textContent = insightsData.summary;
    if (insightsData.fatigue_explanation) {
      if (el.insightsFatigue) {
        el.insightsFatigue.style.display = 'block';
        el.insightsFatigue.textContent = insightsData.fatigue_explanation;
      }
    } else {
      if (el.insightsFatigue) el.insightsFatigue.style.display = 'none';
    }

    if (el.insightsSourceTag) {
      el.insightsSourceTag.style.display = 'inline-flex';
      el.insightsSourceTag.textContent = insightsData.source === 'gemini' ? 'Gemini AI' : 'Rule-Based';
    }

    const dateRangeStr = insightsData.date_range ? ` · Date range: ${insightsData.date_range}` : '';
    if (el.insightsFootnote) el.insightsFootnote.textContent = `Source: ${insightsData.source === 'gemini' ? 'Gemini AI' : 'Rule-based'}${dateRangeStr}`;

    const suggestions = insightsData.suggestions || [];
    if (suggestions.length === 0) {
      if (el.suggestionsGrid) el.suggestionsGrid.innerHTML = `<div class="empty-state">No active posture recommendations for this period.</div>`;
      return;
    }

    if (el.suggestionsGrid) {
      el.suggestionsGrid.innerHTML = suggestions
        .map(
          (s) => `
          <div class="suggestion-card ${s.severity || 'info'}">
            <div>${s.text}</div>
            ${s.evidence ? `<div class="recommendation-evidence">Evidence: ${s.evidence}</div>` : ''}
            <span class="suggestion-tag">${(s.severity || 'info').toUpperCase()}</span>
          </div>
        `
        )
        .join('');
    }
  } catch (err) {
    console.warn('Error in updateInsights:', err);
  }
}

// 8. Settings & Real CSV Export
function setupSettings() {
  if (state.device && typeof state.device.baseline_angle === 'number') {
    el.settingBaseline.value = `${state.device.baseline_angle.toFixed(1)}° (hardware button calibrated)`;
  } else {
    el.settingBaseline.value = 'Not calibrated, press the device button';
  }

  if (state.device) {
    el.settingWarnDeg.value = state.device.warn_deg || 15;
    el.settingBadDeg.value = state.device.bad_deg || 25;
    el.settingAlertDelay.value = state.device.alert_delay_s || 10;
  }

  el.saveSettingsBtn.addEventListener('click', async () => {
    if (!state.device) return;
    state.device.warn_deg = Number(el.settingWarnDeg.value);
    state.device.bad_deg = Number(el.settingBadDeg.value);
    state.device.alert_delay_s = Number(el.settingAlertDelay.value);

    try {
      await supabase
        .from('devices')
        .update({
          warn_deg: state.device.warn_deg,
          bad_deg: state.device.bad_deg,
          alert_delay_s: state.device.alert_delay_s,
        })
        .eq('id', state.device.id);
    } catch {}

    el.saveSettingsBtn.textContent = 'Saved!';
    setTimeout(() => {
      el.saveSettingsBtn.textContent = 'Save Thresholds';
    }, 1500);
  });

  el.exportCsvBtn.addEventListener('click', () => {
    if (state.todayReadings.length === 0) {
      alert('No posture readings recorded yet to export.');
      return;
    }
    const headers = ['ts', 'received_at', 'angle', 'state', 'movement'];
    const rows = state.todayReadings.map((r) => [r.ts, r.received_at || r.ts, r.angle, r.state, r.movement]);
    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `smartposture_telemetry_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  el.themeToggleBtn.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  el.alertsFilter.addEventListener('change', () => {
    updateAlertsTable();
  });

  el.refreshInsightsBtn.addEventListener('click', async () => {
    if (!state.device) return;
    el.refreshBtnText.textContent = 'Refreshing...';
    try {
      const { data, error } = await supabase.functions.invoke('insights', {
        body: { device_id: state.device.id, force: true },
      });
      if (!error && data?.insights) {
        updateInsights(data.insights);
      }
    } catch (e) {
      console.warn('Insights function invoke error:', e);
    } finally {
      el.refreshBtnText.textContent = 'Refresh Insights';
    }
  });
}

// Supabase Auth Handling
async function setupAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    state.user = session.user;
    el.authStatusText.textContent = `User: ${session.user.email}`;
    el.authControls.innerHTML = `<button id="auth-signout-btn" class="btn" style="padding: 0.3rem 0.6rem;">Sign Out</button>`;
    document.getElementById('auth-signout-btn').addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.reload();
    });
  }

  el.authSubmitBtn?.addEventListener('click', async () => {
    const email = el.authEmailInput.value.trim();
    if (!email) return;
    el.authSubmitBtn.textContent = 'Sending...';
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) {
      alert(`Sign in error: ${error.message}`);
      el.authSubmitBtn.textContent = 'Sign In';
    } else {
      alert(`Magic login link sent to ${email}`);
      el.authSubmitBtn.textContent = 'Check Email';
    }
  });
}

// Load Strictly Stored Rows from Database
async function loadData() {
  try {
    // 1. Fetch real device row
    const { data: dev } = await supabase.from('devices').select('*').limit(1).single();
    if (dev) {
      state.device = dev;
    }

    // 2. Fetch real daily_stats
    const { data: stats } = await supabase
      .from('daily_stats')
      .select('*')
      .order('date', { ascending: true })
      .limit(7);

    if (stats) {
      state.dailyStats = stats;
    }

    // 3. Fetch real alerts
    const { data: alerts } = await supabase
      .from('alerts')
      .select('*')
      .order('ts', { ascending: false })
      .limit(100);

    if (alerts) {
      state.allAlerts = alerts;
    }

    // 4. Fetch real recommendations
    const { data: recs } = await supabase
      .from('recommendations')
      .select('*')
      .order('ts', { ascending: false })
      .limit(10);

    if (recs) {
      state.recommendations = recs;
    }

    // 5. Fetch real posture readings
    const today = new Date().toISOString().split('T')[0];
    const { data: readings } = await supabase
      .from('posture_readings')
      .select('*')
      .gte('ts', `${today}T00:00:00.000Z`)
      .order('ts', { ascending: false })
      .limit(500);

    if (readings && readings.length > 0) {
      state.todayReadings = readings;
      state.liveReading = readings[0];
    }

    // 6. Check for calibration event
    const { data: events } = await supabase
      .from('events')
      .select('ts, angle')
      .eq('type', 'calibration')
      .order('ts', { ascending: false })
      .limit(1);

    if (events && events.length > 0) {
      state.lastCalibrationTime = `${new Date(events[0].ts).toLocaleDateString()}, ${new Date(events[0].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  } catch (err) {
    console.warn('Database query notice:', err.message);
  }

  // Render UI with real data only
  updateHeader();
  updateLiveCard();
  updateKpis();
  updateAlertsTable();

  // Lazy render charts
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(() => updateCharts());
  } else {
    setTimeout(updateCharts, 100);
  }

  // Populate recommendations if real recommendations exist
  if (state.recommendations.length > 0) {
    const summaryRec = state.recommendations.find((r) => r.text?.startsWith('Summary:'));
    const suggestionsList = state.recommendations
      .filter((r) => !r.text?.startsWith('Summary:') && !r.text?.startsWith('Fatigue:'))
      .map((r) => ({ text: r.text, severity: r.severity, evidence: r.evidence }));

    updateInsights({
      summary: summaryRec ? summaryRec.text.replace(/^Summary:\s*/, '') : '',
      fatigue_explanation: '',
      suggestions: suggestionsList,
      source: summaryRec?.source === 'gemini' ? 'gemini' : 'rule',
    });
  } else {
    updateInsights(null);
  }
}

// Realtime Telemetry Listener (Real Supabase Push Only)
function setupRealtime() {
  try {
    supabase
      .channel('posture_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'posture_readings' },
        (payload) => {
          if (payload.new) {
            state.liveReading = payload.new;
            if (state.device) {
              state.device.last_seen = payload.new.ts;
            }
            state.todayReadings.unshift(payload.new);
            updateHeader();
            updateLiveCard();
            updateKpis();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'devices' },
        (payload) => {
          if (payload.new) {
            state.device = { ...state.device, ...payload.new };
            updateHeader();
            updateLiveCard();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'events' },
        (payload) => {
          if (payload.new && payload.new.type === 'calibration') {
            state.lastCalibrationTime = 'Just now';
            if (state.device && payload.new.angle !== null) {
              state.device.baseline_angle = payload.new.angle;
            }
            updateLiveCard();
          }
        }
      )
      .subscribe((status) => {
        el.liveSyncIndicator.textContent = status === 'SUBSCRIBED' ? 'Realtime Connected' : status;
      });
  } catch {}

  // Duration timer ticker and fast live-sync polling every second
  setInterval(async () => {
    if (state.liveReading) {
      state.stateDurationSec++;
      el.liveTimer.textContent = formatDuration(state.stateDurationSec);
    }

    // Active 1-second heartbeat: fetch the absolute latest reading so the screen never lags behind
    try {
      const { data: latest } = await supabase
        .from('posture_readings')
        .select('*')
        .order('id', { ascending: false })
        .limit(1)
        .single();

      if (latest && (!state.liveReading || latest.id !== state.liveReading.id)) {
        state.liveReading = latest;
        if (state.device) {
          state.device.last_seen = latest.ts;
        }
        updateHeader();
        updateLiveCard();
        updateKpis();
      }
    } catch {}
  }, 1000);
}

// Initialization Entrypoint
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(state.theme);
  setupSettings();
  setupAuth();
  await loadData();
  setupRealtime();
});
