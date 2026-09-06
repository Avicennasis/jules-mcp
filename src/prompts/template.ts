/**
 * Prompt-template machinery: derive the argument schema from the body.
 *
 * Redmine #50429. The idea is taken from melbinjp/jules-prompts (MIT,
 * `mcp/index.js:66-68` and `:90`), which scans a prompt body for placeholder
 * tokens and builds the MCP argument list from what it finds. No code was
 * copied — that server fetches markdown over the network at startup and this
 * one ships its catalog in source — but the property is the whole reason to
 * do it this way:
 *
 * 1. TEMPLATE AND SCHEMA CANNOT DRIFT. Adding a placeholder to a body *is*
 *    adding it to the advertised schema. A separately declared arguments list
 *    is a second copy of the truth, and a second copy is a thing that will
 *    disagree with the first and then be trusted anyway.
 * 2. UN-ARGUMENTED PREVIEW FALLS OUT FREE. Substitution only touches tokens it
 *    has a value for, so `prompts/get` with no arguments renders the template
 *    with its placeholders visible. That is the same code path as a filled
 *    render, rather than a preview special case that could rot unnoticed.
 *
 * Two token forms, because the difference matters for security and it must
 * also be derivable from the body alone:
 *
 *   <NAME>     operator-supplied identifier — a path, a branch, a package.
 *              Substituted inline.
 *   [[NAME]]   externally-sourced text — a CI log, release notes, an issue
 *              body. Substituted into a nonce fence (src/untrusted.ts) and
 *              replaced inline by a pointer to that fenced block.
 *
 * Marking untrustedness in the token rather than in a side list keeps the
 * fencing decision underivable-from-anywhere-else too: there is no second
 * place to forget to update.
 */

import type { PromptArgument } from '@modelcontextprotocol/sdk/types.js';
import { buildFencedPrompt, type UntrustedField } from '../untrusted.js';

/**
 * One placeholder of either form. The two alternatives share a scan so that
 * `all` can report genuine body order across both.
 *
 * Names are bare uppercase identifiers only. Prose contains `<div>` and
 * `<lower>` far more often than it contains a placeholder, and a scanner that
 * matched those would advertise arguments nobody asked for.
 */
const TOKEN = /<([A-Z][A-Z0-9_]*)>|\[\[([A-Z][A-Z0-9_]*)\]\]/g;

/** How a template is dispatched once rendered. */
export type PromptKind = 'task' | 'operation';

export interface PromptTemplate {
    /** MCP prompt name; surfaced by clients as a slash command. */
    name: string;
    /** `task` goes to Jules via jules_create_session; `operation` drives this server. */
    kind: PromptKind;
    title: string;
    description: string;
    /**
     * The complete final text, footer included. This is the single source of
     * truth: the argument list, the untrusted set and the rendered message are
     * all derived from it, and nothing else is consulted.
     */
    body: string;
}

export interface TemplatePlaceholders {
    /** `<NAME>` tokens, first-appearance order, deduped. */
    plain: string[];
    /** `[[NAME]]` tokens, first-appearance order, deduped. */
    untrusted: string[];
    /** Every placeholder of either form, in body order, deduped. */
    all: string[];
}

/** Scan a body for placeholders of both forms. */
export function placeholdersIn(body: string): TemplatePlaceholders {
    const plain: string[] = [];
    const untrusted: string[] = [];
    const all: string[] = [];
    const seen = new Set<string>();

    for (const match of body.matchAll(TOKEN)) {
        const name = match[1] ?? match[2];
        if (seen.has(name)) continue;
        seen.add(name);
        all.push(name);
        if (match[1] !== undefined) plain.push(name);
        else untrusted.push(name);
    }

    return { plain, untrusted, all };
}

/** Human-readable pointer that replaces a filled `[[NAME]]` token. */
function untrustedReference(name: string): string {
    return `the \`${name}\` block under "# UNTRUSTED DATA" below`;
}

/**
 * Build the `arguments` advertised by `prompts/list`, straight from the body.
 *
 * Every argument is `required: false`. An argument this server marked required
 * would make the preview case a client-side error, and there is nothing here a
 * caller must supply — an unfilled placeholder renders as itself.
 */
export function promptArgumentsFor(body: string): PromptArgument[] {
    const { untrusted, all } = placeholdersIn(body);
    const untrustedSet = new Set(untrusted);

    return all.map((name) => ({
        name,
        description: untrustedSet.has(name)
            ? `Value for [[${name}]] — externally-sourced text. It is nonce-fenced as inert data in the rendered prompt.`
            : `Value for <${name}>.`,
        required: false,
    }));
}

/**
 * Render a body against the supplied arguments.
 *
 * One pass over the body, so a substituted value is never rescanned: an
 * argument whose value happens to look like `<OTHER>` lands as literal text
 * instead of being filled in by a later iteration.
 *
 * A missing or empty value leaves its token in place. That is the preview
 * behaviour, and it is the absence of a branch rather than the presence of one.
 *
 * `args` is required and non-nullable on purpose. Defaulting it here as well as
 * at the request boundary would put the same tolerance in two places, and a
 * mutation to either one would then be invisible — the caller normalises an
 * absent `arguments` exactly once, in src/prompts/register.ts.
 */
export function renderTemplate(
    body: string,
    args: Record<string, string | undefined>,
): string {
    const fields: UntrustedField[] = [];
    const fenced = new Set<string>();

    const instructions = body.replace(
        TOKEN,
        (token, plainName?: string, untrustedName?: string) => {
            const name = plainName ?? untrustedName!;
            const value = args[name];
            if (value === undefined || value === '') return token;
            if (plainName !== undefined) return value;

            // A repeated token points at one block; fencing it twice would
            // throw on the duplicate label.
            if (!fenced.has(name)) {
                fenced.add(name);
                fields.push({ label: name, content: value });
            }
            return untrustedReference(name);
        },
    );

    return buildFencedPrompt(instructions, fields);
}
