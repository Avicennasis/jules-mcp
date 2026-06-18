// --- Session States ---

export const SESSION_STATES = [
  'STATE_UNSPECIFIED',
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
  'FAILED',
  'COMPLETED',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  'COMPLETED',
  'FAILED',
]);

export const AUTOMATION_MODES = [
  'AUTOMATION_MODE_UNSPECIFIED',
  'AUTO_CREATE_PR',
] as const;

export type AutomationMode = (typeof AUTOMATION_MODES)[number];

// --- Resources ---

export interface GitHubRepoContext {
  startingBranch: string;
}

export interface SourceContext {
  source: string;
  githubRepoContext?: GitHubRepoContext;
}

export interface PullRequest {
  url: string;
  title: string;
  description: string;
}

export interface SessionOutput {
  pullRequest?: PullRequest;
}

export interface Session {
  name: string;
  id: string;
  prompt: string;
  title?: string;
  sourceContext: SourceContext;
  requirePlanApproval?: boolean;
  automationMode?: AutomationMode;
  createTime: string;
  updateTime: string;
  state: SessionState;
  url: string;
  outputs?: SessionOutput[];
}

export interface Source {
  name: string;
  [key: string]: unknown; // API may add fields
}

// --- Activities ---

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  index: number;
}

export interface Plan {
  id: string;
  steps: PlanStep[];
  createTime: string;
}

export interface GitPatch {
  unidiffPatch: string;
  baseCommitId: string;
  suggestedCommitMessage: string;
}

export interface ChangeSet {
  source: string;
  gitPatch: GitPatch;
}

export interface Media {
  data: string; // base64
  mimeType: string;
}

export interface BashOutput {
  command: string;
  output: string;
  exitCode: number;
}

export interface Artifact {
  changeSet?: ChangeSet;
  media?: Media;
  bashOutput?: BashOutput;
}

export interface AgentMessaged {
  agentMessage: string;
}

export interface UserMessaged {
  userMessage: string;
}

export interface PlanGenerated {
  plan: Plan;
}

export interface PlanApproved {
  planId: string;
}

export interface ProgressUpdated {
  title: string;
  description: string;
}

export interface SessionCompleted {}

export interface SessionFailed {
  reason: string;
}

export type ActivityType =
  | { agentMessaged: AgentMessaged }
  | { userMessaged: UserMessaged }
  | { planGenerated: PlanGenerated }
  | { planApproved: PlanApproved }
  | { progressUpdated: ProgressUpdated }
  | { sessionCompleted: SessionCompleted }
  | { sessionFailed: SessionFailed };

export interface Activity {
  name: string;
  id: string;
  description: string;
  createTime: string;
  originator: string;
  artifacts?: Artifact[];
  activity: ActivityType;
}

// --- Scheduling ---

export interface ScheduleEntry {
  id: string;
  label: string;
  cron: string;
  prompt: string;
  source: string;
  startingBranch: string;
  requirePlanApproval: boolean;
  automationMode?: AutomationMode;
  createdAt: string;
}

// --- Utility ---

/**
 * Normalizes resource names. Accepts bare IDs or full resource names.
 * normalizeResourceName("abc123", "sessions") → "sessions/abc123"
 * normalizeResourceName("sessions/abc123", "sessions") → "sessions/abc123"
 */
export function normalizeResourceName(input: string, prefix: string): string {
  if (input.startsWith(`${prefix}/`)) {
    return input;
  }
  return `${prefix}/${input}`;
}
