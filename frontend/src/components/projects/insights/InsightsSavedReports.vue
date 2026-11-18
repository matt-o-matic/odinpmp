<script setup>
import { RouterLink } from 'vue-router';

import { VISUALIZATION_LABELS, deliveryLabel, formatDateTime, reportsLocation } from '../../../lib/insights/insights-format.js';

// The project's saved reports. Building, scheduling and exporting stay in Reports; adding a
// report to this dashboard (edit mode) shows its results as a card that runs on its own.

defineProps({
  projectId: { required: true, type: String },
  reports: { required: true, type: Array },
});
</script>

<template>
  <p v-if="reports.length === 0" class="insights-card__empty-line">
    No saved reports for this project yet.
    <RouterLink :to="reportsLocation(projectId)">Build one in Reports</RouterLink>.
  </p>
  <div v-else class="insights-table" tabindex="0" role="region" aria-label="Saved reports for this project">
    <table class="table table-sm">
      <thead>
        <tr>
          <th scope="col">Report</th>
          <th scope="col">Dataset</th>
          <th scope="col">Shown as</th>
          <th scope="col">Your delivery</th>
          <th scope="col">Last run</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="report in reports" :key="report.id">
          <td>
            <RouterLink :to="reportsLocation(projectId)">{{ report.name }}</RouterLink>
            <span v-if="!report.projectScoped" class="insights-badge">Tenant</span>
            <span v-if="report.status === 'inactive'" class="insights-badge">Inactive</span>
          </td>
          <td>{{ report.dataset.replaceAll('_', ' ') }}</td>
          <td>{{ VISUALIZATION_LABELS[report.visualization] ?? report.visualization }}</td>
          <td>{{ deliveryLabel(report.delivery) }}</td>
          <td>{{ report.lastRunAt ? formatDateTime(report.lastRunAt) : 'Not run yet' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
