/**
 * The server's own version, read from package.json instead of restated.
 *
 * Redmine #50713: `serverInfo.version` was a hand-maintained literal in
 * index.ts. It sat at 0.4.0 through three releases, so every client that
 * completed an `initialize` handshake after 0.5.0 was told it was talking to
 * a version that had not existed since 2026-06. Nothing errored and nothing
 * tested it, because the two values lived in different files.
 *
 * Resolution: `../package.json` is resolved against this module's own URL, so
 * it lands on the package root in both shapes this file ever runs in --
 * `src/version.ts` under vitest, and `dist/version.js` after `tsc`. Both sit
 * exactly one directory below the package root, including when jules-mcp is
 * installed as a dependency in someone else's node_modules.
 *
 * There is deliberately NO fallback value. A default like '0.0.0' or a
 * hardcoded current version would restore precisely the failure this replaces:
 * a version that is wrong but looks authoritative. If package.json cannot be
 * read, that is a broken install and saying so beats inventing a number.
 */
import { readFileSync } from 'node:fs';

/**
 * Read the `version` field of the package.json one directory above `moduleUrl`.
 *
 * The `moduleUrl` parameter exists so the reading can be tested against a
 * fixture rather than only against this repo's own package.json. A test that
 * compares this module's output to the same file it reads cannot fail, which
 * would make it worthless as a guard -- see tests/version.test.ts.
 */
export function readPackageVersion(
    moduleUrl: string | URL = import.meta.url,
): string {
    const pkgUrl = new URL('../package.json', moduleUrl);
    const parsed: unknown = JSON.parse(readFileSync(pkgUrl, 'utf8'));

    const version =
        typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>).version
            : undefined;

    if (typeof version !== 'string' || version.length === 0) {
        throw new Error(
            `jules-mcp: no usable "version" string in ${pkgUrl.pathname} -- refusing to report a made-up version`,
        );
    }

    return version;
}

/** The version reported to MCP clients in the `initialize` response. */
export const VERSION = readPackageVersion();
