// Type declarations for clawdbot/plugin-sdk
// These are provided at runtime by moltbot

declare module "clawdbot/plugin-sdk" {
  export interface ToolParameters {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }>;
    required?: string[];
    additionalProperties?: boolean;
  }

  export interface ToolExecuteResult {
    content: Array<{ type: "text"; text: string }>;
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: ToolParameters;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolExecuteResult>;
  }

  export interface MoltbotPluginApi {
    pluginConfig: Record<string, unknown>;
    registerTool(tool: ToolDefinition): void;
    on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void;
  }

  export function emptyPluginConfigSchema(): {
    type: "object";
    properties: Record<string, never>;
    additionalProperties: false;
  };

  export function emitDiagnosticEvent(event: {
    type: string;
    plugin?: string;
    data?: Record<string, unknown>;
  }): void;
}
