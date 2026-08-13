import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const EXA_MCP_SEARCH_ENDPOINT = "https://mcp.exa.ai/mcp";
const EXA_SEARCH_TIMEOUT_MS = 25_000;
const EXA_MAX_RESPONSE_BYTES = 1024 * 1024;
const EXA_CONTEXT_MAX_CHARACTERS = 2_000;

const webSearchDepthSchema = z.enum(["auto", "fast", "deep"]);
const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  snippet: z.string().optional(),
  publishedAt: z.string().optional(),
  source: z.string().optional(),
  score: z.number().optional(),
});

type WebSearchDepth = z.infer<typeof webSearchDepthSchema>;
type WebSearchResult = z.infer<typeof webSearchResultSchema>;

class WebSearchToolError extends Error {
  override readonly name = "WebSearchToolError";
}

export const webSearchTool = createTool({
  id: "web_search",
  description:
    "Search the public web for current information and candidate URLs to inspect with web_fetch.",
  strict: true,
  inputSchema: z.object({
    query: z.string().trim().min(1).describe("Search query."),
    maxResults: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .describe("Maximum number of results to return, from 1 through 20."),
    depth: webSearchDepthSchema
      .default("auto")
      .describe("Search depth. deep is accepted as an alias for Exa's fast search."),
  }),
  outputSchema: z.object({
    query: z.string(),
    provider: z.literal("exa"),
    depth: webSearchDepthSchema,
    resultCount: z.number().int().nonnegative(),
    results: z.array(webSearchResultSchema),
  }),
  mcp: {
    annotations: {
      title: "Web Search",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  execute: async ({ query, maxResults, depth }, { abortSignal }) => {
    const requestController = new AbortController();
    let requestTimedOut = false;
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      requestController.abort();
    }, EXA_SEARCH_TIMEOUT_MS);
    timeout.unref();

    const abortSearchRequest = () => requestController.abort();
    if (abortSignal?.aborted) {
      abortSearchRequest();
    } else {
      abortSignal?.addEventListener("abort", abortSearchRequest, { once: true });
    }
    const signal = requestController.signal;

    try {
      const response = await fetch(EXA_MCP_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(createExaSearchRequest(query, maxResults, depth)),
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebSearchToolError(
          `Web search provider rejected request: ${response.status} ${response.statusText}`.trim(),
        );
      }

      const responseText = await readBoundedResponseText(response, signal);
      const searchText = extractExaMcpSearchText(
        responseText,
        response.headers.get("content-type") ?? "",
      );
      const results = parseExaSearchResults(searchText).slice(0, maxResults);

      if (results.length === 0 && !isExplicitNoResultsText(searchText)) {
        throw new WebSearchToolError(
          "Web search provider response invalid: no recognized search results",
        );
      }

      return {
        query,
        provider: "exa" as const,
        depth,
        resultCount: results.length,
        results,
      };
    } catch (error: unknown) {
      if (error instanceof WebSearchToolError) {
        throw error;
      }
      if (abortSignal?.aborted) {
        throw new WebSearchToolError("Web search cancelled");
      }
      if (requestTimedOut) {
        throw new WebSearchToolError("Web search timed out after 25 seconds");
      }
      throw new WebSearchToolError("Web search request failed", { cause: error });
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", abortSearchRequest);
    }
  },
});

function createExaSearchRequest(query: string, maxResults: number, depth: WebSearchDepth) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        type: depth === "deep" ? "fast" : depth,
        numResults: maxResults,
        livecrawl: "fallback",
        contextMaxCharacters: EXA_CONTEXT_MAX_CHARACTERS,
      },
    },
  } as const;
}

async function readBoundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > EXA_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchToolError("Web search provider response too large: 1 MB limit");
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel(signal.reason).catch(() => undefined);
        throw signal.reason;
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytesRead += value.byteLength;
      if (bytesRead > EXA_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebSearchToolError("Web search provider response too large: 1 MB limit");
      }
      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function extractExaMcpSearchText(body: string, contentType: string): string {
  const serializedPayloads = isServerSentEventResponse(body, contentType)
    ? parseServerSentEventData(body)
    : [body];
  const textParts: string[] = [];
  let firstInvalidPayload: unknown;

  for (const serializedPayload of serializedPayloads) {
    let payload: unknown;
    try {
      payload = JSON.parse(serializedPayload);
    } catch (error: unknown) {
      firstInvalidPayload ??= error;
      continue;
    }

    try {
      textParts.push(...extractMcpTextParts(payload));
    } catch (error: unknown) {
      if (error instanceof WebSearchToolError && error.message.includes("returned an error")) {
        throw error;
      }
      firstInvalidPayload ??= error;
    }
  }

  const text = textParts.join("\n\n").trim();
  if (!text) {
    throw new WebSearchToolError("Web search provider response invalid", {
      cause: firstInvalidPayload,
    });
  }
  return text;
}

function extractMcpTextParts(payload: unknown): string[] {
  if (!isRecord(payload)) {
    throw new WebSearchToolError("Web search provider response invalid: expected object payload");
  }
  if ("error" in payload) {
    throw new WebSearchToolError("Web search provider returned an error");
  }

  const result = payload.result;
  if (!isRecord(result)) {
    throw new WebSearchToolError("Web search provider response invalid: missing result object");
  }
  if (result.isError === true) {
    throw new WebSearchToolError("Web search provider returned an error");
  }
  if (!Array.isArray(result.content)) {
    throw new WebSearchToolError("Web search provider response invalid: missing result content");
  }

  return result.content.flatMap((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return [];
    const text = item.text.trim();
    return text ? [text] : [];
  });
}

function parseServerSentEventData(body: string): string[] {
  const payloads: string[] = [];
  let currentDataLines: string[] = [];

  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("data:")) {
      currentDataLines.push(line.slice(5).trim());
      continue;
    }
    if (!line.trim() && currentDataLines.length > 0) {
      payloads.push(currentDataLines.join("\n"));
      currentDataLines = [];
    }
  }

  if (currentDataLines.length > 0) {
    payloads.push(currentDataLines.join("\n"));
  }
  return payloads.filter(Boolean);
}

function isServerSentEventResponse(body: string, contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream") || /^data:/m.test(body);
}

function parseExaSearchResults(searchText: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  for (const section of splitExaSearchSections(searchText)) {
    const result = parseExaSearchSection(section);
    if (result) results.push(result);
  }
  return results;
}

function splitExaSearchSections(searchText: string): string[] {
  const sections: string[] = [];
  let currentLines: string[] = [];
  let currentHasResultBody = false;

  for (const line of searchText.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("Title: ") && currentLines.length > 0 && currentHasResultBody) {
      sections.push(currentLines.join("\n").trim());
      currentLines = [line];
      currentHasResultBody = false;
      continue;
    }
    if (line.startsWith("URL: ") || line.startsWith("Text:") || line.startsWith("Highlights:")) {
      currentHasResultBody = true;
    }
    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    sections.push(currentLines.join("\n").trim());
  }
  return sections.filter(Boolean);
}

function parseExaSearchSection(section: string): WebSearchResult | undefined {
  let title = "";
  let url = "";
  let publishedAt: string | undefined;
  let source: string | undefined;
  let score: number | undefined;
  let readingSnippet = false;
  const snippetLines: string[] = [];

  for (const line of section.split("\n")) {
    if (!readingSnippet && line.startsWith("Title: ")) {
      title = line.slice("Title: ".length).trim();
    } else if (!readingSnippet && line.startsWith("URL: ")) {
      url = line.slice("URL: ".length).trim();
    } else if (!readingSnippet && line.startsWith("Published Date: ")) {
      publishedAt = normalizeExaMetadata(line.slice("Published Date: ".length));
    } else if (!readingSnippet && line.startsWith("Published: ")) {
      publishedAt = normalizeExaMetadata(line.slice("Published: ".length));
    } else if (!readingSnippet && line.startsWith("Source: ")) {
      source = normalizeExaMetadata(line.slice("Source: ".length));
    } else if (!readingSnippet && line.startsWith("Author: ") && !source) {
      source = normalizeExaMetadata(line.slice("Author: ".length));
    } else if (!readingSnippet && line.startsWith("Score: ")) {
      const parsedScore = Number.parseFloat(line.slice("Score: ".length).trim());
      if (Number.isFinite(parsedScore)) score = parsedScore;
    } else if (!readingSnippet && (line.startsWith("Text:") || line.startsWith("Highlights:"))) {
      readingSnippet = true;
      snippetLines.push(line.slice(line.indexOf(":") + 1).trim());
    } else if (readingSnippet) {
      snippetLines.push(line);
    }
  }

  const publicUrl = parsePublicResultUrl(url);
  if (!publicUrl) return undefined;

  const snippet = summarizeExaSnippet(snippetLines.join("\n"), title);
  return {
    title: title || publicUrl,
    url: publicUrl,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(source ? { source } : {}),
    ...(score === undefined ? {} : { score }),
  };
}

function parsePublicResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function summarizeExaSnippet(value: string, title: string): string | undefined {
  let snippet = value
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!snippet) return undefined;

  if (title && snippet.toLowerCase().startsWith(title.trim().toLowerCase())) {
    snippet = snippet.slice(title.trim().length).trim();
  }
  if (!snippet) return undefined;
  return snippet.length <= 280 ? snippet : `${snippet.slice(0, 277).trimEnd()}...`;
}

function normalizeExaMetadata(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return ["n/a", "na", "none", "null", "undefined", "unknown"].includes(normalized.toLowerCase())
    ? undefined
    : normalized;
}

function isExplicitNoResultsText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "no results found" ||
    normalized.startsWith("no results found") ||
    normalized.includes("no relevant results")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
