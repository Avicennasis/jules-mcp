import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_DIR = path.join(os.homedir(), '.local', 'share', 'jules-mcp');
const DATA_FILE = 'source-config.json';

/**
 * Per-source local metadata that the Jules API doesn't expose.
 * Stored as a simple JSON file — no encryption needed since this
 * is just operational metadata (not secrets).
 */
export interface SourceConfig {
    /** Whether the Jules "suggestions" feature is enabled for this repo. */
    suggestionsEnabled?: boolean;
    /** Free-form notes about this source. */
    notes?: string;
    /** When this config entry was last updated (ISO 8601). */
    updatedAt: string;
}

/** Jules allows the suggestions feature on at most this many repos. */
export const SUGGESTIONS_QUOTA_LIMIT = 5;

/** Local suggestion records older than this are called out as possibly stale. */
export const SUGGESTIONS_STALE_AFTER_DAYS = 30;

export interface SuggestionsQuotaReport {
    suggestionsQuota: string;
    suggestionsScanComplete: boolean;
    suggestionsStateSource: string;
    suggestionsOldestRecord?: string;
    suggestionsRecordAgeDays?: number;
    suggestionsStale?: boolean;
}

/**
 * Render the suggestions quota with its provenance attached.
 *
 * Two separate defects converge on this one string, so it is built in one
 * place and used by every tool that emits it:
 *
 * - #31: the quota was printed as definitive even when derived from a scan
 *   that stopped early. `suggestions_only` is a filter over the *whole* source
 *   list, so a partial scan has only established "no matches in the pages I
 *   happened to look at". An incomplete scan can never render as an exact
 *   count — it says "at least N" and names itself incomplete.
 * - #35: `suggestionsEnabled` is local bookkeeping that Jules never confirms.
 *   Verified against the live API across 474 sources: a source carries only
 *   `name`, `id` and `githubRepo`, with no suggestion state anywhere. So it
 *   cannot be reconciled, and the honest move is to label it as local and
 *   publish its age rather than let a reader take it as live state.
 */
export function describeSuggestionsQuota(input: {
    matched: number;
    scanComplete: boolean;
    pagesFetched?: number;
    updatedAt?: (string | undefined)[];
    now?: Date;
}): SuggestionsQuotaReport {
    const { matched, scanComplete, pagesFetched, updatedAt = [] } = input;
    const now = input.now ?? new Date();

    const stamps = updatedAt
        .filter((s): s is string => typeof s === 'string' && s !== '')
        .map((s) => ({ raw: s, ms: Date.parse(s) }))
        .filter((s) => Number.isFinite(s.ms))
        .sort((a, b) => a.ms - b.ms);
    const oldest = stamps[0];
    const ageDays = oldest
        ? Math.floor((now.getTime() - oldest.ms) / 86_400_000)
        : undefined;

    const provenance = oldest
        ? ` (from local config, oldest record ${oldest.raw.slice(0, 10)} — ${ageDays} days ago)`
        : ' (from local config)';

    const quota = scanComplete
        ? `${matched}/${SUGGESTIONS_QUOTA_LIMIT} slots used${provenance}`
        : `at least ${matched} of ${SUGGESTIONS_QUOTA_LIMIT} slots used — SCAN INCOMPLETE` +
          (pagesFetched ? ` after ${pagesFetched} pages` : '') +
          `, more sources remain unscanned so this is a lower bound, not a count${provenance}`;

    const report: SuggestionsQuotaReport = {
        suggestionsQuota: quota,
        suggestionsScanComplete: scanComplete,
        suggestionsStateSource:
            'local config (~/.local/share/jules-mcp/source-config.json) — the Jules API does not expose suggestion state, so this reflects what was last recorded via jules_configure_source and is not confirmed against Jules',
    };
    if (oldest) {
        report.suggestionsOldestRecord = oldest.raw;
        report.suggestionsRecordAgeDays = ageDays;
        report.suggestionsStale = (ageDays ?? 0) > SUGGESTIONS_STALE_AFTER_DAYS;
    }
    return report;
}

export class SourceConfigStore {
    private readonly filePath: string;
    private configs: Record<string, SourceConfig> = {};

    constructor(dir?: string) {
        const dataDir = dir ?? DEFAULT_DIR;
        this.filePath = path.join(dataDir, DATA_FILE);
        this.loadFromDisk();
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.configs = JSON.parse(raw);
            }
        } catch {
            this.configs = {};
        }
    }

    private saveToDisk(): void {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.filePath, JSON.stringify(this.configs, null, 2), {
            mode: 0o600,
        });
    }

    /** Get config for a specific source. Returns undefined if not set. */
    get(sourceId: string): SourceConfig | undefined {
        return this.configs[this.normalize(sourceId)];
    }

    /** Set (or merge) config for a source. */
    set(
        sourceId: string,
        update: Partial<Omit<SourceConfig, 'updatedAt'>>,
    ): SourceConfig {
        const key = this.normalize(sourceId);
        const existing = this.configs[key] ?? { updatedAt: '' };
        const merged: SourceConfig = {
            ...existing,
            ...update,
            updatedAt: new Date().toISOString(),
        };
        this.configs[key] = merged;
        this.saveToDisk();
        return merged;
    }

    /** Remove config for a source. */
    remove(sourceId: string): boolean {
        const key = this.normalize(sourceId);
        if (key in this.configs) {
            delete this.configs[key];
            this.saveToDisk();
            return true;
        }
        return false;
    }

    /** List all configured sources. */
    list(): Array<{ sourceId: string; config: SourceConfig }> {
        return Object.entries(this.configs).map(([sourceId, config]) => ({
            sourceId,
            config,
        }));
    }

    /** Normalize source ID to the short form: github/owner/repo */
    private normalize(input: string): string {
        return input.replace(/^sources\//, '');
    }
}
