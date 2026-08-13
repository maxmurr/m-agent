import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
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

const openAICompatibleProvider = createOpenAICompatible({
  name: "openai-compatible",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  baseURL: OPENAI_COMPATIBLE_BASE_URL,
  includeUsage: true,
  supportsStructuredOutputs: true,
  transformRequestBody:
    OPENAI_COMPATIBLE_REQUEST_PRIORITY === undefined
      ? undefined
      : (requestBody) => ({
          ...requestBody,
          priority: OPENAI_COMPATIBLE_REQUEST_PRIORITY,
        }),
});

const AGENT_MODEL = openAICompatibleProvider.chatModel(OPENAI_COMPATIBLE_AGENT_MODEL_ID);
const MEMORY_MODEL = openAICompatibleProvider.chatModel(OPENAI_COMPATIBLE_MEMORY_MODEL_ID);
const GUARDRAIL_MODEL = openAICompatibleProvider.chatModel(OPENAI_COMPATIBLE_GUARDRAIL_MODEL_ID);

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

const agent = new Agent({
  id: "agent",
  name: "Agent",
  description:
    "A general-purpose assistant that can research, manage tasks, work with files, run approved commands, and create schedules.",
  instructions: `You are a concise general-purpose assistant. Complete the user's task using available tools.

Available tools:
- add_reaction: Add an emoji reaction to a channel message.
- ask_user: Ask the user a question.
- remove_reaction: Remove an emoji reaction from a channel message.
- start_schedule: Start a schedule.
- stop_schedule: Stop a schedule.
- web_fetch: Fetch a URL.
- web_search: Search the web.
- whoami: Get the current user.

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
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: MEMORY_MODEL,
      },
    },
  }),
  workspace,
  tools: {
    ...slackChannelTools,
    ask_user: askUserTool,
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    web_fetch: webFetchTool,
    web_search: webSearchTool,
    whoami: whoamiTool,
  },
  signals: [new TaskSignalProvider()],
  inputProcessors: [
    new UnicodeNormalizer({
      stripControlChars: true,
      collapseWhitespace: true,
    }),
    new PromptInjectionDetector({
      model: GUARDRAIL_MODEL,
      threshold: 0.8,
      strategy: "rewrite",
      detectionTypes: ["injection", "jailbreak", "system-override"],
    }),
    new ModerationProcessor({
      model: GUARDRAIL_MODEL,
      threshold: 0.7,
      strategy: "block",
      categories: ["hate", "harassment", "violence"],
    }),
  ],
  channels: slackChannels,
});

export const durableAgent = createDurableAgent({ agent });
