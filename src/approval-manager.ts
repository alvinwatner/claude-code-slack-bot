import * as http from 'http';
import { Logger } from './logger';
import { config } from './config';

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  input: any;
  status: 'pending' | 'approved' | 'denied';
  registeredAt: Date;
  resolvedAt?: Date;
}

/**
 * Centralized approval manager that runs in the main bot process.
 * MCP servers register approvals here and poll for status.
 * Slack button handlers update approval status here.
 */
export class ApprovalManager {
  private logger = new Logger('ApprovalManager');
  private httpServer: http.Server | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private port: number;

  constructor() {
    this.port = config.permissionServerPort;
  }

  start(): void {
    if (this.httpServer) {
      this.logger.warn('HTTP server already running');
      return;
    }

    this.httpServer = http.createServer((req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const pathParts = url.pathname.split('/').filter(Boolean);

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          pendingApprovals: this.pendingApprovals.size
        }));
        return;
      }

      // Register a new approval: POST /register/:approvalId
      if (req.method === 'POST' && pathParts[0] === 'register' && pathParts[1]) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {};
            const approval: PendingApproval = {
              approvalId: pathParts[1],
              toolName: data.toolName || 'unknown',
              input: data.input || {},
              status: 'pending',
              registeredAt: new Date(),
            };
            this.pendingApprovals.set(pathParts[1], approval);
            this.logger.info('Approval registered', { approvalId: pathParts[1], toolName: approval.toolName });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, approvalId: pathParts[1] }));
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // Get approval status: GET /status/:approvalId
      if (req.method === 'GET' && pathParts[0] === 'status' && pathParts[1]) {
        const approval = this.pendingApprovals.get(pathParts[1]);
        if (approval) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            status: approval.status,
            toolName: approval.toolName
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Approval not found' }));
        }
        return;
      }

      // Approve: POST /approve/:approvalId
      if (req.method === 'POST' && pathParts[0] === 'approve' && pathParts[1]) {
        const approval = this.pendingApprovals.get(pathParts[1]);
        if (approval) {
          approval.status = 'approved';
          approval.resolvedAt = new Date();
          this.logger.info('Approval granted', { approvalId: pathParts[1] });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Approved' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Approval not found or already processed' }));
        }
        return;
      }

      // Deny: POST /deny/:approvalId
      if (req.method === 'POST' && pathParts[0] === 'deny' && pathParts[1]) {
        const approval = this.pendingApprovals.get(pathParts[1]);
        if (approval) {
          approval.status = 'denied';
          approval.resolvedAt = new Date();
          this.logger.info('Approval denied', { approvalId: pathParts[1] });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Denied' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Approval not found or already processed' }));
        }
        return;
      }

      // Cleanup old approvals: POST /cleanup
      if (req.method === 'POST' && url.pathname === '/cleanup') {
        const approvalId = pathParts[1];
        if (approvalId) {
          this.pendingApprovals.delete(approvalId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.httpServer.listen(this.port, () => {
      this.logger.info(`Approval HTTP server listening on port ${this.port}`);
    });

    this.httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        this.logger.error(`Port ${this.port} already in use. Cannot start approval server.`);
      } else {
        this.logger.error('HTTP server error', error);
      }
    });

    // Cleanup old approvals every 5 minutes
    setInterval(() => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      for (const [id, approval] of this.pendingApprovals.entries()) {
        if (approval.registeredAt.getTime() < fiveMinutesAgo) {
          this.pendingApprovals.delete(id);
          this.logger.debug('Cleaned up old approval', { approvalId: id });
        }
      }
    }, 60 * 1000);
  }

  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
      this.logger.info('Approval HTTP server stopped');
    }
  }

  // Direct methods for use within the same process
  resolveApproval(approvalId: string, approved: boolean): boolean {
    const approval = this.pendingApprovals.get(approvalId);
    if (approval && approval.status === 'pending') {
      approval.status = approved ? 'approved' : 'denied';
      approval.resolvedAt = new Date();
      this.logger.info(`Approval ${approved ? 'granted' : 'denied'}`, { approvalId });
      return true;
    }
    return false;
  }

  getApprovalStatus(approvalId: string): 'pending' | 'approved' | 'denied' | null {
    const approval = this.pendingApprovals.get(approvalId);
    return approval ? approval.status : null;
  }
}

// Singleton instance
export const approvalManager = new ApprovalManager();
