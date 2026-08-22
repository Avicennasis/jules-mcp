import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DIR = path.join(os.homedir(), '.local', 'share', 'jules-mcp');
const GUIDANCE_FILE = 'guidance.md';

/**
 * Standing guidance prepended to prompts created through this server.
 *
 * Written in response to a real incident: a keyword-based code-health detector
 * classified explanatory prose as commented-out code, and the resulting tasks
 * deleted the rationale for a race-condition mitigation (Avicennasis/GrantLoft
 * #310) and degraded two security comments (#316, #320). All three had green
 * CI — nothing automated could have caught them.
 *
 * Scope note: this reaches only tasks created through this MCP server. Jules'
 * own auto-generated suggestion tasks are created and executed upstream and
 * never pass through here.
 */
export const DEFAULT_GUIDANCE = `## Comment and documentation handling

Comments are content. A change that removes or reduces rationale is a real
change, even when no behavior changes and no test fails.

- Delete comments that restate WHAT the code does.
- Preserve comments that explain WHY: non-obvious invariants, concurrency
  reasoning, security posture, and deliberate deviations from the obvious
  implementation.
- Never reword or delete a comment solely to satisfy a linter or code-health
  detector. If a detector flags a prose comment as commented-out code, that is
  a false positive — report it and decline the task rather than editing the
  comment to dodge the matcher.
- Preserve structured tags (M2:, SECURITY:, NOTE:). They index back to reviews
  and audits.

## Declining a task

If a task's stated premise is wrong — the issue does not exist, or the
"problem" is correct code — say so and decline. A clear refusal naming the
reason is more valuable than a clean diff that removes something load-bearing.`;

/**
 * Load standing guidance, preferring `guidance.md` in the config dir so the
 * text can be edited without a release. Falls back to DEFAULT_GUIDANCE when
 * the file is absent, unreadable, or effectively empty.
 */
export function loadGuidance(dir?: string): string {
    const file = path.join(dir ?? DEFAULT_DIR, GUIDANCE_FILE);
    try {
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf-8');
            if (raw.trim() !== '') return raw;
        }
    } catch {
        // Unreadable config is not a reason to fail task creation — fall back.
    }
    return DEFAULT_GUIDANCE;
}

/** Prepend guidance to a task prompt. Empty guidance leaves the prompt alone. */
export function applyGuidance(prompt: string, guidance: string): string {
    if (guidance.trim() === '') return prompt;
    return `${guidance}\n\n---\n\n${prompt}`;
}
