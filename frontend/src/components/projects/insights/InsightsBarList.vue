<script setup>
import { computed } from 'vue';

import { formatNumber } from '../../../lib/insights/insights-format.js';

// Horizontal bars with the label and value printed beside each, so the list reads without
// colour or a table view. Rows: { key, label, value, detail? }.

const props = defineProps({
  caption: { required: true, type: String },
  rows: { required: true, type: Array },
  valueFormatter: { default: (value) => formatNumber(value), type: Function },
});

const max = computed(() => Math.max(1, ...props.rows.map((row) => Number(row.value) || 0)));
</script>

<template>
  <table class="insights-bars">
    <caption class="visually-hidden">{{ caption }}</caption>
    <tbody>
      <tr v-for="row in rows" :key="row.key">
        <th scope="row">{{ row.label }}</th>
        <td class="insights-bars__track" aria-hidden="true">
          <span class="insights-bars__bar" :style="{ width: `${Math.max(Number(row.value) > 0 ? 2 : 0, (Number(row.value) / max) * 100)}%` }"></span>
        </td>
        <td class="insights-bars__value">
          {{ valueFormatter(row.value) }}
          <small v-if="row.detail">{{ row.detail }}</small>
        </td>
      </tr>
    </tbody>
  </table>
</template>
