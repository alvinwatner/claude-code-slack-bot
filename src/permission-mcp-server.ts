#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import * as http from 'http';
import { Logger } from './logger';

const logger = new Logger('PermissionMCP');

interface PermissionRequest {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
}

interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

class PermissionMCPServer {
  private server: Server;
  private slack: WebClient;
  private httpServer: http.Server | null = null;
  private pendingApprovals = new Map<string, {
    resolve: (response: PermissionResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    this.server = new Server(
      {
        name: "permission-prompt",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.setupHandlers();
    this.startHttpServer();
  }

  private startHttpServer() {
    const port = parseInt(process.env.PERMISSION_SERVER_PORT || '3847', 10);

    this.httpServer = http.createServer((req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const pathParts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'POST' && pathParts.length === 2) {
        const [action, approvalId] = pathParts;

        if (action === 'approve' || action === 'deny') {
          const approved = action === 'approve';
          const pending = this.pendingApprovals.get(approvalId);

          if (pending) {
            this.pendingApprovals.delete(approvalId);
            pending.resolve({
              behavior: approved ? 'allow' : 'deny',
              message: approved ? 'Approved by user' : 'Denied by user'
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Approval ${action}ed` }));
            logger.info(`Approval ${action}ed`, { approvalId });
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Approval not found or already processed' }));
            logger.warn('Approval not found', { approvalId });
          }
          return;
        }
      }

      // Health check endpoint
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pendingApprovals: this.pendingApprovals.size }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.httpServer.listen(port, () => {
      logger.info(`Permission HTTP server listening on port ${port}`);
    });

    this.httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.warn(`Port ${port} already in use, trying next port`);
        this.httpServer?.listen(port + 1);
      } else {
        logger.error('HTTP server error', error);
      }
    });
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "permission_prompt",
            description: "Request user permission for tool execution via Slack button",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: {
                  type: "string",
                  description: "Name of the tool requesting permission",
                },
                input: {
                  type: "object",
                  description: "Input parameters for the tool",
                },
                channel: {
                  type: "string",
                  description: "Slack channel ID",
                },
                thread_ts: {
                  type: "string",
                  description: "Slack thread timestamp",
                },
                user: {
                  type: "string",
                  description: "User ID requesting permission",
                },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "permission_prompt") {
        return await this.handlePermissionPrompt(request.params.arguments as unknown as PermissionRequest);
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const { tool_name, input } = params;

    // Get Slack context from environment (passed by Claude handler)
    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    // Generate unique approval ID
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Truncate input for display if too long
    const inputStr = JSON.stringify(input, null, 2);
    const truncatedInput = inputStr.length > 1500
      ? inputStr.substring(0, 1500) + '\n... (truncated)'
      : inputStr;

    // Create approval message with buttons
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`json\n${truncatedInput}\n\`\`\``
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Approve"
            },
            style: "primary",
            action_id: "approve_tool",
            value: approvalId
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Deny"
            },
            style: "danger",
            action_id: "deny_tool",
            value: approvalId
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Requested by: <@${user}> | Tool: ${tool_name}`
          }
        ]
      }
    ];

    try {
      // Send approval request to Slack
      const result = await this.slack.chat.postMessage({
        channel: channel || user || 'general',
        thread_ts: thread_ts,
        blocks,
        text: `Permission request for ${tool_name}` // Fallback text
      });

      logger.info('Sent permission request to Slack', { approvalId, tool_name, channel });

      // Wait for user response
      const response = await this.waitForApproval(approvalId);

      // Update the message to show the result
      if (result.ts) {
        await this.slack.chat.update({
          channel: result.channel!,
          ts: result.ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🔐 *Permission Request* - ${response.behavior === 'allow' ? '✅ Approved' : '❌ Denied'}\n\nTool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`json\n${truncatedInput}\n\`\`\``
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${response.behavior === 'allow' ? 'Approved' : 'Denied'} by user | Tool: ${tool_name}`
                }
              ]
            }
          ],
          text: `Permission ${response.behavior === 'allow' ? 'approved' : 'denied'} for ${tool_name}`
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    } catch (error) {
      logger.error('Error handling permission prompt:', error);

      // Default to deny if there's an error
      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    }
  }

  private async waitForApproval(approvalId: string): Promise<PermissionResponse> {
    return new Promise((resolve, reject) => {
      // Store the promise resolvers
      this.pendingApprovals.set(approvalId, { resolve, reject });

      // Set timeout (5 minutes)
      setTimeout(() => {
        if (this.pendingApprovals.has(approvalId)) {
          this.pendingApprovals.delete(approvalId);
          logger.info('Permission request timed out', { approvalId });
          resolve({
            behavior: 'deny',
            message: 'Permission request timed out'
          });
        }
      }, 5 * 60 * 1000);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Permission MCP server started');
  }
}

// Export singleton instance
export const permissionServer = new PermissionMCPServer();

// Run if this file is executed directly
const isMainModule = process.argv[1]?.endsWith('permission-mcp-server.ts') ||
                     process.argv[1]?.endsWith('permission-mcp-server.js');
if (isMainModule) {
  permissionServer.run().catch((error) => {
    logger.error('Permission MCP server error:', error);
    process.exit(1);
  });
}
