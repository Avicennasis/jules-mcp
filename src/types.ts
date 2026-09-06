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

/**
 * Names seen in the wild that the current API does not document.
 *
 * Kept apart from SESSION_STATES so that list stays an honest statement of the
 * documented vocabulary — these are names we must TOLERATE, not names the API
 * is specified to send.
 *
 * Provenance, because it varies: PENDING / RUNNING / AWAITING_USER_INPUT /
 * CANCELLED / CANCELED come from Yuuqq/jules-dispatch, which labels them
 * "legacy values retained for compatibility with older API responses"
 * (#50647). COMPLETED_UNKNOWN comes from simpsoka/jules-companion, the
 * highest-starred Jules client surveyed. Both CANCELLED spellings appear in the
 * field; a check matching one silently misses the other.
 *
 * WAITING_FOR_APPROVAL and UNKNOWN also appear, in an unlicensed repo that
 * invents elsewhere (it also invented `automationMode: 'NONE'`, refuted against
 * the live API under #50780), so they are NOT listed here — an unverified
 * third-party claim is not evidence (#50777). They do not need to be: the
 * default branch handles them, which is the entire point of the design below.
 */
export const LEGACY_SESSION_STATES = [
    'PENDING',
    'RUNNING',
    'AWAITING_USER_INPUT',
    'CANCELLED',
    'CANCELED',
    'COMPLETED_UNKNOWN',
] as const;

/**
 * An OPEN union. `v1alpha` is pinned and chased (DESIGN.md decision 3), and
 * four surveyed repos produced four disagreeing state vocabularies with several
 * names that are plainly guesses. The enumeration cannot be completed by
 * collecting more names, so the type accepts any string while keeping editor
 * completion for the ones we know.
 *
 * `(string & {})` rather than a bare `string`: the intersection stops
 * TypeScript collapsing the whole union to `string` and losing autocomplete.
 */
export type SessionState =
    | (typeof SESSION_STATES)[number]
    | (typeof LEGACY_SESSION_STATES)[number]
    | (string & {});

/**
 * Compile-time proof the union is open. `npm run build` type-checks `src/` and
 * excludes `tests/`, so this assertion cannot live in the test suite: if
 * SessionState were closed again, this line would stop compiling and the build
 * gate would say so. Deleting it removes the only check on that property.
 */
const _openUnionProof: SessionState = 'A_STATE_THE_API_HAS_NOT_INVENTED_YET';
void _openUnionProof;

/**
 * States meaning "finished, nothing more will happen on its own".
 *
 * PAUSED is deliberately absent: a paused session is resumable, so it is not
 * finished — it is short-circuited in the poll loop instead (#50). Archiving a
 * running session yields PAUSED, measured 2026-08-31.
 */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'CANCELED',
    'COMPLETED_UNKNOWN',
]);

/**
 * States meaning "still working, poll again".
 *
 * This is the predicate that makes the unknown case safe, and it is written as
 * an ALLOW-list for that reason. The poll loop used to continue on anything not
 * in TERMINAL_STATES, so a session in CANCELED or COMPLETED_UNKNOWN — finished,
 * but under a name we did not list — polled until the 600s deadline and was
 * then reported as a `timeout`, which is not what happened. Inverting the test
 * makes an unrecognised state stop-and-report by construction, independent of
 * how complete the enumeration is (#50647, #50777).
 *
 * STATE_UNSPECIFIED counts as active: proto3 omits default-valued fields, so an
 * absent state is most often a session that has only just been created.
 */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
    'STATE_UNSPECIFIED',
    'QUEUED',
    'PLANNING',
    'IN_PROGRESS',
    'PENDING',
    'RUNNING',
]);

/** Whether a session is still progressing on its own. Unknown states are NOT. */
export function isActiveState(state: string | undefined): boolean {
    return state !== undefined && ACTIVE_STATES.has(state);
}

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
    /**
     * Optional because the API does not send it on every response: the
     * `:approvePlan` reply omits it entirely (#50828). Declaring it required
     * meant `tsc` could not see any of the unguarded `.sourceContext.source`
     * dereferences, and one of them threw in production. Treat every API field
     * as optional and guard it.
     */
    sourceContext?: SourceContext;
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
