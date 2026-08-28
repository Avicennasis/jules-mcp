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
    /** Output only — whether the session has been archived. */
    archived?: boolean;
}

export interface Source {
    name: string;
    [key: string]: unknown; // API may add fields
}

// --- Activities ---

export interface PlanStep {
    id: string;
    title: string;
    /** omitted by proto3 when empty */
    description?: string;
    /** proto3 omits this when 0 (the default int value); treat absent as 0. */
    index?: number;
}

export interface Plan {
    id?: string;
    /** proto3 omits repeated fields when empty, so an empty plan has no key */
    steps?: PlanStep[];
    createTime?: string;
}

// proto3 omits fields holding the default value from its JSON encoding, so a
// gitPatch with an empty diff arrives with no `unidiffPatch` key at all. These
// are optional on the wire; declaring them required let an unguarded deref
// typecheck and 500 the whole activity listing (#42).
export interface GitPatch {
    unidiffPatch?: string;
    baseCommitId?: string;
    suggestedCommitMessage?: string;
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

// Every field below is omitted by proto3 when it holds the default value, so
// each is optional on the wire however reliably it shows up in practice.
// `progressUpdated` is the one that bites: it arrives as `{}` more often than
// not — 15 of 27 progress activities in a real session rendered as
// "Progress: undefined — undefined" before this was corrected (#42).

export interface AgentMessaged {
    agentMessage?: string;
}

export interface UserMessaged {
    userMessage?: string;
}

export interface PlanGenerated {
    plan?: Plan;
}

export interface PlanApproved {
    planId?: string;
}

export interface ProgressUpdated {
    title?: string;
    description?: string;
}

export interface SessionCompleted {}

export interface SessionFailed {
    reason?: string;
}

/**
 * Activity resource. The Jules API models the activity payload as a protobuf
 * `oneof`; on the JSON wire format the members are serialized as TOP-LEVEL
 * fields on the Activity object (NOT nested under an `activity` key). Exactly
 * one of the union members below is present per activity. `artifacts` can
 * accompany any of them (e.g. a `progressUpdated` activity that also carries a
 * changeset). `description` is frequently absent.
 */
export interface Activity {
    name: string;
    id: string;
    description?: string;
    createTime: string;
    originator: string;
    artifacts?: Artifact[];
    // oneof "activity" — exactly one present, at the top level
    agentMessaged?: AgentMessaged;
    userMessaged?: UserMessaged;
    planGenerated?: PlanGenerated;
    planApproved?: PlanApproved;
    progressUpdated?: ProgressUpdated;
    sessionCompleted?: SessionCompleted;
    sessionFailed?: SessionFailed;
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

/**
 * Normalizes AND percent-encodes a resource name for safe interpolation into a
 * URL path. Use this, not normalizeResourceName, anywhere the result reaches a
 * request path (Redmine #50421).
 *
 * Normalization is not encoding. `normalizeResourceName` only prepends a
 * prefix, so a crafted id reached a different API endpoint entirely:
 *
 *   getSession("../../../v1alpha/sources")
 *     -> https://jules.googleapis.com/v1alpha/sources     (not a session at all)
 *
 * `?` and `#` were equally live: an id of `x?foo=1` injected a query parameter,
 * and `x#frag` truncated the path.
 *
 * Two things are needed, and neither alone is sufficient:
 *
 *  1. Per-SEGMENT encoding, not whole-string. Source names legitimately contain
 *     slashes -- `sources/github/Avicennasis/GrantLoft` is a real, valid name --
 *     so encodeURIComponent over the whole string would break every source
 *     lookup by turning its separators into %2F.
 *
 *  2. An explicit dot-segment rejection. encodeURIComponent("..") === "..",
 *     unchanged, so per-segment encoding on its own still resolves traversal.
 *     `.` and `..` are never valid Jules resource-name segments, so they are
 *     refused rather than mangled -- a caller passing one has a bug or is
 *     probing, and both deserve a loud error rather than a silent rewrite.
 *
 * Empty segments are refused for the same reason: `a//b` collapses in URL
 * resolution and is never a legitimate name.
 */
export function encodeResourceName(input: string, prefix: string): string {
    const normalized = normalizeResourceName(input, prefix);
    const segments = normalized.split('/');

    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            throw new Error(
                `Invalid resource name ${JSON.stringify(input)}: ` +
                    `path segment ${JSON.stringify(segment)} is not allowed.`,
            );
        }
    }

    return segments.map(encodeURIComponent).join('/');
}
