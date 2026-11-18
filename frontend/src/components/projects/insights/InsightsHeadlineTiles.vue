<script setup>
import { computed } from 'vue';

import { HEALTH_ICONS, HEALTH_LABELS, formatDay, formatMoney, formatNumber, unitLabel } from '../../../lib/insights/insights-format.js';

const props = defineProps({
  data: { required: true, type: Object },
  unit: { default: 'points', type: String },
});

function status(kind, label) {
  return { icon: HEALTH_ICONS[kind] ?? HEALTH_ICONS['on-track'], kind, label: label ?? HEALTH_LABELS[kind] };
}

const tiles = computed(() => {
  const { cost, forecast, risks, scope, sprint, tickets, velocity } = props.data;
  const unit = unitLabel(props.unit);
  const result = [];
  if (forecast) {
    const detail = forecast.method === 'throughput'
      ? [forecast.earliest && forecast.latest ? `Range ${formatDay(forecast.earliest)} – ${formatDay(forecast.latest)}` : '', forecast.criticalPath ? `critical path ${formatDay(forecast.criticalPath)}` : ''].filter(Boolean).join(' · ')
      : 'Critical-path forecast from Governance';
    result.push({
      detail,
      key: 'forecast',
      label: 'Forecast finish',
      status: forecast.target ? status(forecast.late ? 'behind' : 'on-track', `${forecast.late ? 'At risk' : 'On track'} · target ${formatDay(forecast.target)}`) : null,
      value: formatDay(forecast.date),
    });
  }
  if (scope) {
    result.push({
      detail: `${formatNumber(scope.done)} of ${formatNumber(scope.scope)} ${unit}${scope.added ? ` · ${scope.added > 0 ? '+' : '−'}${formatNumber(Math.abs(scope.added))} since ${formatDay(scope.since)}` : ''}`,
      key: 'scope',
      label: 'Scope complete',
      status: null,
      value: `${scope.percent}%`,
    });
  }
  if (sprint) {
    result.push({
      detail: `Day ${sprint.dayOfSprint} of ${sprint.sprintDays} · ${formatNumber(Math.max(0, sprint.committed - sprint.done))} ${sprint.unit === 'items' ? 'items' : 'pts'} left`,
      key: 'sprint',
      label: sprint.name,
      status: status(sprint.kind, sprint.kind === 'behind' ? 'Behind ideal' : sprint.kind === 'watch' ? 'Slipping' : 'On pace'),
      value: `${formatNumber(sprint.done)} / ${formatNumber(sprint.committed)} ${sprint.unit === 'items' ? 'items' : 'pts'}`,
    });
  } else {
    result.push({ detail: 'No active sprint', key: 'sprint', label: 'Sprint', status: null, value: '—' });
  }
  if (velocity) {
    result.push({
      detail: `Average of last ${velocity.sprintCount} sprint${velocity.sprintCount === 1 ? '' : 's'} · range ${formatNumber(velocity.min)}–${formatNumber(velocity.max)}`,
      key: 'velocity',
      label: 'Velocity',
      status: null,
      value: `${formatNumber(velocity.average)} ${unit}`,
    });
  }
  result.push({
    detail: tickets.open ? `${tickets.s1} S1 · ${tickets.s2} S2` : 'No open tickets',
    key: 'tickets',
    label: 'Open tickets',
    status: tickets.s1 > 0 ? status('behind', `${tickets.s1} S1 open`) : tickets.open === 0 ? status('on-track', 'None open') : null,
    value: formatNumber(tickets.open),
  });
  result.push({
    detail: risks.open ? 'In the Governance register' : 'No open risks',
    key: 'risks',
    label: 'Open risks',
    status: risks.critical > 0 ? status('behind', `${risks.critical} critical`) : null,
    value: formatNumber(risks.open),
  });
  if (cost) {
    const cpi = Number(cost.cpi);
    result.push({
      detail: `EAC ${formatMoney(cost.eac, cost.currency, { compact: true })} vs budget ${formatMoney(cost.budget, cost.currency, { compact: true })}`,
      key: 'cost',
      label: 'Cost performance',
      status: Number.isFinite(cpi) ? status(cpi < 1 ? 'watch' : 'on-track', cpi < 1 ? 'Over budget pace' : 'Within budget pace') : null,
      value: Number.isFinite(cpi) ? `${cpi.toFixed(2)} CPI` : '—',
    });
  }
  return result;
});
</script>

<template>
  <ul class="insights-tiles">
    <li v-for="tile in tiles" :key="tile.key" class="insights-tile" :data-tile="tile.key">
      <p class="insights-tile__label">{{ tile.label }}</p>
      <p class="insights-tile__value">{{ tile.value }}</p>
      <p v-if="tile.status" class="insights-tile__status" :class="`insights-status--${tile.status.kind}`">
        <i class="bi" :class="tile.status.icon" aria-hidden="true"></i>
        {{ tile.status.label }}
      </p>
      <p class="insights-tile__detail">{{ tile.detail }}</p>
    </li>
  </ul>
</template>
