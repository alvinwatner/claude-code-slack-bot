#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
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
  private approvalServerPort: number;

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
    this.approvalServerPort = parseInt(process.env.PERMISSION_SERVER_PORT || '3847', 10);
    this.setupHandlers();
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

  private async registerApproval(approvalId: string, toolName: string, input: any): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${this.approvalServerPort}/register/${approvalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, input }),
      });
      const result = await response.json() as { success: boolean };
      return result.success;
    } catch (error) {
      logger.error('Failed to register approval with main bot', error);
      return false;
    }
  }

  private async pollApprovalStatus(approvalId: string, timeoutMs: number = 5 * 60 * 1000): Promise<PermissionResponse> {
    const startTime = Date.now();
    const pollInterval = 1000; // Poll every second

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`http://localhost:${this.approvalServerPort}/status/${approvalId}`);
        const result = await response.json() as { success: boolean; status?: string };

        if (result.success && result.status) {
          if (result.status === 'approved') {
            return { behavior: 'allow', message: 'Approved by user' };
          } else if (result.status === 'denied') {
            return { behavior: 'deny', message: 'Denied by user' };
          }
          // Status is 'pending', continue polling
        }
      } catch (error) {
        logger.warn('Error polling approval status, retrying...', { approvalId });
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout
    logger.info('Permission request timed out', { approvalId });
    return { behavior: 'deny', message: 'Permission request timed out' };
  }

  private async cleanupApproval(approvalId: string): Promise<void> {
    try {
      await fetch(`http://localhost:${this.approvalServerPort}/cleanup/${approvalId}`, {
        method: 'POST',
      });
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const { tool_name, input } = params;

    // Get Slack context from environment (passed by Claude handler)
    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    // Generate unique approval ID
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Register approval with main bot
    const registered = await this.registerApproval(approvalId, tool_name, input);
    if (!registered) {
      logger.error('Failed to register approval', { approvalId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ behavior: 'deny', message: 'Failed to register approval request' })
        }]
      };
    }

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

      // Poll for user response
      const response = await this.pollApprovalStatus(approvalId);

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

      // Cleanup the approval
      await this.cleanupApproval(approvalId);

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

      // Cleanup on error
      await this.cleanupApproval(approvalId);

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
