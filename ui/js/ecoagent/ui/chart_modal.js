/**
 * chart_modal.js — open a modal containing a single line chart.
 *
 * Used by the SFC page for per-account drill-down. Built on
 * `openModal` so chrome / Esc / focus trap match the rest of the app;
 * the caller doesn't have to wire any of that.
 */

import { openModal } from './modal.js';
import { renderLineChart } from './charts.js';


export function openChartModal({ title, subtitle = '', series } = {}) {
    const content = document.createElement('div');
    content.className = 'ea-chart-modal__content';
    if (subtitle) {
        const sub = document.createElement('p');
        sub.className = 'ea-modal__hint';
        sub.textContent = subtitle;
        content.appendChild(sub);
    }
    const host = document.createElement('div');
    host.className = 'ea-chart-modal__host';
    content.appendChild(host);

    return openModal({
        title: String(title || 'Chart'),
        icon:  'show_chart',
        content,
        width:  780,
        height: 420,
        onMount: () => {
            const rect = host.getBoundingClientRect();
            renderLineChart(host, {
                series,
                width:  Math.max(360, rect.width  || 720),
                height: Math.max(180, rect.height || 280),
            });
        },
    });
}
