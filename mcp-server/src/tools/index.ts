// ============================================================
// Tool registration — decides which tools exist for this process.
//
// Reads are always on. Everything that changes something is opt-in per
// group (see config.ts), so an assistant started with only the URL and a
// key can look but never touch. The API key's scopes are enforced on the
// server on top of this.
// ============================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import type { Config } from '../config.js';
import { registerReadTools } from './read.js';
import { registerWorkspaceReadTools } from './workspace-read.js';
import { registerWriteTools } from './write.js';
import { registerWorkspaceWriteTools } from './workspace-write.js';
import { registerAiAdminTools } from './ai-admin.js';
import { registerAutomationTools } from './automation.js';
import { registerDeleteTools } from './deletes.js';
import { registerBroadcastTools } from './broadcast.js';

export interface Registered {
  groups: string[];
  tools: string[];
}

export function registerTools(server: McpServer, client: WacrmClient, config: Config): Registered {
  // Record every tool as it is registered, so the reported list can never drift from reality.
  const tools: string[] = [];
  const recorded = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          tools.push(name);
          return (target.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as McpServer;

  const groups: string[] = ['read'];
  registerReadTools(recorded, client);
  registerWorkspaceReadTools(recorded, client);

  if (config.enableWrites) {
    registerWriteTools(recorded, client);
    registerWorkspaceWriteTools(recorded, client);
    groups.push('write');
  }
  if (config.enableWrites && config.enableAiAdmin) {
    registerAiAdminTools(recorded, client);
    groups.push('ai-admin');
  }
  if (config.enableWrites && config.enableAutomations) {
    registerAutomationTools(recorded, client);
    groups.push('automations');
  }
  if (config.enableWrites && config.enableDeletes) {
    registerDeleteTools(recorded, client, config);
    groups.push('deletes');
  }
  if (config.enableBroadcasts) {
    registerBroadcastTools(recorded, client);
    groups.push('broadcast');
  }
  return { groups, tools };
}
