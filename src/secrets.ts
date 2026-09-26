// Secret scanning for outbound prompts (#50431).
//
// Every prompt we send is transmitted to a Google-operated cloud VM and
// persisted in the session's history. A pasted `.env` line or API key in a
// prompt is exfiltration that no later cleanup can undo. We already require a
// `reason` on every mutation and emit an audit record; refusing to transmit a
// credential is the same discipline one step earlier.
//
// The scanner is a BEST-EFFORT guardrail, not a boundary: a secret split across
// lines, base64-wrapped, or assembled at runtime is invisible to it. It is
// deliberately conservative toward false positives (blocking costs one edit)
// while carrying an explicit `allow_secret` override for deliberate cases.

export interface SecretMatch {
    /** The class of pattern that matched — never the value. */
    patternClass: string;
}

interface Pattern {
    cls: string;
    re: RegExp;
}

const PATTERNS: Pattern[] = [
    { cls: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { cls: 'github-token', re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/ },
    { cls: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
    { cls: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { cls: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { cls: 'private-key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
    {
        cls: 'bearer-token',
        re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}(?![A-Za-z0-9._~+/-])/,
    },
];

// `key: value` / `key = value` assignments whose value looks like a credential.
const ASSIGNMENT =
    /\b(api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)\b\s*[:=]\s*['"]?([A-Za-z0-9+/_-]{20,})['"]?/gi;

const PLACEHOLDER_WORDS = [
    'example',
    'placeholder',
    'changeme',
    'change-me',
    'redacted',
    'dummy',
    'sample',
    'your-',
    'your_',
    'xxxx',
    'not-a-',
    'notreal',
];

/**
 * A value that mixes at least two character classes (lower/upper/digit/symbol)
 * and is long enough to plausibly be a credential. Prose like
 * `see-the-docs-for-this-value` (one class: lowercase) and template markers
 * (`<your-token>`) are rejected.
 */
function looksHighEntropy(value: string): boolean {
    if (value.length < 20) return false;
    if (/[<>{}$%]/.test(value)) return false;
    const lower = value.toLowerCase();
    if (PLACEHOLDER_WORDS.some((w) => lower.includes(w))) return false;
    let classes = 0;
    if (/[a-z]/.test(value)) classes++;
    if (/[A-Z]/.test(value)) classes++;
    if (/[0-9]/.test(value)) classes++;
    if (/[^A-Za-z0-9_-]/.test(value)) classes++;
    return classes >= 2;
}

/** Return the class of the first secret-shaped pattern found, or null. */
export function findSecret(text: string): SecretMatch | null {
    for (const { cls, re } of PATTERNS) {
        if (re.test(text)) return { patternClass: cls };
    }
    ASSIGNMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT.exec(text)) !== null) {
        if (looksHighEntropy(m[2]))
            return { patternClass: 'high-entropy-assignment' };
    }
    return null;
}

export interface SecretScanResult {
    hit: SecretMatch | null;
    allowed: boolean;
    /** The prompt to put in an audit payload — redacted whenever a hit exists. */
    auditPrompt: string;
    error?: {
        status: 'ERROR';
        code: number;
        message: string;
        pattern_class: string;
    };
}

/**
 * Scan an outbound prompt and decide whether it may be sent. On a hit the
 * caller must NOT send the prompt, MUST audit without the value, and SHOULD
 * return `error`. `allow_secret` with a non-empty reason overrides.
 */
export function scanPrompt(
    prompt: string,
    opts: { allowSecret: boolean; reason: string },
): SecretScanResult {
    const hit = findSecret(prompt);
    if (!hit) {
        return { hit: null, allowed: true, auditPrompt: prompt };
    }

    const redacted = `[redacted: prompt contained a ${hit.patternClass}]`;
    const hasReason =
        typeof opts.reason === 'string' && opts.reason.trim() !== '';
    if (opts.allowSecret && hasReason) {
        return { hit, allowed: true, auditPrompt: redacted };
    }

    const message = opts.allowSecret
        ? `prompt rejected: it contains what looks like a ${hit.patternClass}, ` +
          `and allow_secret requires a non-empty reason`
        : `prompt rejected: it contains what looks like a ${hit.patternClass}. ` +
          `Prompts are sent to a Google-operated VM and stored in session ` +
          `history. Remove the value, or pass allow_secret: true with a reason ` +
          `to send it deliberately.`;

    return {
        hit,
        allowed: false,
        auditPrompt: redacted,
        error: {
            status: 'ERROR',
            code: 400,
            message,
            pattern_class: hit.patternClass,
        },
    };
}
