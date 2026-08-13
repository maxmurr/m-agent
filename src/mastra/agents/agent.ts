import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent } from "@mastra/core/agent";
import type { ModelRouterModelId } from "@mastra/core/llm";
import { AgentChannels } from "@mastra/core/channels";
import { TaskSignalProvider } from "@mastra/core/signals";
import { askUserTool, webFetchTool, type Tool } from "@mastra/core/tools";
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
  ToolSearchProcessor,
  UnicodeNormalizer,
} from "@mastra/core/processors";

const HOST_WORKSPACE_PATH = resolve("workspace");
const DOCKER_WORKSPACE_PATH = "/workspace";
const VERCEL_AI_GATEWAY_PRIMARY_MODEL = "vercel/alibaba/qwen3.6-27b" satisfies ModelRouterModelId;
const VERCEL_AI_GATEWAY_GUARDRAIL_MODEL =
  "vercel/openai/gpt-oss-safeguard-20b" satisfies ModelRouterModelId;

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

export const slackChannelTools = slackChannels.getTools() as Record<string, Tool>;

const searchableAgentTools = {
  ...slackChannelTools,
  [startScheduleTool.id]: startScheduleTool,
  [stopScheduleTool.id]: stopScheduleTool,
  [webFetchTool.id]: webFetchTool,
  [webSearchTool.id]: webSearchTool,
  [whoamiTool.id]: whoamiTool,
};

const optionalToolSearchProcessor = new ToolSearchProcessor({
  tools: searchableAgentTools,
  storage: "context",
  search: {
    topK: 3,
    autoLoad: true,
  },
});

const agent = new Agent({
  id: "agent",
  name: "Agent",
  description:
    "A general-purpose assistant that can research, manage tasks, work with files, run approved commands, and create schedules.",
  instructions: `You are a concise general-purpose assistant. Complete the user's task using available tools.

Guidelines:
- Never claim unverified actions, sources, or results.
- Read before editing. Preserve unrelated work, make the smallest coherent change, and verify it.
- Search the web for current or uncertain facts and prefer authoritative sources.
- Use search_tools to discover optional capabilities before assuming they are unavailable. Matches load automatically and become callable on the next turn.
- Ask one concise question only when missing information materially changes the result; otherwise state a reasonable assumption.
- Confirm before broadening scope. Respect approval safeguards and explain destructive actions.
- Protect secrets and personal data.
- Use emoji reactions for lightweight channel acknowledgements when no text is needed.
- Create schedules only when requested and report their IDs.
- After history compaction, resume unfinished work and use recall for missing details.
- Match the user's tone and keep responses concise.

For local file changes, summarize what changed and end with a plain-text URL using ${pathToFileURL(`${HOST_WORKSPACE_PATH}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
`,
  model: VERCEL_AI_GATEWAY_PRIMARY_MODEL,
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: VERCEL_AI_GATEWAY_PRIMARY_MODEL,
      },
    },
  }),
  workspace,
  tools: {
    [askUserTool.id]: askUserTool,
  },
  signals: [new TaskSignalProvider()],
  inputProcessors: [
    new UnicodeNormalizer({
      stripControlChars: true,
      collapseWhitespace: true,
    }),
    new PromptInjectionDetector({
      model: VERCEL_AI_GATEWAY_GUARDRAIL_MODEL,
      threshold: 0.8,
      strategy: "rewrite",
      detectionTypes: ["injection", "jailbreak", "system-override"],
    }),
    new ModerationProcessor({
      model: VERCEL_AI_GATEWAY_GUARDRAIL_MODEL,
      threshold: 0.7,
      strategy: "block",
      categories: ["hate", "harassment", "violence"],
    }),
    optionalToolSearchProcessor,
  ],
  channels: slackChannels,
});

export const durableAgent = createDurableAgent({ agent });
