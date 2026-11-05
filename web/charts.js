// web/charts.js
// Chart.js visualizations for Today's Timeline and Weekly Trend - Real Data Only

import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';

// Register Chart.js components
Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend
);

let timelineChartInstance = null;
let weeklyChartInstance = null;

export function renderTimelineChart(canvasId, hourlyData, isDark = true) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  if (timelineChartInstance) {
    timelineChartInstance.destroy();
    timelineChartInstance = null;
  }

  const textColor = isDark ? '#94a3b8' : '#475569';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

  // If no readings at all, leave empty
  if (!hourlyData || hourlyData.length === 0 || !hourlyData.some(h => (h.good_min + h.warning_min + h.bad_min + (h.gap_min || 0)) > 0)) {
    return;
  }

  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const goodData = Array(24).fill(0);
  const warnData = Array(24).fill(0);
  const badData = Array(24).fill(0);
  const gapData = Array(24).fill(0);

  hourlyData.forEach((h) => {
    const idx = parseInt(h.hour, 10);
    if (idx >= 0 && idx < 24) {
      goodData[idx] = h.good_min || 0;
      warnData[idx] = h.warning_min || 0;
      badData[idx] = h.bad_min || 0;
      gapData[idx] = h.gap_min || 0; // Gaps (>60s) counted as "no data" separate grey segment
    }
  });

  timelineChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Good Posture',
          data: goodData,
          backgroundColor: '#10b981',
          stack: 'posture',
          borderRadius: 2,
        },
        {
          label: 'Warning',
          data: warnData,
          backgroundColor: '#f59e0b',
          stack: 'posture',
          borderRadius: 2,
        },
        {
          label: 'Bad Posture',
          data: badData,
          backgroundColor: '#ef4444',
          stack: 'posture',
          borderRadius: 2,
        },
        {
          label: 'No Data / Gap',
          data: gapData,
          backgroundColor: isDark ? '#334155' : '#cbd5e1',
          stack: 'posture',
          borderRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${item.raw} min`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { display: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: 60,
          ticks: { color: textColor, stepSize: 15 },
          grid: { color: gridColor },
          title: { display: true, text: 'Minutes / Hour', color: textColor, font: { size: 10 } },
        },
      },
    },
  });
}

export function renderWeeklyTrendChart(canvasId, statsList, isDark = true) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  if (weeklyChartInstance) {
    weeklyChartInstance.destroy();
    weeklyChartInstance = null;
  }

  // If no stats or empty, do not render synthetic points
  if (!statsList || statsList.length === 0) {
    return;
  }

  const textColor = isDark ? '#94a3b8' : '#475569';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

  const sortedStats = [...statsList].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sortedStats.map((s) => {
    const d = new Date(s.date + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
  });
  
  // Real scores only - if status is insufficient_data, null
  const scores = sortedStats.map((s) => s.status === 'insufficient_data' ? null : s.posture_score);
  const alerts = sortedStats.map((s) => s.alert_count ?? 0);

  weeklyChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: 'Posture Score',
          data: scores,
          borderColor: '#0ea5e9',
          backgroundColor: '#0ea5e9',
          borderWidth: 3,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
          yAxisID: 'yScore',
          spanGaps: false,
        },
        {
          type: 'bar',
          label: 'Alerts',
          data: alerts,
          backgroundColor: isDark ? 'rgba(239, 68, 68, 0.45)' : 'rgba(220, 38, 38, 0.35)',
          borderColor: '#ef4444',
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'yAlerts',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, boxWidth: 12, font: { size: 11 } },
        },
      },
      scales: {
        x: {
          ticks: { color: textColor },
          grid: { display: false },
        },
        yScore: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          max: 100,
          ticks: { color: textColor, stepSize: 20 },
          grid: { color: gridColor },
          title: { display: true, text: 'Score (0-100)', color: textColor, font: { size: 10 } },
        },
        yAlerts: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          ticks: { color: textColor, precision: 0 },
          grid: { display: false },
          title: { display: true, text: 'Alert Count', color: textColor, font: { size: 10 } },
        },
      },
    },
  });
}
