import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSourceTools } from '../../src/tools/sources.js';
import type { JulesClient } from '../../src/jules-client.js';

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
            listSources: vi
                .fn()
                .mockResolvedValue([{ name: 'sources/github/owner/repo' }]),
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
        const result = await handler({ source: 'github/owner/repo' });
        expect(mockClient.getSource).toHaveBeenCalledWith('github/owner/repo');
    });
});
