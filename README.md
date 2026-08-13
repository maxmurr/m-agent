# mastra-cht-with-data

Welcome to your new [Mastra](https://mastra.ai) project! We're excited to see what you build.

This starter provides you with a general-purpose Mastra agent that can research current information, manage multi-step tasks, work with local files, run approved shell commands in Docker, and create recurring schedules.

## Features

- A persistent LLM wiki in `src/mastra/public/workspace/`, bind-mounted into a Docker sandbox for command execution
- Approval gates for file changes, deletions, and shell commands
- Native Slack emoji reaction tools and reaction event handling
- Conversation memory, generated thread titles, and task tracking
- Automatic context compaction with task checkpoints, raw-history recall, and continuation hints
- Built-in web search and direct web page fetching
- Recurring schedules that persist across restarts
- Local libSQL storage and DuckDB observability, with optional Turso storage
- A bundled Mastra skill that helps coding agents use current Mastra APIs

## Get started

Set your OpenAI API key in `.env`:

```dotenv
OPENAI_API_KEY=sk-...
```

Start Docker Engine, then run:

```shell
pnpm run dev
```

Mastra pulls `node:22-slim` on first sandbox startup.

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview).

Select **Agent** in Mastra Studio and try one of these prompts:

- `Get the weather forecast for Austin this weekend.`
- `Create a landing page for a Japanese sakura festival.`
- `Check the SPCX stock price now, then check it every minute.`

The agent asks for approval before it changes files, runs commands, or creates a schedule. When it creates a schedule, it returns an ID that you can use to pause the schedule.

## Slack setup and HITL approvals

Slack sends messages and approval-button clicks to this generated webhook path:

```text
/api/agents/agent/channels/slack/webhook
```

Both Slack Request URLs must use the same public HTTPS endpoint:

```text
https://YOUR-PUBLIC-HOST/api/agents/agent/channels/slack/webhook
```

1. Start Mastra:

   ```shell
   pnpm run dev
   ```

2. In another terminal, expose port 4111:

   ```shell
   ngrok http 4111
   ```

3. Create or update the Slack app using `slack/mastra-agent-manifest.example.yaml`. Replace `replace-me.example.com` with the tunnel or production host.
4. In Slack app settings, set the full webhook URL in both locations:
   - **Event Subscriptions → Request URL**
   - **Interactivity & Shortcuts → Request URL**
5. Confirm bot scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, and `users:read`.
6. Confirm bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`, `reaction_added`, and `reaction_removed`.
7. Reinstall the Slack app after changing scopes, then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in `.env`.
8. Verify credentials, scopes, signature rejection, and signed webhook challenge:

   ```shell
   pnpm run check:slack -- https://YOUR-PUBLIC-HOST
   ```

Test HITL in Slack with:

```text
Create approval-test.txt containing hello
```

Expected flow: agent proposes `mastra_workspace_write_file`, Slack shows Approve and Deny buttons, and file changes only after approval. Deny first and confirm file remains absent; repeat and approve. All workspace mutations, shell execution, process termination, and schedule creation require approval.

## LLM wiki workspace

`src/mastra/public/workspace/` contains a ready-to-use [LLM Wiki](https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md): immutable source material in `raw/`, agent-maintained synthesis in `wiki/`, and operating rules in `AGENTS.md` plus `schema/`.

To use it:

1. Add a source file under `raw/`.
2. Ask the agent to ingest that file.
3. Ask questions against the wiki or request a wiki lint pass.

Open the workspace directory as an Obsidian vault to browse links and graph view. See its `README.md` for workflows and conventions.

## Workspace safety

The local filesystem tools stay inside `src/mastra/public/workspace/` during development. Shell commands run in a long-lived Docker container with only that workspace bind-mounted at `/workspace`. Docker isolation reduces host access but is not a complete security boundary. Files under `src/mastra/public/` are copied into builds and may be served as static assets; do not store sensitive sources there unless deployment access is controlled. Keep Docker Engine running, review command approvals carefully, and do not expose this template through an unauthenticated public server.

## Storage

The default `file:./mastra.db` database stores agent memory, tasks, and schedules locally. To use Turso, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`.

Recurring schedules continue to use model tokens until you pause them. Ask the agent to pause a schedule with the ID returned by `start_schedule`.

## Long-conversation continuity

Mastra Observational Memory compacts history after roughly 30,000 message tokens and retains roughly 20,000 recent tokens. Checkpoints preserve goals, constraints, progress, decisions, exact technical details, and the next unfinished action. Mastra injects its built-in `current-task`, `suggested-response`, and continuation reminder into the active run, so work resumes without a separate follow-up prompt. The memory-provided `recall` tool can recover exact raw messages from the current thread when a checkpoint is insufficient.

Adjust thresholds and checkpoint instructions in `src/mastra/agents/agent.ts`.

## Making it yours

- Edit `src/mastra/agents/agent.ts` to change the model, instructions, memory, workspace, or approval policy.
- Edit `src/mastra/tools/` to customize scheduling.
- Edit `src/mastra/index.ts` to change storage and observability.
- Add immutable source files under `src/mastra/public/workspace/raw/`; let the agent maintain `wiki/`.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework. Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).
