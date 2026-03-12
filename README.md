# x-agent

LLM agent with X/Twitter read-only tools, powered by OpenAI-compatible API and Ink TUI.

## Setup

```bash
npm install
npm run build
```

## Install as CLI

```bash
npm run build
npm link
x-agent --help
```

## Environment Variables

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional, default
export OPENAI_MODEL="gpt-4o"                         # optional, default
export X_BEARER_TOKEN="your-x-bearer-token"
```

Get your X Bearer Token from the [X Developer Portal](https://developer.x.com/).

## Run

```bash
npm start
# or as CLI
x-agent
x-agent --model claude-sonnet-4-6 --base-url http://localhost:8080/v1
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-m, --model <model>` | LLM model name | `gpt-4o` / `$OPENAI_MODEL` |
| `-b, --base-url <url>` | OpenAI-compatible API base URL | `https://api.openai.com/v1` / `$OPENAI_BASE_URL` |
| `-V, --version` | Show version | |
| `-h, --help` | Show help | |

## Available Tools

All tools use X API v2 with Bearer Token (app-only) authentication. Read-only, no user confirmation required.

| Tool | X API Endpoint | Auth | Description |
|------|---------------|------|-------------|
| `search_recent_tweets` | `GET /2/tweets/search/recent` | Bearer | Search all public tweets from the last 7 days by query |
| `get_user_by_username` | `GET /2/users/by/username/{username}` | Bearer | Look up a user profile by @handle |
| `get_tweet_by_id` | `GET /2/tweets/{id}` | Bearer | Get a single tweet by ID |
| `get_user_tweets` | `GET /2/users/{id}/tweets` | Bearer | Get a user's recent tweets (requires user ID) |
| `get_user_mentions` | `GET /2/users/{id}/mentions` | Bearer | Get tweets mentioning a user (requires user ID) |
| `get_user_followers` | `GET /2/users/{id}/followers` | Bearer | Get a user's followers (requires user ID) |
| `get_user_following` | `GET /2/users/{id}/following` | Bearer | Get who a user follows (requires user ID) |

### Requested Fields

Each API call requests the following expansions and fields:

- **tweet.fields**: `author_id`, `created_at`, `public_metrics`, `entities`, `referenced_tweets`, `source`, `text`
- **user.fields**: `created_at`, `description`, `public_metrics`, `username`, `name`, `verified`, `location`, `url`
- **expansions**: `author_id`, `referenced_tweets.id`

### Search Query Syntax

`search_recent_tweets` supports X search operators:

```
"keyword"              # exact match
from:username          # tweets by user
to:username            # replies to user
@username              # mentioning user
#hashtag               # hashtag
lang:ja                # language filter
has:media              # tweets with media
is:retweet             # retweets only
-keyword               # exclude keyword
```

### Not Yet Supported (requires OAuth2 user token)

| Endpoint | Description |
|----------|-------------|
| `GET /2/users/{id}/timelines/reverse_chronological` | Home timeline |
| `GET /2/users/{id}/bookmarks` | Bookmarks |
| `GET /2/users/{id}/liked_tweets` | Liked tweets |

## Test

```bash
npm test
```

## TUI Features

- Scrollable conversation history (arrow keys up/down)
- Tool calls displayed with args and full API response
- Real-time tool call indicator with spinner
- Token usage tracking (LLM prompt/completion tokens, X API request count + rate limit)
- Auto-retry without tools on LLM tool-calling errors (400/failed_generation)
- Ctrl+C to exit

## Architecture

Single file (`main.tsx`) containing:

1. **CLI** - Commander.js for `--model`, `--base-url`, `--help`, `--version`
2. **Config** - env var loading (`OPENAI_API_KEY`, `X_BEARER_TOKEN`) + CLI option overrides
3. **X API Client** - direct `fetch` with Bearer Token auth, rate limit tracking
4. **Tool Definitions** - OpenAI function calling format
5. **Tool Handlers** - X API call execution
6. **Agent Loop** - OpenAI chat completions with tool calling loop + error recovery
7. **Ink TUI** - React-based terminal UI with scroll, usage bar, spinner
