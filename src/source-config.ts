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
        fs.writeFileSync(
            this.filePath,
            JSON.stringify(this.configs, null, 2),
            { mode: 0o600 },
        );
    }

    /** Get config for a specific source. Returns undefined if not set. */
    get(sourceId: string): SourceConfig | undefined {
        return this.configs[this.normalize(sourceId)];
    }

    /** Set (or merge) config for a source. */
    set(sourceId: string, update: Partial<Omit<SourceConfig, 'updatedAt'>>): SourceConfig {
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
