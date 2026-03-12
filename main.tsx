// x-agent: LLM Agent with X/Twitter read-only tools and Ink TUI
// Everything in one file.

import { Command } from "commander";
import { Box, Text, render, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/index.js";
import React, { useState, useCallback, useRef, type FC } from "react";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program
	.name("x-agent")
	.description("X/Twitter research agent with LLM-powered tools and TUI")
	.version("0.1.0")
	.option("-m, --model <model>", "LLM model name", process.env.OPENAI_MODEL ?? "gpt-4o")
	.option("-b, --base-url <url>", "OpenAI-compatible API base URL", process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
	.parse(process.argv);

const cliOpts = program.opts<{ model: string; baseUrl: string }>();

// ─── Config ──────────────────────────────────────────────────────────────────

function env(key: string, fallback?: string): string {
	const v = process.env[key] ?? fallback;
	if (!v) {
		console.error(`Missing env: ${key}`);
		process.exit(1);
	}
	return v;
}

const config = {
	openaiApiKey: env("OPENAI_API_KEY"),
	openaiBaseUrl: cliOpts.baseUrl,
	model: cliOpts.model,
	xBearerToken: env("X_BEARER_TOKEN"),
};

const openai = new OpenAI({
	apiKey: config.openaiApiKey,
	baseURL: config.openaiBaseUrl,
});

// ─── X API Client ────────────────────────────────────────────────────────────

const X_BASE = "https://api.x.com/2";

const TWEET_FIELDS = "author_id,created_at,public_metrics,entities,referenced_tweets,source,text";
const USER_FIELDS = "created_at,description,public_metrics,username,name,verified,location,url";
const EXPANSIONS = "author_id,referenced_tweets.id";

interface XApiUsage {
	requests: number;
	rateLimitRemaining: number | null;
}

const xUsage: XApiUsage = { requests: 0, rateLimitRemaining: null };

async function xGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
	const url = new URL(`${X_BASE}${path}`);
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}

	const res = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${config.xBearerToken}`,
			"User-Agent": "x-agent/0.1",
		},
	});

	xUsage.requests++;
	const rl = res.headers.get("x-rate-limit-remaining");
	if (rl) xUsage.rateLimitRemaining = Number.parseInt(rl, 10);

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`X API ${res.status}: ${body}`);
	}
	return res.json();
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const tools: ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "search_recent_tweets",
			description: "Search recent tweets (last 7 days) by query string",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query (X search syntax)" },
					max_results: { type: "number", description: "Number of results (10-100)", default: 10 },
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_by_username",
			description: "Look up an X/Twitter user profile by @username",
			parameters: {
				type: "object",
				properties: {
					username: { type: "string", description: "Username without @" },
				},
				required: ["username"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_tweet_by_id",
			description: "Get a single tweet by its ID",
			parameters: {
				type: "object",
				properties: {
					tweet_id: { type: "string", description: "Tweet ID" },
				},
				required: ["tweet_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_tweets",
			description: "Get recent tweets posted by a user (requires user ID, not username)",
			parameters: {
				type: "object",
				properties: {
					user_id: { type: "string", description: "User ID" },
					max_results: { type: "number", description: "Number of results (5-100)", default: 10 },
				},
				required: ["user_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_mentions",
			description: "Get recent tweets mentioning a user (requires user ID)",
			parameters: {
				type: "object",
				properties: {
					user_id: { type: "string", description: "User ID" },
					max_results: { type: "number", description: "Number of results (5-100)", default: 10 },
				},
				required: ["user_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_followers",
			description: "Get followers of a user (requires user ID)",
			parameters: {
				type: "object",
				properties: {
					user_id: { type: "string", description: "User ID" },
					max_results: { type: "number", description: "Number of results (1-100)", default: 20 },
				},
				required: ["user_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_following",
			description: "Get users that a user follows (requires user ID)",
			parameters: {
				type: "object",
				properties: {
					user_id: { type: "string", description: "User ID" },
					max_results: { type: "number", description: "Number of results (1-100)", default: 20 },
				},
				required: ["user_id"],
			},
		},
	},
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

const toolHandlers: Record<string, ToolHandler> = {
	search_recent_tweets: async (args) => {
		const data = await xGet("/tweets/search/recent", {
			query: String(args.query),
			max_results: String(args.max_results ?? 10),
			"tweet.fields": TWEET_FIELDS,
			"user.fields": USER_FIELDS,
			expansions: EXPANSIONS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_user_by_username: async (args) => {
		const username = String(args.username).replace(/^@/, "");
		const data = await xGet(`/users/by/username/${username}`, {
			"user.fields": USER_FIELDS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_tweet_by_id: async (args) => {
		const data = await xGet(`/tweets/${args.tweet_id}`, {
			"tweet.fields": TWEET_FIELDS,
			"user.fields": USER_FIELDS,
			expansions: EXPANSIONS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_user_tweets: async (args) => {
		const data = await xGet(`/users/${args.user_id}/tweets`, {
			max_results: String(args.max_results ?? 10),
			"tweet.fields": TWEET_FIELDS,
			"user.fields": USER_FIELDS,
			expansions: EXPANSIONS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_user_mentions: async (args) => {
		const data = await xGet(`/users/${args.user_id}/mentions`, {
			max_results: String(args.max_results ?? 10),
			"tweet.fields": TWEET_FIELDS,
			"user.fields": USER_FIELDS,
			expansions: EXPANSIONS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_user_followers: async (args) => {
		const data = await xGet(`/users/${args.user_id}/followers`, {
			max_results: String(args.max_results ?? 20),
			"user.fields": USER_FIELDS,
		});
		return JSON.stringify(data, null, 2);
	},

	get_user_following: async (args) => {
		const data = await xGet(`/users/${args.user_id}/following`, {
			max_results: String(args.max_results ?? 20),
			"user.fields": USER_FIELDS,
		});
		return JSON.stringify(data, null, 2);
	},
};

// ─── Token Usage ─────────────────────────────────────────────────────────────

interface LlmUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	requests: number;
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

interface AgentCallbacks {
	onAssistantMessage: (content: string) => void;
	onToolCall: (name: string, args: string) => void;
	onToolResult: (name: string, result: string) => void;
	onUsageUpdate: (llm: LlmUsage, x: XApiUsage) => void;
	onError: (error: string) => void;
	onDone: () => void;
}

async function runAgentLoop(
	history: ChatCompletionMessageParam[],
	callbacks: AgentCallbacks,
): Promise<ChatCompletionMessageParam[]> {
	const messages = [...history];
	const llmUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

	const SYSTEM_PROMPT = `You are an X/Twitter research assistant. You can search tweets, look up users, and retrieve timelines using the X API.

When a user asks about a person on X, first look them up by username to get their user ID, then use that ID for further queries.
Be concise in your responses. Format data clearly.`;

	const systemMsg: ChatCompletionMessageParam = { role: "system", content: SYSTEM_PROMPT };

	let done = false;
	while (!done) {
		let response: OpenAI.Chat.Completions.ChatCompletion;
		try {
			response = await openai.chat.completions.create({
				model: config.model,
				messages: [systemMsg, ...messages],
				tools,
			});
		} catch (e) {
			// If tool calling fails (e.g. model generates bad tool call), retry without tools
			const errMsg = e instanceof Error ? e.message : String(e);
			if (errMsg.includes("400") || errMsg.includes("failed_generation")) {
				try {
					response = await openai.chat.completions.create({
						model: config.model,
						messages: [systemMsg, ...messages],
					});
				} catch (retryErr) {
					callbacks.onError(
						`LLM error: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					);
					break;
				}
			} else {
				callbacks.onError(`LLM error: ${errMsg}`);
				break;
			}
		}

		llmUsage.requests++;
		if (response.usage) {
			llmUsage.promptTokens += response.usage.prompt_tokens;
			llmUsage.completionTokens += response.usage.completion_tokens;
			llmUsage.totalTokens += response.usage.total_tokens;
		}
		callbacks.onUsageUpdate({ ...llmUsage }, { ...xUsage });

		const choice = response.choices[0];
		if (!choice) {
			callbacks.onError("No response from LLM");
			done = true;
			break;
		}

		const msg = choice.message;
		messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

		if (msg.tool_calls && msg.tool_calls.length > 0) {
			for (const tc of msg.tool_calls) {
				const fnName = tc.function.name;
				const fnArgs = tc.function.arguments;
				callbacks.onToolCall(fnName, fnArgs);

				let result: string;
				try {
					const handler = toolHandlers[fnName];
					if (!handler) throw new Error(`Unknown tool: ${fnName}`);
					const parsed = JSON.parse(fnArgs);
					result = await handler(parsed);
				} catch (e) {
					result = `Error: ${e instanceof Error ? e.message : String(e)}`;
				}

				callbacks.onToolResult(fnName, result);
				callbacks.onUsageUpdate({ ...llmUsage }, { ...xUsage });
				messages.push({ role: "tool", tool_call_id: tc.id, content: result });
			}
		} else {
			if (msg.content) {
				callbacks.onAssistantMessage(msg.content);
			}
			done = true;
		}
	}

	callbacks.onDone();
	return messages;
}

// ─── TUI Components ─────────────────────────────────────────────────────────

interface DisplayMessage {
	role: "user" | "assistant" | "tool-call" | "tool-result";
	content: string;
	toolName?: string;
	toolArgs?: string;
}

interface ToolStatus {
	name: string;
	status: "calling" | "done";
}

// Render all messages into plain lines for scrolling
function renderLines(
	messages: DisplayMessage[],
): { text: string; color?: string; dim?: boolean }[] {
	const lines: { text: string; color?: string; dim?: boolean }[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			lines.push({ text: `> ${m.content}`, color: "cyan" });
			lines.push({ text: "" });
		} else if (m.role === "assistant") {
			for (const l of m.content.split("\n")) {
				lines.push({ text: l, color: "green" });
			}
			lines.push({ text: "" });
		} else if (m.role === "tool-call") {
			lines.push({ text: `── tool: ${m.toolName}`, color: "yellow" });
			if (m.toolArgs) {
				lines.push({ text: `   args: ${m.toolArgs}`, dim: true });
			}
		} else if (m.role === "tool-result") {
			const resultLines = m.content.split("\n");
			for (const l of resultLines) {
				lines.push({ text: `   ${l}`, dim: true });
			}
			lines.push({ text: "" });
		}
	}
	return lines;
}

const Header: FC = () => (
	<Box borderStyle="single" paddingX={1} flexDirection="row" justifyContent="space-between">
		<Text bold color="cyan">
			x-agent
		</Text>
		<Text dimColor>
			{config.model} @ {config.openaiBaseUrl}
		</Text>
	</Box>
);

const ScrollView: FC<{
	lines: { text: string; color?: string; dim?: boolean }[];
	scrollOffset: number;
	viewHeight: number;
}> = ({ lines, scrollOffset, viewHeight }) => {
	const visible = lines.slice(scrollOffset, scrollOffset + viewHeight);
	const atBottom = scrollOffset + viewHeight >= lines.length;

	return (
		<Box flexDirection="column" paddingX={1} height={viewHeight}>
			{visible.map((line, i) => (
				<Text
					key={`line-${scrollOffset + i}`}
					color={line.color as "cyan" | "green" | "yellow" | undefined}
					dimColor={line.dim}
				>
					{line.text || " "}
				</Text>
			))}
			{!atBottom && lines.length > viewHeight ? (
				<Text dimColor inverse>
					{" "}
					↑↓ scroll | {lines.length - scrollOffset - viewHeight} more lines below{" "}
				</Text>
			) : null}
		</Box>
	);
};

const ToolIndicator: FC<{ tools: ToolStatus[] }> = ({ tools: toolStatuses }) => {
	const active = toolStatuses.filter((t) => t.status === "calling");
	if (active.length === 0) return null;

	return (
		<Box paddingX={1}>
			<Text color="yellow">
				<Spinner type="dots" />{" "}
			</Text>
			<Text color="yellow">Calling: {active.map((t) => t.name).join(", ")}</Text>
		</Box>
	);
};

const UsageBar: FC<{ llm: LlmUsage; x: XApiUsage }> = ({ llm, x }) => (
	<Box borderStyle="single" paddingX={1} flexDirection="row" justifyContent="space-between">
		<Text dimColor>
			LLM: {llm.totalTokens} tok ({llm.promptTokens}p+{llm.completionTokens}c) | {llm.requests} req
		</Text>
		<Text dimColor>
			X API: {x.requests} req
			{x.rateLimitRemaining !== null ? ` | limit remaining: ${x.rateLimitRemaining}` : ""}
		</Text>
	</Box>
);

const App: FC = () => {
	const { exit } = useApp();
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<DisplayMessage[]>([]);
	const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [scrollOffset, setScrollOffset] = useState(0);
	const [pinToBottom, setPinToBottom] = useState(true);
	const [llmUsage, setLlmUsage] = useState<LlmUsage>({
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		requests: 0,
	});
	const [xApiUsage, setXApiUsage] = useState<XApiUsage>({ requests: 0, rateLimitRemaining: null });
	const historyRef = useRef<ChatCompletionMessageParam[]>([]);

	const termHeight = process.stdout.rows || 24;
	// header(3) + usage(3) + input(1) + tool-indicator(1) + scroll-hint(1) = ~9
	const viewHeight = Math.max(4, termHeight - 9);

	const allLines = renderLines(messages);

	// Auto-scroll to bottom when pinned and new content arrives
	const effectiveOffset = pinToBottom ? Math.max(0, allLines.length - viewHeight) : scrollOffset;

	useInput((ch, key) => {
		if (key.ctrl && ch.toLowerCase() === "c") {
			exit();
			return;
		}
		if (key.upArrow) {
			setPinToBottom(false);
			setScrollOffset((prev) => Math.max(0, (pinToBottom ? effectiveOffset : prev) - 3));
			return;
		}
		if (key.downArrow) {
			const maxOffset = Math.max(0, allLines.length - viewHeight);
			const next = Math.min(maxOffset, (pinToBottom ? effectiveOffset : scrollOffset) + 3);
			if (next >= maxOffset) {
				setPinToBottom(true);
			}
			setScrollOffset(next);
			return;
		}
	});

	const handleSubmit = useCallback(
		async (value: string) => {
			const trimmed = value.trim();
			if (!trimmed || isLoading) return;

			setInput("");
			setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
			setIsLoading(true);
			setPinToBottom(true);

			historyRef.current.push({ role: "user", content: trimmed });

			try {
				const newHistory = await runAgentLoop(historyRef.current, {
					onAssistantMessage: (content) => {
						setMessages((prev) => [...prev, { role: "assistant", content }]);
						setPinToBottom(true);
					},
					onToolCall: (name, args) => {
						setToolStatuses((prev) => [...prev, { name, status: "calling" }]);
						setMessages((prev) => [
							...prev,
							{ role: "tool-call", content: "", toolName: name, toolArgs: args },
						]);
						setPinToBottom(true);
					},
					onToolResult: (name, result) => {
						setToolStatuses((prev) =>
							prev.map((t) =>
								t.name === name && t.status === "calling" ? { ...t, status: "done" } : t,
							),
						);
						setMessages((prev) => [
							...prev,
							{ role: "tool-result", content: result, toolName: name },
						]);
						setPinToBottom(true);
					},
					onUsageUpdate: (llm, x) => {
						setLlmUsage(llm);
						setXApiUsage(x);
					},
					onError: (error) => {
						setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${error}` }]);
					},
					onDone: () => {
						setIsLoading(false);
						setToolStatuses([]);
					},
				});
				historyRef.current = newHistory;
			} catch (e) {
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					},
				]);
				setIsLoading(false);
				setToolStatuses([]);
			}
		},
		[isLoading],
	);

	return (
		<Box flexDirection="column" height={termHeight}>
			<Header />
			<ScrollView lines={allLines} scrollOffset={effectiveOffset} viewHeight={viewHeight} />
			<ToolIndicator tools={toolStatuses} />
			<UsageBar llm={llmUsage} x={xApiUsage} />
			<Box paddingX={1}>
				<Text color="cyan" bold>
					{">"}{" "}
				</Text>
				{isLoading ? (
					<Text dimColor>
						<Spinner type="dots" /> thinking...
					</Text>
				) : (
					<TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
				)}
			</Box>
		</Box>
	);
};

// ─── Entry Point ─────────────────────────────────────────────────────────────

// Guard: only render when run directly (not imported by tests)
const isMain =
	process.argv[1] &&
	(process.argv[1].endsWith("main.tsx") ||
		process.argv[1].endsWith("main.ts") ||
		process.argv[1].includes("x-agent") ||
		process.argv[1].includes("bin/x-agent"));

if (isMain) {
	render(React.createElement(App));
}

// Exports for testing
export {
	config,
	xGet,
	toolHandlers,
	tools,
	runAgentLoop,
	type LlmUsage,
	type XApiUsage,
	type AgentCallbacks,
	type DisplayMessage,
	type ToolHandler,
};
