import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from "@mastra/core/storage";
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { durableAgent, slackChannels, slackChannelTools } from "./agents/agent";
import { startScheduleTool, stopScheduleTool } from "./tools/schedule";

export const mastra = new Mastra({
  agents: { durableAgent },
  tools: { ...slackChannelTools, startScheduleTool, stopScheduleTool },
  storage: new MastraCompositeStore({
    id: "composite-storage",
    default: new LibSQLStore({
      id: "mastra-storage",
      url: process.env.TURSO_DATABASE_URL || "file:./mastra.db",
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore("observability"),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

void slackChannels
  .initialize(mastra)
  .then(() => {
    slackChannels.sdk?.onReaction((event) => {
      mastra.getLogger().info("Slack reaction received", {
        action: event.added ? "added" : "removed",
        emoji: event.rawEmoji,
        messageId: event.messageId,
        threadId: event.threadId,
        userId: event.user.userId,
      });
    });
  })
  .catch((error) => {
    mastra.getLogger().error("Slack reaction handler registration failed", error);
  });
