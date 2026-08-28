/**
 * Path-segment encoding regression tests (Redmine #50421).
 *
 * The defect: `normalizeResourceName` only prepends a prefix. Its result was
 * interpolated straight into a request path, so a crafted id did not stay in
 * the segment it was meant to occupy -- it re-pointed the request at a
 * different endpoint. Normalization is not encoding.
 *
 * These assert the URL the client would actually fetch, taken off the mocked
 * fetch call, rather than testing the helper in isolation -- the helper being
 * correct while a call site forgot to use it is exactly the shape that shipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JulesClient } from '../src/jules-client.js';
import { encodeResourceName, normalizeResourceName } from '../src/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE = 'https://jules.googleapis.com/v1alpha';

function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

/** The URL string the client passed to fetch on its most recent call. */
function fetchedUrl(): string {
    expect(mockFetch).toHaveBeenCalled();
    return String(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]);
}

describe('encodeResourceName', () => {
    it('leaves an ordinary id addressable and unchanged', () => {
        expect(encodeResourceName('abc123', 'sessions')).toBe(
            'sessions/abc123',
        );
        expect(encodeResourceName('sessions/abc123', 'sessions')).toBe(
            'sessions/abc123',
        );
    });

    it('preserves multi-segment source names, which are legitimate', () => {
        // sources/github/Avicennasis/GrantLoft is a real name. Whole-string
        // encodeURIComponent would turn every separator into %2F and break it.
        expect(
            encodeResourceName(
                'sources/github/Avicennasis/GrantLoft',
                'sources',
            ),
        ).toBe('sources/github/Avicennasis/GrantLoft');
    });

    it('refuses dot-segments rather than mangling them', () => {
        // encodeURIComponent('..') === '..', so per-segment encoding alone does
        // NOT stop traversal. This rejection is the part that does.
        expect(() => encodeResourceName('../../admin', 'sessions')).toThrow(
            /not allowed/,
        );
        expect(() => encodeResourceName('a/../b', 'sessions')).toThrow(
            /not allowed/,
        );
        expect(() => encodeResourceName('a/./b', 'sessions')).toThrow(
            /not allowed/,
        );
    });

    it('refuses empty segments', () => {
        expect(() => encodeResourceName('a//b', 'sessions')).toThrow(
            /not allowed/,
        );
    });

    it('encodes characters that would otherwise change the URL structure', () => {
        expect(encodeResourceName('x?foo=1', 'sessions')).toBe(
            'sessions/x%3Ffoo%3D1',
        );
        expect(encodeResourceName('x#frag', 'sessions')).toBe(
            'sessions/x%23frag',
        );
    });

    it('control: normalizeResourceName alone does NOT make input path-safe', () => {
        // Pins the distinction the ticket is about. If someone "simplifies"
        // encodeResourceName back to normalizeResourceName, this goes red.
        expect(normalizeResourceName('../../admin', 'sessions')).toBe(
            'sessions/../../admin',
        );
        expect(
            new URL(
                BASE +
                    '/' +
                    normalizeResourceName(
                        '../../../v1alpha/sources',
                        'sessions',
                    ),
            ).toString(),
        ).toBe('https://jules.googleapis.com/v1alpha/sources');
    });
});

describe('JulesClient path interpolation', () => {
    let client: JulesClient;

    beforeEach(() => {
        vi.resetAllMocks();
        client = new JulesClient('test-api-key');
    });

    it.each([
        ['getSession', (c: JulesClient) => c.getSession('../x')],
        ['approvePlan', (c: JulesClient) => c.approvePlan('../x')],
        ['sendMessage', (c: JulesClient) => c.sendMessage('../x', 'hi')],
        ['archiveSession', (c: JulesClient) => c.archiveSession('../x')],
        ['unarchiveSession', (c: JulesClient) => c.unarchiveSession('../x')],
        ['deleteSession', (c: JulesClient) => c.deleteSession('../x')],
        ['listActivities', (c: JulesClient) => c.listActivities('../x')],
        ['getActivity', (c: JulesClient) => c.getActivity('../x', '1')],
        ['getSource', (c: JulesClient) => c.getSource('../x')],
    ])(
        '%s rejects a traversal id and issues no request',
        async (_name, call) => {
            await expect(call(client)).rejects.toThrow(/not allowed/);
            // The decisive assertion: the request was never made at all.
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    it('getActivity encodes the activityId segment too', async () => {
        mockFetch.mockResolvedValue(
            jsonResponse({ name: 'sessions/abc/activities/1' }),
        );
        await client.getActivity('abc', 'a b/c');
        expect(fetchedUrl()).toBe(`${BASE}/sessions/abc/activities/a%20b%2Fc`);
    });

    it('an ordinary session id still produces the expected URL', async () => {
        mockFetch.mockResolvedValue(jsonResponse({ name: 'sessions/abc123' }));
        await client.getSession('abc123');
        expect(fetchedUrl()).toBe(`${BASE}/sessions/abc123`);
    });

    it('a multi-segment source name still produces the expected URL', async () => {
        mockFetch.mockResolvedValue(
            jsonResponse({ name: 'sources/github/o/r' }),
        );
        await client.getSource('sources/github/Avicennasis/GrantLoft');
        expect(fetchedUrl()).toBe(
            `${BASE}/sources/github/Avicennasis/GrantLoft`,
        );
    });

    it('pageToken with reserved characters round-trips encoded', async () => {
        // URLSearchParams already handled this correctly -- asserted so a future
        // refactor to manual string building cannot silently regress it.
        mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }));
        await client.listSessions(10, 'tok en&x=1/../y');
        const url = new URL(fetchedUrl());
        expect(url.pathname).toBe('/v1alpha/sessions');
        expect(url.searchParams.get('pageToken')).toBe('tok en&x=1/../y');
    });

    it('filter with reserved characters round-trips encoded', async () => {
        mockFetch.mockResolvedValue(jsonResponse({ sources: [] }));
        await client.listSources({ filter: 'a b&c=d' });
        const url = new URL(fetchedUrl());
        expect(url.pathname).toBe('/v1alpha/sources');
        expect(url.searchParams.get('filter')).toBe('a b&c=d');
    });
});
