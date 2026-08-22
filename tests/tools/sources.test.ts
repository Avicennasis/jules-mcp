import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSourceTools } from '../../src/tools/sources.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { SourceConfigStore } from '../../src/source-config.js';

describe('source tools', () => {
    let mockServer: any;
    let mockClient: Partial<JulesClient>;
    let registeredTools: Map<string, { handler: Function }>;

    beforeEach(() => {
        registeredTools = new Map();
        mockServer = {
            tool: vi.fn(
                (
                    name: string,
                    _desc: string,
                    _schema: any,
                    handler: Function,
                ) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };
        mockClient = {
            listSources: vi.fn().mockResolvedValue({
                sources: [{ name: 'sources/github/owner/repo' }],
            }),
            getSource: vi.fn().mockResolvedValue({
                name: 'sources/github/owner/repo',
            }),
        };

        registerSourceTools(mockServer, mockClient as JulesClient);
    });

    it('registers jules_list_sources and jules_get_source', () => {
        expect(registeredTools.has('jules_list_sources')).toBe(true);
        expect(registeredTools.has('jules_get_source')).toBe(true);
    });

    it('jules_list_sources returns formatted sources', async () => {
        const handler = registeredTools.get('jules_list_sources')!.handler;
        const result = await handler({});
        expect(result.content[0].text).toContain('sources/github/owner/repo');
        expect(mockClient.listSources).toHaveBeenCalled();
    });

    it('jules_get_source calls client with source name', async () => {
        const handler = registeredTools.get('jules_get_source')!.handler;
        await handler({ source: 'github/owner/repo' });
        expect(mockClient.getSource).toHaveBeenCalledWith('github/owner/repo');
    });
});

// #31 / #35. Modelled on the real account, where the shape of the bug was
// measured: 474 sources across 5 pages of 100, with suggestions-enabled repos
// on page 1 (TypeIt4Me, GrantLoft) and page 4 (rDNSFix-Windows-Service,
// proxyperson). Scanning 3 pages or fewer therefore finds 2 and scanning 4+
// finds 4 — which is exactly the "2 vs 4" the issue reported.
describe('jules_list_sources suggestions quota', () => {
    const PAGES = [
        ['github/Avicennasis/TypeIt4Me', 'github/Avicennasis/GrantLoft'],
        ['github/Avicennasis/filler-a'],
        ['github/Avicennasis/filler-b'],
        [
            'github/Avicennasis/rDNSFix-Windows-Service',
            'github/Avicennasis/proxyperson',
        ],
        ['github/Avicennasis/filler-c'],
    ];

    const ENABLED = new Set([
        'github/Avicennasis/TypeIt4Me',
        'github/Avicennasis/GrantLoft',
        'github/Avicennasis/rDNSFix-Windows-Service',
        'github/Avicennasis/proxyperson',
    ]);

    let registeredTools: Map<string, { handler: Function }>;

    const build = (updatedAt = '2026-06-26T20:49:30.522Z') => {
        registeredTools = new Map();
        const mockServer = {
            tool: vi.fn(
                (name: string, _d: string, _s: any, handler: Function) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };
        const mockClient = {
            listSources: vi.fn(async ({ pageToken }: any) => {
                const idx = pageToken ? Number(pageToken) : 0;
                return {
                    sources: PAGES[idx].map((id) => ({
                        name: `sources/${id}`,
                        id,
                    })),
                    nextPageToken:
                        idx + 1 < PAGES.length ? String(idx + 1) : undefined,
                };
            }),
        } as unknown as JulesClient;
        const store = {
            get: (id: string) =>
                ENABLED.has(id)
                    ? { suggestionsEnabled: true, updatedAt }
                    : undefined,
            list: () =>
                [...ENABLED].map((sourceId) => ({
                    sourceId,
                    config: { suggestionsEnabled: true, updatedAt },
                })),
        } as unknown as SourceConfigStore;
        registerSourceTools(mockServer as any, mockClient, store);
        return registeredTools;
    };

    const call = async (args: any) => {
        const tools = build();
        const handler = tools.get('jules_list_sources')!.handler;
        const res = await handler(args);
        return JSON.parse(res.content[0].text);
    };

    it('exhausts pagination by default when suggestions_only is set', async () => {
        // A whole-list filter that stops early has only established "no
        // matches in the pages I happened to scan". The old default of 10
        // pages was what produced the wrong answer, so the default is now
        // exhaustion. Without the fix this finds 2.
        const out = await call({ suggestions_only: true });
        expect(out.count).toBe(4);
        expect(out.pagesFetched).toBe(5);
    });

    it('honours an explicit max_pages but refuses to call the result a count', async () => {
        // An explicit cap is the caller's business — silently ignoring a
        // parameter would be its own bug. What must not happen is reporting
        // the truncated number as definitive.
        const out = await call({ suggestions_only: true, max_pages: 1 });
        expect(out.count).toBe(2);
        expect(out.suggestionsScanComplete).toBe(false);
        expect(out.suggestionsQuota).toMatch(/at least 2 of 5/i);
        expect(out.suggestionsQuota).toMatch(/incomplete/i);
    });

    it('reports the scan as complete once the list is exhausted', async () => {
        const out = await call({ suggestions_only: true });
        expect(out.suggestionsScanComplete).toBe(true);
        expect(out.suggestionsQuota).toContain('4/5');
        expect(out.suggestionsQuota).not.toMatch(/at least/i);
    });

    it('never renders a definitive quota from a truncated scan', async () => {
        // Even exhausting pagination cannot exceed the hard 20-page cap, so a
        // source list longer than that still truncates. That is the one case
        // where a definitive count is unprovable, and it must not be printed
        // as one. 30 pages, with a match only on the very last.
        const registered = new Map<string, { handler: Function }>();
        const mockServer = {
            tool: vi.fn((name: string, _d: string, _s: any, h: Function) => {
                registered.set(name, { handler: h });
            }),
        };
        const mockClient = {
            listSources: vi.fn(async ({ pageToken }: any) => {
                const idx = pageToken ? Number(pageToken) : 0;
                return {
                    sources: [
                        {
                            name: `sources/github/o/r${idx}`,
                            id: `github/o/r${idx}`,
                        },
                    ],
                    nextPageToken: idx + 1 < 30 ? String(idx + 1) : undefined,
                };
            }),
        } as unknown as JulesClient;
        const store = {
            get: (id: string) =>
                id === 'github/o/r29'
                    ? {
                          suggestionsEnabled: true,
                          updatedAt: '2026-06-26T00:00:00Z',
                      }
                    : undefined,
            list: () => [],
        } as unknown as SourceConfigStore;
        registerSourceTools(mockServer as any, mockClient, store);

        const res = await registered
            .get('jules_list_sources')!
            .handler({ suggestions_only: true });
        const out = JSON.parse(res.content[0].text);

        expect(out.suggestionsScanComplete).toBe(false);
        expect(out.suggestionsQuota).toMatch(/at least/i);
        expect(out.suggestionsQuota).toMatch(/incomplete/i);
        expect(out.suggestionsQuota).not.toMatch(/^\d+\/5 slots used$/);
    });

    it('labels the quota as local state rather than live Jules state', async () => {
        const out = await call({ suggestions_only: true });
        expect(out.suggestionsStateSource).toMatch(/local/i);
        expect(JSON.stringify(out)).toMatch(
            /does not expose|jules_configure_source/i,
        );
    });

    it('includes the age of the local record', async () => {
        const out = await call({ suggestions_only: true });
        expect(out.suggestionsQuota).toContain('2026-06-26');
        expect(out.suggestionsRecordAgeDays).toBeGreaterThan(0);
    });

    it('flags a stale local record', async () => {
        const out = await call({ suggestions_only: true });
        expect(out.suggestionsStale).toBe(true);
    });

    it('does not flag a freshly-written record as stale', async () => {
        registeredTools = build(new Date().toISOString());
        const handler = registeredTools.get('jules_list_sources')!.handler;
        const res = await handler({ suggestions_only: true });
        const out = JSON.parse(res.content[0].text);
        expect(out.suggestionsStale).toBe(false);
    });

    it('emits no quota fields at all when suggestions_only is not set', async () => {
        const out = await call({});
        expect(out.suggestionsQuota).toBeUndefined();
        expect(out.suggestionsScanComplete).toBeUndefined();
    });

    it('jules_list_source_configs carries the same provenance labelling', async () => {
        const tools = build();
        const handler = tools.get('jules_list_source_configs')!.handler;
        const out = JSON.parse((await handler({})).content[0].text);
        expect(out.suggestionsQuota).toContain('4/5');
        expect(out.suggestionsStateSource).toMatch(/local/i);
        expect(out.suggestionsStale).toBe(true);
    });
});
