/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";

/** Callback to get the message queue for injecting messages */
export type MessageQueueGetter<T> = () => { push: (message: string, mode: T) => void } | null;

/** Options for starting the Happy MCP server */
export interface HappyServerOptions<T> {
    /** Getter for the message queue (set after server starts) */
    getMessageQueue?: MessageQueueGetter<T>;
    /** Default mode to use when injecting messages */
    defaultMode?: T;
}

export async function startHappyServer<T>(client: ApiSessionClient, options?: HappyServerOptions<T>) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // Register inject_reminder tool if message queue getter is provided
    if (options?.getMessageQueue) {
        mcp.registerTool('inject_reminder', {
            description: 'Inject a reminder message into the conversation (e.g., for timer notifications)',
            title: 'Inject Reminder',
            inputSchema: {
                message: z.string().describe('The reminder message to inject'),
                task_id: z.string().optional().describe('Optional background task ID to reference'),
            },
        }, async (args) => {
            logger.debug('[happyMCP] Injecting reminder:', args);

            const queue = options.getMessageQueue?.();
            if (!queue) {
                return {
                    content: [{ type: 'text', text: 'Message queue not available yet' }],
                    isError: true,
                };
            }

            const reminderText = args.task_id
                ? `[Timer expired] Background task ${args.task_id} may be complete. Check its status.`
                : args.message;

            try {
                // Use default mode if provided, otherwise create minimal mode
                const mode = options.defaultMode ?? {} as T;
                queue.push(reminderText, mode);

                return {
                    content: [{ type: 'text', text: `Reminder injected: "${reminderText}"` }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to inject reminder: ${String(error)}` }],
                    isError: true,
                };
            }
        });
    }

    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    // Build tool names list based on what's registered
    const toolNames = ['change_title'];
    if (options?.getMessageQueue) {
        toolNames.push('inject_reminder');
    }

    return {
        url: baseUrl.toString(),
        toolNames,
        stop: () => {
            logger.debug('[happyMCP] Stopping server');
            mcp.close();
            server.close();
        }
    }
}
