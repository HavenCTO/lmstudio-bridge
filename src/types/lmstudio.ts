/**
 * LM Studio REST API types for /api/v1/chat
 */

// ── Request Types ──

export interface LMStudioTextInput {
  type: "message";
  content: string;
}

export interface LMStudioImageInput {
  type: "image";
  data_url: string;
}

export type LMStudioInputItem = LMStudioTextInput | LMStudioImageInput;

export interface LMStudioPluginIntegration {
  type: "plugin";
  id: string;
  allowed_tools?: string[];
}

export interface LMStudioEphemeralMCPIntegration {
  type: "ephemeral_mcp";
  server_label: string;
  server_url: string;
  allowed_tools?: string[];
  headers?: Record<string, string>;
}

export type LMStudioIntegration =
  | string
  | LMStudioPluginIntegration
  | LMStudioEphemeralMCPIntegration;

export interface LMStudioChatRequest {
  model: string;
  input: string | LMStudioInputItem[];
  system_prompt?: string;
  integrations?: LMStudioIntegration[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
  context_length?: number;
  store?: boolean;
  previous_response_id?: string;
}

// ── Response Types ──

export interface LMStudioMessageOutput {
  type: "message";
  content: string;
}

export interface LMStudioToolCallOutput {
  type: "tool_call";
  tool: string;
  arguments: Record<string, unknown>;
  output: string;
  provider_info: {
    type: "plugin" | "ephemeral_mcp";
    plugin_id?: string;
    server_label?: string;
  };
}

export interface LMStudioReasoningOutput {
  type: "reasoning";
  content: string;
}

export interface LMStudioInvalidToolCallOutput {
  type: "invalid_tool_call";
  reason: string;
  metadata: {
    type: "invalid_name" | "invalid_arguments";
    tool_name: string;
    arguments?: Record<string, unknown>;
    provider_info?: {
      type: "plugin" | "ephemeral_mcp";
      plugin_id?: string;
      server_label?: string;
    };
  };
}

export type LMStudioOutputItem =
  | LMStudioMessageOutput
  | LMStudioToolCallOutput
  | LMStudioReasoningOutput
  | LMStudioInvalidToolCallOutput;

export interface LMStudioStats {
  input_tokens: number;
  total_output_tokens: number;
  reasoning_output_tokens: number;
  tokens_per_second: number;
  time_to_first_token_seconds: number;
  model_load_time_seconds?: number;
}

export interface LMStudioChatResponse {
  model_instance_id: string;
  output: LMStudioOutputItem[];
  stats: LMStudioStats;
  response_id?: string;
}