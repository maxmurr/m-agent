import { pathToFileURL } from "node:url";
import { Agent } from "@mastra/core/agent";
import { TaskSignalProvider } from "@mastra/core/signals";
import { askUserTool, webFetchTool, webSearchTool } from "@mastra/core/tools";
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { startScheduleTool, stopScheduleTool } from "../tools/schedule";
import { createDurableAgent } from "@mastra/core/agent/durable";
import { createSlackAdapter } from "@chat-adapter/slack";
import { whoamiTool } from "../tools/whoami";
import {
  ModerationProcessor,
  PromptInjectionDetector,
  UnicodeNormalizer,
} from "@mastra/core/processors";

const WORKSPACE_PATH = "workspace";
const AGENT_MODEL = "openai/gpt-5.6-terra";
const MEMORY_MODEL = "openai/gpt-5-mini";
const GUARDRAIL_MODEL = "openai/gpt-5-nano";

const workspace = new Workspace({
  id: "agent-workspace",
  name: "Agent Workspace",
  filesystem: new LocalFilesystem({
    basePath: WORKSPACE_PATH,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: WORKSPACE_PATH,
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

const agent = new Agent({
  id: "agent",
  name: "Agent",
  description:
    "A general-purpose assistant that can research, manage tasks, work with files, run approved commands, and create schedules.",
  instructions: `You are a concise general-purpose assistant. Complete the user's task using available tools.

Available tools:
- ask_user: Ask the user a question.
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
- Create schedules only when requested and report their IDs.
- After history compaction, resume unfinished work and use recall for missing details.
- Match the user's tone and keep responses concise.

For local file changes, summarize what changed and end with a plain-text URL using ${pathToFileURL(`${WORKSPACE_PATH}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
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
  channels: {
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
  },
});

export const durableAgent = createDurableAgent({ agent });
