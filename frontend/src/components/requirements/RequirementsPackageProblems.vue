<script setup>
// Validation problems for a package upload (package-spec.md section 7). Each one shows what
// the code means in plain words, Odin's own message, and where it is: the file and, for the
// manifest, the JSON Pointer to the field.
defineProps({
  // Described problems from describePackageProblem().
  errors: { default: () => [], type: Array },
  headingTag: { default: 'h4', type: String },
  summary: { default: '', type: String },
  warnings: { default: () => [], type: Array },
});
</script>

<template>
  <div class="rq-problems rq-stack rq-stack--sm">
    <p v-if="summary" class="rq-small mb-0"><strong>{{ summary }}</strong></p>

    <template v-if="errors.length">
      <component :is="headingTag" class="rq-eyebrow">Problems · {{ errors.length }}</component>
      <ol class="rq-problems__list">
        <li v-for="(problem, index) in errors" :key="`error-${index}`" class="rq-problem">
          <i class="bi bi-x-circle-fill rq-problem__icon rq-problem__icon--error" aria-hidden="true"></i>
          <div class="rq-problem__body">
            <p class="rq-problem__meaning">{{ problem.meaning }}</p>
            <p v-if="problem.message" class="rq-small mb-0">{{ problem.message }}</p>
            <p class="rq-xs rq-muted mb-0">
              <template v-if="problem.location.file || problem.location.path">
                <span v-if="problem.location.file">In <code>{{ problem.location.file }}</code></span>
                <span v-if="problem.location.path"><template v-if="problem.location.file"> at </template><template v-else>At </template><code>{{ problem.location.path }}</code></span>
              </template>
              <span v-else>{{ problem.location.text }}</span>
              <span v-if="problem.code"> · code <code>{{ problem.code }}</code></span>
            </p>
          </div>
        </li>
      </ol>
    </template>

    <template v-if="warnings.length">
      <component :is="headingTag" class="rq-eyebrow">Warnings · {{ warnings.length }}</component>
      <ul class="rq-problems__list">
        <li v-for="(problem, index) in warnings" :key="`warning-${index}`" class="rq-problem">
          <i class="bi bi-exclamation-triangle-fill rq-problem__icon rq-problem__icon--warn" aria-hidden="true"></i>
          <div class="rq-problem__body">
            <p class="rq-problem__meaning">{{ problem.meaning }}</p>
            <p v-if="problem.message" class="rq-small mb-0">{{ problem.message }}</p>
            <p class="rq-xs rq-muted mb-0">
              <template v-if="problem.location.file || problem.location.path">
                <span v-if="problem.location.file">In <code>{{ problem.location.file }}</code></span>
                <span v-if="problem.location.path"><template v-if="problem.location.file"> at </template><template v-else>At </template><code>{{ problem.location.path }}</code></span>
              </template>
              <span v-else>{{ problem.location.text }}</span>
              <span v-if="problem.code"> · code <code>{{ problem.code }}</code></span>
            </p>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
