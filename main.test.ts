import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolHandlers, tools } from "./main.jsx";

describe("tool definitions", () => {
	it("all tools have matching handlers", () => {
		for (const tool of tools) {
			expect(toolHandlers[tool.function.name]).toBeDefined();
		}
	});

	it("has expected tool count", () => {
		expect(tools.length).toBe(7);
	});

	it("all tools are functions with required fields", () => {
		for (const tool of tools) {
			expect(tool.type).toBe("function");
			expect(tool.function.name).toBeTruthy();
			expect(tool.function.description).toBeTruthy();
			expect(tool.function.parameters).toBeDefined();
		}
	});
});

describe("tool handlers", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("search_recent_tweets calls X API with correct params", async () => {
		const mockResponse = { data: [{ id: "1", text: "hello" }] };
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockResponse),
				headers: new Headers({ "x-rate-limit-remaining": "299" }),
			}),
		);

		const result = await toolHandlers.search_recent_tweets({ query: "test", max_results: 10 });
		const parsed = JSON.parse(result);
		expect(parsed.data[0].text).toBe("hello");

		const fetchCall = vi.mocked(fetch).mock.calls[0];
		const url = new URL(fetchCall[0] as string);
		expect(url.pathname).toBe("/2/tweets/search/recent");
		expect(url.searchParams.get("query")).toBe("test");
	});

	it("get_user_by_username strips @ prefix", async () => {
		const mockResponse = { data: { id: "123", username: "testuser" } };
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockResponse),
				headers: new Headers(),
			}),
		);

		const result = await toolHandlers.get_user_by_username({ username: "@testuser" });
		const parsed = JSON.parse(result);
		expect(parsed.data.username).toBe("testuser");

		const fetchCall = vi.mocked(fetch).mock.calls[0];
		const url = new URL(fetchCall[0] as string);
		expect(url.pathname).toBe("/2/users/by/username/testuser");
	});

	it("get_tweet_by_id calls correct endpoint", async () => {
		const mockResponse = { data: { id: "456", text: "a tweet" } };
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockResponse),
				headers: new Headers(),
			}),
		);

		const result = await toolHandlers.get_tweet_by_id({ tweet_id: "456" });
		const parsed = JSON.parse(result);
		expect(parsed.data.id).toBe("456");
	});

	it("handler returns error string on API failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 429,
				text: () => Promise.resolve("Rate limit exceeded"),
				headers: new Headers(),
			}),
		);

		await expect(toolHandlers.search_recent_tweets({ query: "test" })).rejects.toThrow("429");
	});
});
