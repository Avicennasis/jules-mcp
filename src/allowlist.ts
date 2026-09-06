/**
 * `JULES_ALLOWED_REPOS` — a bound on which repositories a session may target.
 *
 * Redmine #50432. A slice of this shipped under #50457 guarding one tool; this
 * is the whole surface, and the shared implementation those tools now call.
 *
 * WHY THIS IS THE CONTROL WORTH HAVING. There are 474 connected sources. A
 * Jules session writes a branch and, under `AUTO_CREATE_PR`, opens a PR — so
 * "which repo may this touch" bounds the damage in a way that filtering prompt
 * text cannot. It is also the mechanical form of a rule that otherwise lives
 * only in instructions (avic / simsys / bfr / bbfra in scope; cubuild, foreign
 * and option out), and a rule enforced by a machine does not depend on every
 * future caller having read it.
 *
 * BACKWARD COMPATIBLE BY DEFAULT. Unset means unrestricted, so nothing breaks
 * on upgrade — which is also why `describeAllowlist` exists and is logged at
 * startup. An absent guardrail is invisible, and reads exactly like a working
 * one until the day it matters.
 */

/**
 * Test `repo` ("owner/name") against a `JULES_ALLOWED_REPOS`-style list.
 *
 * Comma-separated, case-insensitive, supporting `owner/*` and a bare `*`. An
 * unset or blank list means no restriction.
 *
 * The wildcard compares the WHOLE owner segment, never a prefix: `avic/*` must
 * not hand `avicious/x` an allowance, because that is a different account.
 */
export function isRepoAllowed(repo: string, raw: string | undefined): boolean {
    const entries = (raw ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e !== '');
    if (entries.length === 0) return true;

    const target = repo.trim().toLowerCase();
    const owner = target.split('/')[0];
    return entries.some(
        (entry) =>
            entry === '*' ||
            entry === target ||
            (entry.endsWith('/*') && entry.slice(0, -2) === owner),
    );
}

/**
 * Recover `owner/name` from a Jules source name.
 *
 * Accepts `sources/github/owner/name`, `github/owner/name` and a bare
 * `owner/name`. Returns `undefined` — never a guess — for anything else,
 * including non-GitHub providers, because the caller's response to "I cannot
 * tell" has to differ from its response to "I can tell, and it is fine".
 */
export function repoFromSource(source: string): string | undefined {
    const parts = source
        .trim()
        .split('/')
        .filter((p) => p !== '');

    // Strip the resource prefix and the provider, in whichever form arrived.
    let rest = parts;
    if (rest[0] === 'sources') rest = rest.slice(1);
    if (rest[0] === 'github') rest = rest.slice(1);

    if (rest.length !== 2) return undefined;
    return `${rest[0]}/${rest[1]}`;
}

export type AllowlistDecision =
    { allowed: true } | { allowed: false; repo?: string; message: string };

/**
 * The decision a tool calls before creating or scheduling anything.
 *
 * FAILS CLOSED on a source it cannot decompose while a list is configured:
 * we cannot show that repo is on the list, and in a guardrail "cannot confirm"
 * must not read as "permit". The two denials carry different messages, because
 * an operator debugging "why was this refused" needs to know whether to add an
 * entry or to fix the source name.
 */
export function checkSourceAllowed(
    source: string,
    raw: string | undefined,
): AllowlistDecision {
    const configured = (raw ?? '').trim() !== '';
    if (!configured) return { allowed: true };

    const repo = repoFromSource(source);
    if (repo === undefined) {
        return {
            allowed: false,
            message:
                `JULES_ALLOWED_REPOS is set, and the repository could not be determined from source ` +
                `"${source}" — so it cannot be shown to be on the allowlist and the request was refused. ` +
                `Expected a source of the form "sources/github/<owner>/<repo>". ` +
                `Unset JULES_ALLOWED_REPOS to remove the restriction.`,
        };
    }

    if (isRepoAllowed(repo, raw)) return { allowed: true };

    return {
        allowed: false,
        repo,
        message:
            `Repository "${repo}" is not on the JULES_ALLOWED_REPOS allowlist, so no session was created. ` +
            `JULES_ALLOWED_REPOS is set to "${raw}" — add the repo (or an "<owner>/*" entry) to allow it, ` +
            `or unset the variable to remove the restriction.`,
    };
}

/**
 * One line for stderr at startup, stating the bound or its absence.
 *
 * Never returns an empty string: a startup line that prints nothing is
 * indistinguishable from one that never ran, which is the failure this exists
 * to prevent.
 */
export function describeAllowlist(raw: string | undefined): string {
    const entries = (raw ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '');

    if (entries.length === 0) {
        return 'JULES_ALLOWED_REPOS is not set — no repository restriction is in effect; sessions may target any connected source.';
    }
    return `JULES_ALLOWED_REPOS is in effect (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}): ${entries.join(', ')}`;
}
