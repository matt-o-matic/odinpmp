<script setup>
import { computed, nextTick, onMounted, reactive, ref, toRaw } from 'vue';

import { apiClient, authSession } from '../lib/auth/index.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';

const emptyWorkspace = () => ({ alignments: [], analysis: { comparisons: [] }, baselines: [], canApprove: false, canManage: false, nodes: [], objectives: [], plans: [], projects: [], total: 0 });
const workspace = ref(emptyWorkspace());
const loading = ref(true); const errorMessage = ref(''); const activeTab = ref('hierarchy');
const filters = reactive({ limit: 25, offset: 0, query: '', sort: 'name', status: '' });
const editor = reactive({ kind: '', mode: 'create', recordId: '', values: {} });
const deleteTarget = reactive({ kind: '', id: '', title: '', version: 0 });
const editorDialog = ref(null); const deleteDialog = ref(null);

const token = computed(() => authSession.state.token);
const nodeMap = computed(() => new Map(workspace.value.nodes.map((node) => [node.id, node])));
const objectiveMap = computed(() => new Map(workspace.value.objectives.map((objective) => [objective.id, objective])));
const projectMap = computed(() => new Map(workspace.value.projects.map((project) => [project.id, project])));
const pages = computed(() => Math.max(1, Math.ceil(workspace.value.total / filters.limit)));
const page = computed(() => Math.floor(filters.offset / filters.limit) + 1);
const totalProjects = computed(() => new Set(workspace.value.alignments.map((item) => item.projectId)).size);
const atRiskProjects = computed(() => workspace.value.projects.filter((project) => /risk|blocked/i.test(project.status ?? '')).length);
const activeObjectives = computed(() => workspace.value.objectives.filter((objective) => objective.status === 'active').length);

// `quiet` reloads after someone else's change: the page stays as it is while it loads, and on
// failure. The latest load wins, so a reload never overwrites newer filters or another page.
let loadSequence = 0;
async function loadWorkspace({ quiet = false } = {}) {
  const sequence = ++loadSequence;
  if (!quiet) { loading.value = true; errorMessage.value = ''; }
  try { const result = await (quiet ? apiClient.passive : apiClient).getPortfolioWorkspace(filters, token.value); if (sequence === loadSequence) workspace.value = { ...emptyWorkspace(), ...result, analysis: { comparisons: [], ...(result.analysis ?? {}) } }; }
  catch (error) { if (!quiet && sequence === loadSequence) errorMessage.value = error.message ?? 'Unable to load portfolio workspace.'; }
  finally { if (!quiet && sequence === loadSequence) loading.value = false; }
}

function blank(kind) {
  if (kind === 'node') return { description: '', governanceStage: 'intake', kind: 'portfolio', name: '', ownerId: null, parentId: null, sponsorId: null, status: 'active' };
  if (kind === 'objective') return { currentValue: 0, description: '', kind: 'objective', parentId: null, status: 'active', targetValue: 100, title: '', unit: 'percent', weight: 1 };
  if (kind === 'plan') return { decisionNote: '', fundingCurrency: 'USD', fundingLimit: 0, name: '', portfolioNodeId: workspace.value.nodes.find((item) => item.kind === 'portfolio')?.id ?? workspace.value.nodes[0]?.id ?? '', resourceHoursLimit: 0, scenario: 'baseline', status: 'draft' };
  if (kind === 'baseline') return { name: '', portfolioNodeId: workspace.value.nodes.find((item) => item.kind === 'portfolio')?.id ?? workspace.value.nodes[0]?.id ?? '', scenario: 'baseline' };
  return { benefitUnit: 'USD', benefitValue: 0, costScore: 0, demandStatus: 'candidate', fundingCurrency: 'USD', objectiveId: null, portfolioNodeId: workspace.value.nodes[0]?.id ?? '', projectId: workspace.value.projects[0]?.id ?? '', requestedFunding: 0, requestedHours: 0, riskScore: 0, scenario: 'baseline', strategicScore: 0 };
}

async function openEditor(kind, record = null) {
  editor.kind = kind; editor.mode = record ? 'edit' : 'create'; editor.recordId = record?.id ?? '';
  editor.values = record ? structuredClone(toRaw(record)) : blank(kind);
  await nextTick(); editorDialog.value?.showModal();
}
function closeEditor() { editorDialog.value?.close(); }

async function saveEditor() {
  errorMessage.value = '';
  try {
    const values = { ...editor.values };
    delete values.createdAt; delete values.updatedAt; delete values.tenantId; delete values.id; delete values.rollup; delete values.progressPercent;
    if (editor.mode === 'edit') values.expectedVersion = editor.values.version;
    delete values.version;
    if (values.fundingCurrency) values.fundingCurrency = String(values.fundingCurrency).toUpperCase();
    if (editor.kind === 'node') editor.mode === 'edit' ? await apiClient.updatePortfolioNode(editor.recordId, values, token.value) : await apiClient.createPortfolioNode(values, token.value);
    if (editor.kind === 'objective') editor.mode === 'edit' ? await apiClient.updateStrategyObjective(editor.recordId, values, token.value) : await apiClient.createStrategyObjective(values, token.value);
    if (editor.kind === 'alignment') editor.mode === 'edit' ? await apiClient.updatePortfolioAlignment(editor.recordId, values, token.value) : await apiClient.createPortfolioAlignment(values, token.value);
    if (editor.kind === 'plan') editor.mode === 'edit' ? await apiClient.updatePortfolioPlan(editor.recordId, values, token.value) : await apiClient.createPortfolioPlan(values, token.value);
    if (editor.kind === 'baseline') await apiClient.capturePortfolioBaseline(values, token.value);
    closeEditor(); await loadWorkspace();
  } catch (error) { errorMessage.value = error.message ?? 'Unable to save portfolio record.'; }
}

async function openDelete(kind, record, title) { Object.assign(deleteTarget, { kind, id: record.id, title, version: record.version }); await nextTick(); deleteDialog.value?.showModal(); }
async function deleteRecord() {
  try {
    if (deleteTarget.kind === 'node') await apiClient.deletePortfolioNode(deleteTarget.id, deleteTarget.version, token.value);
    if (deleteTarget.kind === 'objective') await apiClient.deleteStrategyObjective(deleteTarget.id, deleteTarget.version, token.value);
    if (deleteTarget.kind === 'alignment') await apiClient.deletePortfolioAlignment(deleteTarget.id, deleteTarget.version, token.value);
    if (deleteTarget.kind === 'plan') await apiClient.deletePortfolioPlan(deleteTarget.id, deleteTarget.version, token.value);
    deleteDialog.value?.close(); await loadWorkspace();
  } catch (error) { errorMessage.value = error.message ?? 'Unable to delete portfolio record.'; deleteDialog.value?.close(); }
}

function benefitText(benefits = {}) { const entries = Object.entries(benefits); return entries.length ? entries.map(([unit, value]) => `${Number(value).toLocaleString()} ${unit}`).join(', ') : '—'; }
function applyFilters() { filters.offset = 0; loadWorkspace(); }
function changePage(direction) { filters.offset = Math.max(0, Math.min((pages.value - 1) * filters.limit, filters.offset + direction * filters.limit)); loadWorkspace(); }
onMounted(() => loadWorkspace());
// Project status, dates and health changed elsewhere, by people, the assistant or MCP clients.
useWorkspaceLiveRefresh(['projects'], () => {
  if (!loading.value) loadWorkspace({ quiet: true });
});
</script>

<template>
  <main class="portfolio-page">
    <header class="portfolio-header">
      <div><h1>Portfolio & strategy</h1><p>Programs, objectives, demand scenarios, benefits, and permission-aware project rollups.</p></div>
      <div v-if="workspace.canManage" class="header-actions">
        <button class="btn btn-sm btn-outline-primary" type="button" @click="openEditor('baseline')"><i class="bi bi-camera" aria-hidden="true"></i> Capture baseline</button>
        <button class="btn btn-sm btn-outline-primary" type="button" @click="openEditor('plan')"><i class="bi bi-sliders" aria-hidden="true"></i> Add scenario plan</button>
        <button class="btn btn-sm btn-outline-primary" type="button" @click="openEditor('objective')"><i class="bi bi-bullseye" aria-hidden="true"></i> Add objective</button>
        <button class="btn btn-sm btn-outline-primary" type="button" @click="openEditor('alignment')"><i class="bi bi-link-45deg" aria-hidden="true"></i> Align project</button>
        <button class="btn btn-sm btn-primary" type="button" @click="openEditor('node')"><i class="bi bi-diagram-3" aria-hidden="true"></i> Add node</button>
      </div>
    </header>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
    <section class="portfolio-metrics" aria-label="Portfolio summary">
      <article><span>Portfolio nodes</span><strong>{{ workspace.total }}</strong></article>
      <article><span>Aligned projects</span><strong>{{ totalProjects }}</strong></article>
      <article><span>Active objectives</span><strong>{{ activeObjectives }}</strong></article>
      <article><span>Projects at risk</span><strong>{{ atRiskProjects }}</strong></article>
    </section>

    <form class="portfolio-filters" @submit.prevent="applyFilters">
      <label>Search<input v-model="filters.query" class="form-control form-control-sm" type="search" /></label>
      <label>Status<select v-model="filters.status" class="form-select form-select-sm"><option value="">All</option><option value="active">Active</option><option value="proposed">Proposed</option><option value="on_hold">On hold</option><option value="completed">Completed</option></select></label>
      <label>Sort<select v-model="filters.sort" class="form-select form-select-sm"><option value="name">Name</option><option value="score">Score</option><option value="updatedAt">Recently updated</option></select></label>
      <button class="btn btn-sm btn-outline-secondary" type="submit"><i class="bi bi-funnel" aria-hidden="true"></i> Apply</button>
    </form>

    <nav class="portfolio-tabs" aria-label="Portfolio workspace sections">
      <button v-for="tab in [['hierarchy','Hierarchy'],['strategy','Strategy'],['demand','Demand & scenarios']]" :key="tab[0]" type="button" :class="{ active: activeTab === tab[0] }" @click="activeTab = tab[0]">{{ tab[1] }}</button>
    </nav>

    <p v-if="loading" class="portfolio-empty" role="status">Loading portfolio workspace…</p>
    <template v-else>
      <section v-if="activeTab === 'hierarchy'" aria-labelledby="hierarchy-title"><h2 id="hierarchy-title">Portfolio hierarchy</h2>
        <div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>Name</th><th>Type</th><th>Stage</th><th>Projects</th><th>Score</th><th>Benefits</th><th>Status</th><th v-if="workspace.canManage">Actions</th></tr></thead><tbody>
          <tr v-for="node in workspace.nodes" :key="node.id"><td><strong>{{ node.name }}</strong><small v-if="node.parentId">Under {{ nodeMap.get(node.parentId)?.name ?? 'portfolio' }}</small></td><td>{{ node.kind }}</td><td>{{ node.governanceStage }}</td><td>{{ node.rollup.projectCount }}</td><td>{{ node.rollup.score.toFixed(1) }}</td><td>{{ benefitText(node.rollup.benefits) }}</td><td>{{ node.status }}</td><td v-if="workspace.canManage" class="row-actions"><button aria-label="Edit portfolio node" type="button" @click="openEditor('node', node)"><i class="bi bi-pencil"></i></button><button aria-label="Delete portfolio node" type="button" @click="openDelete('node', node, node.name)"><i class="bi bi-trash"></i></button></td></tr>
          <tr v-if="workspace.nodes.length === 0"><td colspan="8" class="portfolio-empty">No matching portfolio nodes.</td></tr>
        </tbody></table></div>
      </section>
      <section v-if="activeTab === 'strategy'" aria-labelledby="strategy-title"><h2 id="strategy-title">Objectives & key results</h2>
        <div class="objective-grid"><article v-for="objective in workspace.objectives" :key="objective.id"><div><small>{{ objective.kind.replace('_', ' ') }}</small><h3>{{ objective.title }}</h3></div><span>{{ objective.status }}</span><div class="progress" role="progressbar" :aria-label="`${objective.title} progress`" :aria-valuenow="objective.progressPercent" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" :style="{ width: `${objective.progressPercent}%` }"></div></div><p>{{ objective.currentValue.toLocaleString() }} / {{ objective.targetValue.toLocaleString() }} {{ objective.unit }}</p><div v-if="workspace.canManage" class="row-actions"><button aria-label="Edit objective" type="button" @click="openEditor('objective', objective)"><i class="bi bi-pencil"></i></button><button aria-label="Delete objective" type="button" @click="openDelete('objective', objective, objective.title)"><i class="bi bi-trash"></i></button></div></article><p v-if="workspace.objectives.length === 0" class="portfolio-empty">No strategy objectives yet.</p></div>
      </section>
      <section v-if="activeTab === 'demand'" aria-labelledby="demand-title"><h2 id="demand-title">Demand, benefits & scenarios</h2>
        <div class="table-responsive"><table class="table table-sm align-middle"><caption>Project demand</caption><thead><tr><th>Project</th><th>Placement</th><th>Objective</th><th>Demand</th><th>Scenario</th><th>Benefit</th><th>Funding / hours</th><th>Strategic / risk / cost</th><th v-if="workspace.canManage">Actions</th></tr></thead><tbody><tr v-for="alignment in workspace.alignments" :key="alignment.id"><td>{{ projectMap.get(alignment.projectId)?.name ?? alignment.projectId }}</td><td>{{ nodeMap.get(alignment.portfolioNodeId)?.name ?? 'Unknown' }}</td><td>{{ objectiveMap.get(alignment.objectiveId)?.title ?? '—' }}</td><td>{{ alignment.demandStatus }}</td><td>{{ alignment.scenario }}</td><td>{{ alignment.benefitValue.toLocaleString() }} {{ alignment.benefitUnit }}</td><td>{{ (alignment.requestedFunding ?? 0).toLocaleString() }} {{ alignment.fundingCurrency ?? 'USD' }}<small>{{ (alignment.requestedHours ?? 0).toLocaleString() }} h</small></td><td>{{ alignment.strategicScore }} / {{ alignment.riskScore }} / {{ alignment.costScore }}</td><td v-if="workspace.canManage" class="row-actions"><button aria-label="Edit project alignment" type="button" @click="openEditor('alignment', alignment)"><i class="bi bi-pencil"></i></button><button aria-label="Delete project alignment" type="button" @click="openDelete('alignment', alignment, projectMap.get(alignment.projectId)?.name ?? alignment.projectId)"><i class="bi bi-trash"></i></button></td></tr><tr v-if="workspace.alignments.length === 0"><td colspan="9" class="portfolio-empty">No visible project alignments.</td></tr></tbody></table></div>
        <div class="scenario-grid"><article v-for="plan in workspace.plans" :key="plan.id"><div class="scenario-heading"><div><small>{{ plan.scenario }} scenario</small><h3>{{ plan.name }}</h3></div><span>{{ plan.status }}</span></div><p>{{ plan.fundingLimit.toLocaleString() }} {{ plan.fundingCurrency }} · {{ plan.resourceHoursLimit.toLocaleString() }} h</p><template v-if="workspace.analysis.comparisons.find(item => item.planId === plan.id)"><p><strong>{{ workspace.analysis.comparisons.find(item => item.planId === plan.id).selected.length }}</strong> selected · <strong>{{ workspace.analysis.comparisons.find(item => item.planId === plan.id).deferred.length }}</strong> deferred</p><p>{{ workspace.analysis.comparisons.find(item => item.planId === plan.id).utilization.fundingPercent }}% funding · {{ workspace.analysis.comparisons.find(item => item.planId === plan.id).utilization.resourcePercent }}% hours</p></template><p v-if="plan.decisionNote">{{ plan.decisionNote }}</p><div v-if="workspace.canManage && !['approved','rejected'].includes(plan.status)" class="row-actions"><button aria-label="Edit scenario plan" type="button" @click="openEditor('plan', plan)"><i class="bi bi-pencil"></i></button><button aria-label="Delete scenario plan" type="button" @click="openDelete('plan', plan, plan.name)"><i class="bi bi-trash"></i></button></div><small v-if="plan.decidedAt">Decided {{ new Date(plan.decidedAt).toLocaleDateString() }}</small></article><p v-if="workspace.plans.length === 0" class="portfolio-empty">No constrained scenario plans.</p></div>
        <div class="table-responsive"><table class="table table-sm"><caption>Immutable portfolio baselines</caption><thead><tr><th>Name</th><th>Portfolio</th><th>Scenario</th><th>Captured</th><th>Projects</th><th>Content hash</th></tr></thead><tbody><tr v-for="item in workspace.baselines" :key="item.id"><td>{{ item.name }}</td><td>{{ nodeMap.get(item.portfolioNodeId)?.name ?? item.portfolioNodeId }}</td><td>{{ item.scenario }}</td><td>{{ new Date(item.capturedAt).toLocaleString() }}</td><td>{{ item.snapshot.projects.length }}</td><td class="baseline-hash">{{ item.snapshot.contentHash.slice(0, 12) }}…</td></tr><tr v-if="workspace.baselines.length === 0"><td colspan="6" class="portfolio-empty">No portfolio baselines.</td></tr></tbody></table></div>
      </section>
    </template>

    <footer class="portfolio-pagination"><button class="btn btn-sm btn-outline-secondary" :disabled="page === 1" type="button" @click="changePage(-1)">Previous</button><span>Page {{ page }} of {{ pages }}</span><button class="btn btn-sm btn-outline-secondary" :disabled="page === pages" type="button" @click="changePage(1)">Next</button></footer>

    <dialog ref="editorDialog" class="portfolio-dialog" @cancel.prevent="closeEditor"><form method="dialog" @submit.prevent="saveEditor"><header><h2>{{ editor.mode === 'edit' ? 'Edit' : 'Add' }} {{ editor.kind }}</h2><button aria-label="Close editor" type="button" @click="closeEditor"><i class="bi bi-x-lg"></i></button></header>
      <template v-if="editor.kind === 'node'"><label>Name<input v-model="editor.values.name" required /></label><label>Type<select v-model="editor.values.kind"><option value="portfolio">Portfolio</option><option value="program">Program</option></select></label><label>Parent portfolio<select v-model="editor.values.parentId"><option :value="null">None</option><option v-for="node in workspace.nodes.filter(item => item.kind === 'portfolio' && item.id !== editor.recordId)" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label>Governance stage<input v-model="editor.values.governanceStage" /></label><label>Status<select v-model="editor.values.status"><option value="proposed">Proposed</option><option value="active">Active</option><option value="on_hold">On hold</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label><label>Description<textarea v-model="editor.values.description" rows="3"></textarea></label></template>
      <template v-if="editor.kind === 'objective'"><label>Title<input v-model="editor.values.title" required /></label><label>Type<select v-model="editor.values.kind"><option value="objective">Objective</option><option value="key_result">Key result</option></select></label><label>Parent objective<select v-model="editor.values.parentId"><option :value="null">None</option><option v-for="objective in workspace.objectives.filter(item => item.kind === 'objective' && item.id !== editor.recordId)" :key="objective.id" :value="objective.id">{{ objective.title }}</option></select></label><div class="dialog-grid"><label>Current<input v-model.number="editor.values.currentValue" type="number" /></label><label>Target<input v-model.number="editor.values.targetValue" type="number" /></label><label>Unit<input v-model="editor.values.unit" /></label><label>Status<select v-model="editor.values.status"><option value="draft">Draft</option><option value="active">Active</option><option value="achieved">Achieved</option><option value="at_risk">At risk</option><option value="cancelled">Cancelled</option></select></label></div><label>Description<textarea v-model="editor.values.description" rows="3"></textarea></label></template>
      <template v-if="editor.kind === 'alignment'"><label>Project<select v-model="editor.values.projectId" required><option v-for="project in workspace.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>Portfolio / program<select v-model="editor.values.portfolioNodeId" required><option v-for="node in workspace.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label>Objective<select v-model="editor.values.objectiveId"><option :value="null">None</option><option v-for="objective in workspace.objectives" :key="objective.id" :value="objective.id">{{ objective.title }}</option></select></label><div class="dialog-grid"><label>Demand stage<select v-model="editor.values.demandStatus"><option value="candidate">Candidate</option><option value="approved">Approved</option><option value="active">Active</option><option value="held">Held</option><option value="rejected">Rejected</option></select></label><label>Scenario<select v-model="editor.values.scenario"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select></label><label>Benefit<input v-model.number="editor.values.benefitValue" type="number" /></label><label>Benefit unit<input v-model="editor.values.benefitUnit" /></label><label>Requested funding<input v-model.number="editor.values.requestedFunding" min="0" type="number" /></label><label>Funding currency<input v-model.trim="editor.values.fundingCurrency" maxlength="3" /></label><label>Requested hours<input v-model.number="editor.values.requestedHours" min="0" type="number" /></label><label>Strategic score<input v-model.number="editor.values.strategicScore" max="100" min="0" type="number" /></label><label>Risk score<input v-model.number="editor.values.riskScore" max="100" min="0" type="number" /></label><label>Cost score<input v-model.number="editor.values.costScore" max="100" min="0" type="number" /></label></div></template>
      <template v-if="editor.kind === 'plan'"><label>Name<input v-model="editor.values.name" required /></label><label>Portfolio<select v-model="editor.values.portfolioNodeId" required><option v-for="node in workspace.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><div class="dialog-grid"><label>Scenario<select v-model="editor.values.scenario"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select></label><label>Status<select v-model="editor.values.status"><option value="draft">Draft</option><option value="submitted">Submitted</option><option v-if="workspace.canApprove" value="approved">Approved</option><option v-if="workspace.canApprove" value="rejected">Rejected</option></select></label><label>Funding limit<input v-model.number="editor.values.fundingLimit" min="0" type="number" /></label><label>Funding currency<input v-model.trim="editor.values.fundingCurrency" maxlength="3" /></label><label>Resource hour limit<input v-model.number="editor.values.resourceHoursLimit" min="0" type="number" /></label></div><label>Decision note<textarea v-model="editor.values.decisionNote"></textarea></label></template>
      <template v-if="editor.kind === 'baseline'"><label>Name<input v-model="editor.values.name" required /></label><label>Portfolio<select v-model="editor.values.portfolioNodeId" required><option v-for="node in workspace.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label>Scenario<select v-model="editor.values.scenario"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select></label><p>The baseline captures an immutable, content-hashed snapshot of the visible descendant portfolio state.</p></template>
      <footer><button class="btn btn-sm btn-outline-secondary" type="button" @click="closeEditor">Cancel</button><button class="btn btn-sm btn-primary" type="submit">Save</button></footer></form></dialog>
    <dialog ref="deleteDialog" class="portfolio-dialog portfolio-dialog--small"><form method="dialog" @submit.prevent="deleteRecord"><header><h2>Delete {{ deleteTarget.kind }}</h2></header><p>Delete <strong>{{ deleteTarget.title }}</strong>? Records with dependent children or alignments cannot be deleted.</p><footer><button class="btn btn-sm btn-outline-secondary" type="button" @click="deleteDialog.close()">Cancel</button><button class="btn btn-sm btn-danger" type="submit">Delete</button></footer></form></dialog>
  </main>
</template>

<style scoped>
.portfolio-page{padding:1rem 1.5rem 2rem;font-size:.875rem;color:var(--bs-body-color)}.portfolio-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}.portfolio-header h1{font-size:1.375rem;line-height:1.2;margin:0}.portfolio-header p{color:var(--bs-secondary-color);margin:.25rem 0 0}.header-actions{display:flex;flex-wrap:wrap;gap:.5rem}.portfolio-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin-bottom:1rem}.portfolio-metrics article{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.75rem;background:var(--bs-body-bg)}.portfolio-metrics span{display:block;color:var(--bs-secondary-color);font-size:.75rem}.portfolio-metrics strong{font-size:1.25rem;line-height:1.2}.portfolio-filters{display:flex;align-items:end;gap:.5rem;flex-wrap:wrap;border-block:1px solid var(--bs-border-color);padding:.75rem 0}.portfolio-filters label{display:grid;gap:.25rem;min-width:10rem;font-size:.75rem;font-weight:600}.portfolio-filters label:first-child{flex:1;min-width:14rem}.portfolio-tabs{display:flex;gap:.25rem;margin:1rem 0;border-bottom:1px solid var(--bs-border-color)}.portfolio-tabs button{min-height:2.75rem;padding:.5rem .75rem;border:0;border-bottom:.15rem solid transparent;background:transparent;color:var(--bs-secondary-color);font-weight:600}.portfolio-tabs button.active{border-color:var(--bs-primary);color:var(--bs-primary)}section h2{font-size:1.125rem;line-height:1.2;margin:0 0 .75rem}.table th{position:sticky;top:0;background:var(--bs-body-bg);white-space:nowrap;font-size:.75rem;color:var(--bs-secondary-color)}.table td small{display:block;color:var(--bs-secondary-color)}.row-actions{display:flex;gap:.25rem}.row-actions button,.portfolio-dialog header button{width:2.75rem;height:2.75rem;border:0;border-radius:.375rem;background:transparent;color:var(--bs-secondary-color)}.row-actions button:focus-visible,.portfolio-tabs button:focus-visible,.portfolio-dialog button:focus-visible{outline:.18rem solid var(--bs-primary);outline-offset:.1rem}.objective-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:.75rem}.objective-grid article{display:grid;grid-template-columns:1fr auto;gap:.5rem;border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.75rem}.objective-grid h3{font-size:1rem;margin:.15rem 0}.objective-grid small{color:var(--bs-secondary-color);text-transform:capitalize}.objective-grid .progress,.objective-grid p{grid-column:1/-1;margin:0}.objective-grid .row-actions{grid-column:1/-1;justify-content:flex-end}.portfolio-empty{text-align:center;color:var(--bs-secondary-color);padding:1.5rem}.portfolio-pagination{display:flex;justify-content:center;align-items:center;gap:.75rem;margin-top:1rem}.portfolio-dialog{width:min(38rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);padding:0;border:1px solid var(--bs-border-color);border-radius:.75rem;background:var(--bs-body-bg);color:var(--bs-body-color);box-shadow:0 1rem 3rem rgba(0,0,0,.25)}.portfolio-dialog::backdrop{background:rgba(15,23,42,.55)}.portfolio-dialog form{display:grid;gap:.75rem;padding:1rem;overflow:auto;max-height:calc(100vh - 2rem)}.portfolio-dialog header,.portfolio-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.portfolio-dialog h2{font-size:1.125rem;margin:0}.portfolio-dialog label{display:grid;gap:.25rem;font-weight:600}.portfolio-dialog input,.portfolio-dialog select,.portfolio-dialog textarea{min-height:2.75rem;border:1px solid var(--bs-border-color);border-radius:.375rem;padding:.5rem;background:var(--bs-body-bg);color:var(--bs-body-color)}.portfolio-dialog textarea{min-height:5rem}.portfolio-dialog footer{justify-content:flex-end}.portfolio-dialog--small{width:min(28rem,calc(100vw - 2rem))}.dialog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}
.table caption{caption-side:top;font-weight:700;color:var(--bs-body-color)}.scenario-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:.75rem;margin:1rem 0}.scenario-grid>article{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.75rem}.scenario-grid p{margin:.5rem 0}.scenario-heading{display:flex;justify-content:space-between;gap:.5rem}.scenario-heading h3{font-size:1rem;margin:.15rem 0}.scenario-heading small,.scenario-grid>article>small{color:var(--bs-secondary-color)}.baseline-hash{font-family:var(--bs-font-monospace);color:var(--bs-body-color)}
@media(max-width:48rem){.portfolio-page{padding:.75rem}.portfolio-header{display:grid}.header-actions{width:100%}.header-actions .btn{flex:1;min-height:2.75rem}.portfolio-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.portfolio-tabs{overflow-x:auto}.portfolio-tabs button{white-space:nowrap}.dialog-grid{grid-template-columns:1fr}.table-responsive{border:1px solid var(--bs-border-color);border-radius:.5rem}.portfolio-pagination .btn{min-height:2.75rem}}
</style>
