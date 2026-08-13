import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent } from "@mastra/core/agent";
import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import { AgentChannels } from "@mastra/core/channels";
import { TaskSignalProvider } from "@mastra/core/signals";
import { askUserTool, webFetchTool } from "@mastra/core/tools";
import { LocalFilesystem, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { DockerSandbox } from "@mastra/docker";
import { Memory } from "@mastra/memory";
import { startScheduleTool, stopScheduleTool } from "../tools/schedule";
import { webSearchTool } from "../tools/web-search";
import { createDurableAgent } from "@mastra/core/agent/durable";
import { createSlackAdapter } from "@chat-adapter/slack";
import { whoamiTool } from "../tools/whoami";
import {
  ModerationProcessor,
  PromptInjectionDetector,
  UnicodeNormalizer,
} from "@mastra/core/processors";

const HOST_WORKSPACE_PATH = resolve("workspace");
const DOCKER_WORKSPACE_PATH = "/workspace";
function requireOpenAICompatibleSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`OpenAI-compatible provider setting missing: ${name}`);
  }
  return value;
}

const OPENAI_COMPATIBLE_BASE_URL = requireOpenAICompatibleSetting("OPENAI_COMPATIBLE_BASE_URL");
const OPENAI_COMPATIBLE_AGENT_MODEL_ID = requireOpenAICompatibleSetting(
  "OPENAI_COMPATIBLE_AGENT_MODEL_ID",
);
const OPENAI_COMPATIBLE_MEMORY_MODEL_ID = requireOpenAICompatibleSetting(
  "OPENAI_COMPATIBLE_MEMORY_MODEL_ID",
);
const OPENAI_COMPATIBLE_GUARDRAIL_MODEL_ID = requireOpenAICompatibleSetting(
  "OPENAI_COMPATIBLE_GUARDRAIL_MODEL_ID",
);
const configuredRequestPriority = process.env.OPENAI_COMPATIBLE_REQUEST_PRIORITY?.trim();
const OPENAI_COMPATIBLE_REQUEST_PRIORITY = configuredRequestPriority
  ? Number(configuredRequestPriority)
  : undefined;

if (
  OPENAI_COMPATIBLE_REQUEST_PRIORITY !== undefined &&
  !Number.isInteger(OPENAI_COMPATIBLE_REQUEST_PRIORITY)
) {
  throw new Error("OPENAI_COMPATIBLE_REQUEST_PRIORITY must be an integer or empty");
}

const OPENAI_COMPATIBLE_PROVIDER_OPTIONS =
  OPENAI_COMPATIBLE_REQUEST_PRIORITY === undefined
    ? undefined
    : {
        openaiCompatible: {
          priority: OPENAI_COMPATIBLE_REQUEST_PRIORITY,
        },
      };

function createMastraOpenAICompatibleModel(modelId: string): OpenAICompatibleConfig {
  return {
    providerId: "openai-compatible",
    modelId,
    url: OPENAI_COMPATIBLE_BASE_URL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  };
}

const AGENT_MODEL = createMastraOpenAICompatibleModel(OPENAI_COMPATIBLE_AGENT_MODEL_ID);
const MEMORY_MODEL = createMastraOpenAICompatibleModel(OPENAI_COMPATIBLE_MEMORY_MODEL_ID);
const GUARDRAIL_MODEL = createMastraOpenAICompatibleModel(OPENAI_COMPATIBLE_GUARDRAIL_MODEL_ID);

const workspace = new Workspace({
  id: "agent-workspace",
  name: "Agent Workspace",
  filesystem: new LocalFilesystem({
    basePath: HOST_WORKSPACE_PATH,
  }),
  sandbox: new DockerSandbox({
    id: "agent-workspace-sandbox",
    image: "node:22-slim",
    workingDir: DOCKER_WORKSPACE_PATH,
    volumes: {
      [HOST_WORKSPACE_PATH]: DOCKER_WORKSPACE_PATH,
    },
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
      requireApproval: true,
    },
  },
});

export const slackChannels = new AgentChannels({
  adapters: {
    slack: {
      adapter: createSlackAdapter({ nativeStreaming: true }),
      streaming: true,
      toolDisplay: "grouped",
      typingStatus: true,
      formatError: () => "Something went wrong while processing your request.",
    },
  },
  handlers: {
    onSubscribedMessage: async (thread, message, defaultHandler, _ctx) => {
      if (/^aside\b/i.test(message.text)) return;
      return await defaultHandler(thread, message);
    },
  },
});

export const slackChannelTools = slackChannels.getTools();

const agentTools = {
  ...slackChannelTools,
  [askUserTool.id]: askUserTool,
  [startScheduleTool.id]: startScheduleTool,
  [stopScheduleTool.id]: stopScheduleTool,
  [webFetchTool.id]: webFetchTool,
  [webSearchTool.id]: webSearchTool,
  [whoamiTool.id]: whoamiTool,
};

const agentToolDescriptionList = formatAgentToolDescriptionList(agentTools);

const agent = new Agent({
  id: "agent",
  name: "Agent",
  description:
    "A general-purpose assistant that can research, manage tasks, work with files, run approved commands, and create schedules.",
  instructions: `You are a concise general-purpose assistant. Complete the user's task using available tools.

Available tools:
${agentToolDescriptionList}

Guidelines:
- Never claim unverified actions, sources, or results.
- Read before editing. Preserve unrelated work, make the smallest coherent change, and verify it.
- Search the web for current or uncertain facts and prefer authoritative sources.
- Ask one concise question only when missing information materially changes the result; otherwise state a reasonable assumption.
- Confirm before broadening scope. Respect approval safeguards and explain destructive actions.
- Protect secrets and personal data.
- Use emoji reactions for lightweight channel acknowledgements when no text is needed.
- Create schedules only when requested and report their IDs.
- After history compaction, resume unfinished work and use recall for missing details.
- Match the user's tone and keep responses concise.

For local file changes, summarize what changed and end with a plain-text URL using ${pathToFileURL(`${HOST_WORKSPACE_PATH}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
`,
  model: AGENT_MODEL,
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
    providerOptions: OPENAI_COMPATIBLE_PROVIDER_OPTIONS,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: MEMORY_MODEL,
        observation: {
          providerOptions: OPENAI_COMPATIBLE_PROVIDER_OPTIONS,
        },
        reflection: {
          providerOptions: OPENAI_COMPATIBLE_PROVIDER_OPTIONS,
        },
      },
    },
  }),
  workspace,
  tools: agentTools,
  signals: [new TaskSignalProvider()],
  inputProcessors: [
    new UnicodeNormalizer({
      stripControlChars: true,
      collapseWhitespace: true,
    }),
    new PromptInjectionDetector({
      model: GUARDRAIL_MODEL,
      providerOptions: OPENAI_COMPATIBLE_PROVIDER_OPTIONS,
      threshold: 0.8,
      strategy: "rewrite",
      detectionTypes: ["injection", "jailbreak", "system-override"],
    }),
    new ModerationProcessor({
      model: GUARDRAIL_MODEL,
      providerOptions: OPENAI_COMPATIBLE_PROVIDER_OPTIONS,
      threshold: 0.7,
      strategy: "block",
      categories: ["hate", "harassment", "violence"],
    }),
  ],
  channels: slackChannels,
});

export const durableAgent = createDurableAgent({ agent });

function formatAgentToolDescriptionList(tools: Record<string, unknown>): string {
  return Object.entries(tools)
    .map(([registeredToolId, tool]) => {
      if (!hasAgentToolMetadata(tool)) {
        throw new Error(`Agent tool metadata missing: ${registeredToolId}`);
      }
      return tool;
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, description }) => `- ${id}: ${description}`)
    .join("\n");
}

function hasAgentToolMetadata(tool: unknown): tool is { id: string; description: string } {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "id" in tool &&
    typeof tool.id === "string" &&
    "description" in tool &&
    typeof tool.description === "string"
  );
}
