import { createRouter, createWebHistory } from 'vue-router';

import { deniedAccessFor } from '../lib/auth/access.js';
import { authSession } from '../lib/auth/index.js';
import WorkspaceInvitationView from '../views/WorkspaceInvitationView.vue';
import VerifyEmailView from '../views/VerifyEmailView.vue';
import WorkspaceAccessConfirmView from '../views/WorkspaceAccessConfirmView.vue';
import EmailChangeConfirmView from '../views/EmailChangeConfirmView.vue';
import WorkspaceAccessView from '../views/WorkspaceAccessView.vue';
import AdminView from '../views/AdminView.vue';
import AgentMemoryView from '../views/AgentMemoryView.vue';
import ClarificationLinkMovedView from '../views/ClarificationLinkMovedView.vue';
import HomeView from '../views/HomeView.vue';
import LeaderboardView from '../views/LeaderboardView.vue';
import LoginView from '../views/LoginView.vue';
import OAuthCallbackView from '../views/OAuthCallbackView.vue';
import ProjectDetailView from '../views/ProjectDetailView.vue';
import ProjectsView from '../views/ProjectsView.vue';
import EngagementDetailView from '../views/EngagementDetailView.vue';
import EngagementsView from '../views/EngagementsView.vue';
import PortfolioView from '../views/PortfolioView.vue';
import RankProjectsView from '../views/RankProjectsView.vue';
import RegisterView from '../views/RegisterView.vue';
import FinanceView from '../views/FinanceView.vue';
import ResourcesView from '../views/ResourcesView.vue';
import SearchView from '../views/SearchView.vue';
import UserView from '../views/UserView.vue';
import WorkflowDefinitionView from '../views/WorkflowDefinitionView.vue';
import WorkflowTemplateView from '../views/WorkflowTemplateView.vue';
import WorkflowsView from '../views/WorkflowsView.vue';
import ReportingView from '../views/ReportingView.vue';
import TicketsView from '../views/TicketsView.vue';
import IdentityAdminView from '../views/IdentityAdminView.vue';
import IntegrationAdminView from '../views/IntegrationAdminView.vue';
import ComplianceAdminView from '../views/ComplianceAdminView.vue';
import TicketConfigAdminView from '../views/TicketConfigAdminView.vue';
import BugReporterConsentView from '../views/BugReporterConsentView.vue';
import McpConsentView from '../views/McpConsentView.vue';
import ProjectRequirementsLinksView from '../views/requirements/ProjectRequirementsLinksView.vue';
import ProjectRequirementsMyItemsView from '../views/requirements/ProjectRequirementsMyItemsView.vue';
import ProjectRequirementsPackageView from '../views/requirements/ProjectRequirementsPackageView.vue';
import ProjectRequirementsReviewView from '../views/requirements/ProjectRequirementsReviewView.vue';
import ProjectRequirementsRoundPublishView from '../views/requirements/ProjectRequirementsRoundPublishView.vue';
import ProjectRequirementsRoundAnnotationsView from '../views/requirements/ProjectRequirementsRoundAnnotationsView.vue';
import ProjectRequirementsRoundView from '../views/requirements/ProjectRequirementsRoundView.vue';
import ProjectRequirementsTopicView from '../views/requirements/ProjectRequirementsTopicView.vue';
import ProjectRequirementsTrackView from '../views/requirements/ProjectRequirementsTrackView.vue';
// Client portal and the guided review.
import PortalDocuments from '../components/requirements/portal/PortalDocuments.vue';
import PortalInbox from '../components/requirements/portal/PortalInbox.vue';
import PortalQuestion from '../components/requirements/portal/PortalQuestion.vue';
import PortalRoundReview from '../components/requirements/portal/PortalRoundReview.vue';
import PortalSigning from '../components/requirements/portal/PortalSigning.vue';
import ReviewTeamPage from '../components/requirements/review/ReviewTeamPage.vue';
import RequirementsPortalView from '../views/requirements-portal/RequirementsPortalView.vue';
import TicketReportView from '../views/TicketReportView.vue';
import AccessHubView from '../views/task-access/AccessHubView.vue';
import AccessTasksView from '../views/task-access/AccessTasksView.vue';
import GuestChannelView from '../views/guests/GuestChannelView.vue';
import GuestHomeView from '../views/guests/GuestHomeView.vue';
import GuestSignInView from '../views/guests/GuestSignInView.vue';
import { landingRedirect, takeLanding } from '../lib/chat/chat.js';
import ChatChannelView from '../views/chat/ChatChannelView.vue';
import ChatDirectView from '../views/chat/ChatDirectView.vue';
import ChatHomeView from '../views/chat/ChatHomeView.vue';
import ChatMentionsView from '../views/chat/ChatMentionsView.vue';
import ChatOdinView from '../views/chat/ChatOdinView.vue';
import ChatSearchView from '../views/chat/ChatSearchView.vue';
import ChatShellView from '../views/chat/ChatShellView.vue';
import ChatThreadsView from '../views/chat/ChatThreadsView.vue';

const routes = [
  { path: '/mcp/authorize', name: 'mcp-consent', component: McpConsentView, meta: { requiresAuth: true } },
  { path: '/oauth/authorize', name: 'bug-reporter-consent', component: BugReporterConsentView, meta: { requiresAuth: true } },
  { path: '/invites/:inviteToken', name: 'workspace-invitation', component: WorkspaceInvitationView },
  { path: '/verify-email', name: 'verify-email', component: VerifyEmailView },
  // Any signed-in person may ask to join another workspace; its admins decide.
  { path: '/workspace-access', name: 'workspace-access', component: WorkspaceAccessView, meta: { requiresAuth: true } },
  // The emailed link carries its token in the fragment and works with or without a session.
  { path: '/workspace-access/confirm', name: 'workspace-access-confirm', component: WorkspaceAccessConfirmView },
  // An account email change: the link sent to the new address, with or without a session.
  { path: '/account/confirm-email', name: 'email-change-confirm', component: EmailChangeConfirmView },
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: { requiresAuth: true },
  },
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { guestOnly: true },
  },
  {
    path: '/oauth/callback',
    name: 'oauth-callback',
    component: OAuthCallbackView,
    meta: { guestOnly: true },
  },
  {
    path: '/clarifications/:accessToken',
    name: 'clarification-portal',
    component: ClarificationLinkMovedView,
  },
  // The client portal. The link token is the credential; `portal` hides the app chrome.
  {
    path: '/requirements/:token',
    component: RequirementsPortalView,
    meta: { portal: true },
    children: [
      { path: '', name: 'requirements-portal', component: PortalInbox },
      { path: 'questions/:topicId', name: 'requirements-portal-question', component: PortalQuestion },
      { path: 'rounds/:roundId', name: 'requirements-portal-review', component: PortalRoundReview },
      // Shared documents and signature requests.
      { path: 'documents', name: 'requirements-portal-documents', component: PortalDocuments },
      { path: 'signing/:requestId', name: 'requirements-portal-signing', component: PortalSigning },
    ],
  },
  // External ticket intake: the reporter's page. The link token is the credential.
  {
    path: '/report/:token',
    name: 'ticket-report',
    component: TicketReportView,
    meta: { portal: true },
  },
  // Task access for people without a login: one link per email opens the projects shared
  // with it, then a project's tasks. The link token is the credential.
  {
    path: '/access/:token',
    name: 'task-access-hub',
    component: AccessHubView,
    meta: { portal: true },
  },
  {
    path: '/access/:token/projects/:projectId',
    name: 'task-access-project',
    component: AccessTasksView,
    meta: { portal: true },
  },
  // Channel guests: sign-in by emailed code, then their channels. Their session is a
  // cookie of its own; the app's chrome is hidden. Signed in, guests land in the Chat
  // layout: its sidebar with their channels (`chatLayout` gives them the whole page).
  { path: '/guest/sign-in', name: 'guest-sign-in', component: GuestSignInView, meta: { portal: true } },
  { path: '/guest', name: 'guest-home', component: GuestHomeView, meta: { chatLayout: true, portal: true } },
  { path: '/guest/channels/:channelId', name: 'guest-channel', component: GuestChannelView, meta: { chatLayout: true, portal: true } },
  // Odin Chat: its own shell, without Odin's top bar.
  {
    path: '/chat',
    component: ChatShellView,
    meta: { chatLayout: true, requiresAuth: true },
    children: [
      { path: '', name: 'chat-home', component: ChatHomeView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'mentions', name: 'chat-mentions', component: ChatMentionsView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'threads', name: 'chat-threads', component: ChatThreadsView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'search', name: 'chat-search', component: ChatSearchView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'odin', name: 'chat-odin', component: ChatOdinView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'dm/:conversationId', name: 'chat-direct', component: ChatDirectView, meta: { chatLayout: true, requiresAuth: true } },
      { path: 'channels/:projectId/:channelId', name: 'chat-channel', component: ChatChannelView, meta: { chatLayout: true, requiresAuth: true } },
    ],
  },
  {
    path: '/projects',
    name: 'projects',
    component: ProjectsView,
    meta: { requiresAuth: true },
  },
  // The Consulting module. The pages show a notice when it is off.
  { path: '/engagements', name: 'engagements', component: EngagementsView, meta: { requiresAuth: true } },
  { path: '/engagements/:projectId/:section(channels|board|insights|files|people|settings)?', name: 'engagement-detail', component: EngagementDetailView, meta: { requiresAuth: true } },
  {
    path: '/portfolio',
    name: 'portfolio',
    component: PortfolioView,
    meta: { requiresAuth: true },
  },
  {
    path: '/resources',
    name: 'resources',
    component: ResourcesView,
    meta: { requiresAuth: true },
  },
  {
    path: '/finance',
    name: 'finance',
    component: FinanceView,
    meta: { requiresAuth: true },
  },
  {
    path: '/tickets',
    name: 'tickets',
    component: TicketsView,
    meta: { requiresAuth: true },
  },
  {
    path: '/workflows',
    name: 'workflows',
    component: WorkflowsView,
    meta: { requiresAuth: true },
  },
  {
    path: '/workflows/definitions/new',
    name: 'workflow-definition-new',
    component: WorkflowDefinitionView,
    meta: { requiresAuth: true },
  },
  {
    path: '/workflows/definitions/:workflowId',
    name: 'workflow-definition',
    component: WorkflowDefinitionView,
    meta: { requiresAuth: true },
  },
  {
    path: '/workflows/templates/new',
    name: 'workflow-template-new',
    component: WorkflowTemplateView,
    meta: { requiresAuth: true },
  },
  {
    path: '/workflows/templates/:templateId',
    name: 'workflow-template',
    component: WorkflowTemplateView,
    meta: { requiresAuth: true },
  },
  {
    path: '/reports',
    name: 'reporting',
    component: ReportingView,
    meta: { requiresAuth: true },
  },
  {
    path: '/search',
    name: 'search',
    component: SearchView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId',
    name: 'project-detail',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/sprints',
    name: 'project-sprints',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/kanban',
    name: 'project-kanban',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/governance',
    name: 'project-governance',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/tickets',
    name: 'project-tickets',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/resources',
    name: 'project-resources',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    // Channels: ?channel=, ?tab=files, ?folder=, ?file=, ?post=.
    path: '/projects/:projectId/channels',
    name: 'project-channels',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  {
    path: '/projects/:projectId/insights',
    name: 'project-insights',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  // invoice-gen billing (Consulting module), for project and workspace admins and managers.
  {
    path: '/projects/:projectId/billing',
    name: 'project-billing',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  // A converted engagement's pursuit board and insights.
  {
    path: '/projects/:projectId/pursuit',
    name: 'project-pursuit',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
  },
  // Project Reports and Analytics became the Insights tab.
  {
    path: '/projects/:projectId/:legacy(reports|analytics)',
    redirect: (to) => ({ name: 'project-insights', params: { projectId: to.params.projectId } }),
  },
  {
    // Requirements tab. ProjectDetailView renders the tab bar and the workspace; the child
    // route picks the view inside it (My open items, a track stage, a topic, or links).
    path: '/projects/:projectId/requirements',
    component: ProjectDetailView,
    meta: { requiresAuth: true },
    children: [
      { path: '', name: 'project-requirements', component: ProjectRequirementsMyItemsView },
      { path: 'links', name: 'project-requirements-links', component: ProjectRequirementsLinksView },
      { path: 'topics/:topicId', name: 'project-requirements-topic', component: ProjectRequirementsTopicView },
      // Review is project-wide: its own tab, one round open at a time.
      { path: 'review', name: 'project-requirements-review', component: ProjectRequirementsReviewView },
      {
        path: 'review/packages/:packageId',
        name: 'project-requirements-package',
        component: ProjectRequirementsPackageView,
      },
      // Review rounds for the team: publish a draft package as a round, and a round's results.
      {
        path: 'review/packages/:packageId/publish',
        name: 'project-requirements-round-publish',
        component: ProjectRequirementsRoundPublishView,
      },
      {
        path: 'review/rounds/:roundId',
        name: 'project-requirements-round',
        component: ProjectRequirementsRoundView,
      },
      // Every annotation and comment in a round, in one list.
      {
        path: 'review/rounds/:roundId/annotations',
        name: 'project-requirements-round-annotations',
        component: ProjectRequirementsRoundAnnotationsView,
      },
      // A team member's own guided review of a round.
      {
        path: 'review/rounds/:roundId/review',
        name: 'project-requirements-round-review',
        component: ReviewTeamPage,
      },
      // Review used to sit inside each track; those links (in emails too) open the same pages.
      {
        path: ':track(experience|architecture)/review/:rest(.*)*',
        redirect: (to) => ({
          hash: to.hash,
          path: `/projects/${encodeURIComponent(to.params.projectId)}/requirements/review${[].concat(to.params.rest ?? []).filter(Boolean).map((part) => `/${encodeURIComponent(part)}`).join('')}`,
          query: to.query,
        }),
      },
      {
        path: ':track(experience|architecture)/:stage(brief|discuss|decide|plan)?',
        name: 'project-requirements-track',
        component: ProjectRequirementsTrackView,
      },
    ],
  },
  {
    path: '/ai-memory',
    name: 'agent-memory',
    component: AgentMemoryView,
    meta: { requiresAuth: true, requiredAccess: 'agentMemory' },
  },
  {
    path: '/ranking',
    name: 'ranking',
    component: RankProjectsView,
    meta: { requiresAuth: true, requiredAccess: 'rankProjects' },
  },
  {
    path: '/leaderboard',
    name: 'leaderboard',
    component: LeaderboardView,
    meta: { requiresAuth: true },
  },
  {
    path: '/user',
    name: 'user',
    component: UserView,
    meta: { requiresAuth: true },
  },
  {
    path: '/admin',
    name: 'admin',
    component: AdminView,
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/admin/compliance/:section(policy|exports|legal-holds|attestations|privacy)?',
    name: 'compliance-admin',
    component: ComplianceAdminView,
    meta: { requiresAuth: true, requiredAccess: 'compliance' },
  },
  {
    path: '/admin/ticketing/:kind(environments|releases)?',
    name: 'ticket-config-admin',
    component: TicketConfigAdminView,
    meta: { requiresAuth: true, requiredAccess: 'ticketConfig' },
  },
  {
    path: '/admin/identity',
    name: 'identity-admin',
    component: IdentityAdminView,
    meta: { requiresAuth: true, requiredCapability: 'identity.manage' },
  },
  {
    path: '/admin/integrations',
    name: 'integration-admin',
    component: IntegrationAdminView,
    meta: { requiresAuth: true, requiredCapability: 'integrations.manage' },
  },
  // Two-factor setup moved to the profile's Security tab; keep old links working.
  {
    path: '/settings',
    redirect: { name: 'user', query: { tab: 'security' } },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach(async (to) => {
  await authSession.restore();

  if (to.meta.requiresAuth && !authSession.state.isAuthenticated) {
    return {
      name: 'login',
      query: {
        redirect: to.fullPath,
      },
    };
  }

  if (to.meta.guestOnly && authSession.state.isAuthenticated && to.name !== 'oauth-callback') {
    return {
      name: 'home',
    };
  }

  const denied = deniedAccessFor(to.meta, authSession.state.currentUser);
  if (denied) {
    return { name: 'home', query: { notice: denied } };
  }

  if (authSession.state.isAuthenticated && to.meta.requiresAuth) {
    // The start page applies to the first page of a visit, and the first after signing in.
    const redirect = landingRedirect({ landing: takeLanding(), preferences: authSession.state.currentUser?.preferences, toName: to.name });
    if (redirect) return redirect;
  }

  return true;
});

export { router };
