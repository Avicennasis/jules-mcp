/**
 * Serve the prompt catalog over `prompts/list` and `prompts/get` (#50429).
 *
 * WHY NOT `McpServer.registerPrompt`. That is the idiomatic call and it does
 * exist in the pinned SDK (@modelcontextprotocol/sdk 1.30.0,
 * `server/mcp.d.ts:181`), but it cannot serve this ticket's acceptance
 * criterion. `registerPrompt` coerces the `argsSchema` raw shape with
 * `objectFromShape()` and then parses `request.params.arguments` against it
 * (`server/mcp.js:429`). `arguments` is OPTIONAL in the protocol
 * (`GetPromptRequestSchema`: `ZodOptional<ZodRecord<ZodString, ZodString>>`),
 * and a Zod object rejects `undefined` however optional its fields are — so
 * `prompts/get` with `arguments` omitted fails with
 *
 *     MCP error -32602: Invalid arguments for prompt <name>:
 *     Invalid input: expected object, received undefined
 *
 * for every prompt that advertises arguments. Measured against a real
 * `Client` over `InMemoryTransport`, SDK 1.30.0, 2026-09-05. That is exactly
 * the "un-argumented preview renders placeholders rather than erroring"
 * criterion, so the two low-level handlers below are the feature rather than
 * an optimisation. `arguments: {}` works through `registerPrompt`; an omitted
 * `arguments` does not, and a client is entitled to omit it.
 *
 * Prompts are deliberately NOT tools. They take no `reason` and emit no audit
 * record, because rendering text mutates nothing — the audit trail begins when
 * the rendered prompt reaches `jules_create_session`, which does require one.
 * `tests/readme-counts.test.ts` derives the advertised tool count from
 * `src/tools/`, so keeping this module out of that directory also keeps a
 * prompt from being counted as a tool.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    ErrorCode,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
    promptArgumentsFor,
    renderTemplate,
    type PromptTemplate,
} from './template.js';
import { PROMPT_CATALOG } from './catalog.js';

/**
 * Declare the `prompts` capability and wire both handlers.
 *
 * Call before `server.connect()`: capabilities are part of the initialize
 * response, and the SDK refuses to register them once a transport is attached.
 */
export function registerPrompts(
    server: McpServer,
    catalog: readonly PromptTemplate[] = PROMPT_CATALOG,
): void {
    const byName = new Map(catalog.map((t) => [t.name, t]));

    // `listChanged: false` is the honest answer: the catalog ships in source
    // and cannot change while the process is running.
    server.server.registerCapabilities({ prompts: { listChanged: false } });

    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: catalog.map((template) => ({
            name: template.name,
            title: template.title,
            description: template.description,
            arguments: promptArgumentsFor(template.body),
        })),
    }));

    server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
        const template = byName.get(request.params.name);
        if (!template) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Prompt ${request.params.name} not found`,
            );
        }

        // An omitted `arguments` is the preview case, not an error. Values are
        // already validated as strings by GetPromptRequestSchema, so there is
        // nothing further to check here.
        return {
            description: template.description,
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: renderTemplate(
                            template.body,
                            request.params.arguments ?? {},
                        ),
                    },
                },
            ],
        };
    });
}
