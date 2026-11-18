<script setup>
// The table view behind every chart: the same numbers, readable without the drawing.
defineProps({
  caption: { required: true, type: String },
  columns: { required: true, type: Array },
  rows: { required: true, type: Array },
});
</script>

<template>
  <div class="insights-table" tabindex="0" role="region" :aria-label="caption">
    <table class="table table-sm">
      <caption class="visually-hidden">{{ caption }}</caption>
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.key" scope="col" :class="{ 'text-end': column.numeric }">{{ column.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="row.key ?? index">
          <td v-for="column in columns" :key="column.key" :class="{ 'text-end': column.numeric }">{{ row[column.key] ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
