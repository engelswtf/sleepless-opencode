<p align="center">
  <img src="https://img.shields.io/badge/v1.0.0-production--ready-brightgreen?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

<h1 align="center">sleepless-opencode</h1>

<p align="center">
  <strong>24/7 AI Agent Daemon for OpenCode</strong><br/>
  Queue tasks. Go to sleep. Wake up to completed work.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#usage">Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#api">API</a>
</p>

---

## Why sleepless-opencode?

OpenCode is powerful, but it needs you at the keyboard. **sleepless-opencode** changes that.

| Problem | Solution |
|---------|----------|
| "I want to run tasks overnight" | Persistent daemon with SQLite queue |
| "My session died mid-task" | Automatic recovery and retry with backoff |
| "I need to chain complex workflows" | Task dependencies (`--depends-on`) |
| "How do I know when it's done?" | Discord, Slack, or Webhook notifications |
| "Is the daemon healthy?" | Health endpoints + Prometheus metrics |

```
You: /task "Refactor auth module and add tests"
Bot: [OK] Task #42 queued (urgent priority)

... you go to sleep ...

Bot: [DONE] Task #42 completed
     - Refactored 12 files
     - Added 47 test cases  
     - All tests passing
```

---

## Quick Start

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/engelswtf/sleepless-opencode/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/engelswtf/sleepless-opencode
cd sleepless-opencode
npm install && npm run build
npm run setup  # Interactive configuration
npm start
```

### Minimal Setup

```bash
# 1. Set your Discord bot token
echo "DISCORD_BOT_TOKEN=your-token-here" > .env

# 2. Start the daemon
npm start
```

---

## Features

### Persistent Task Queue
<img src="https://img.shields.io/badge/SQLite-WAL_mode-003B57?style=flat-square&logo=sqlite" alt="SQLite" />

SQLite-backed queue survives restarts, crashes, and reboots. Your tasks are safe.

### Task Timeout & Recovery
<img src="https://img.shields.io/badge/timeout-30_min-orange?style=flat-square" alt="Timeout" />

- Configurable timeout (default 30 min) kills stuck tasks
- Exponential backoff with jitter for retries
- Smart rate limit handling (respects `Retry-After` headers)
- Automatic SDK reconnection when in CLI fallback mode

### Task Dependencies
<img src="https://img.shields.io/badge/workflow-chaining-blueviolet?style=flat-square" alt="Chaining" />

Chain tasks together. Task B waits for Task A to complete.

```bash
sleepless add "Build the API" --priority high
# Task #1 added

sleepless add "Write API tests" --depends-on 1
# Task #2 added - depends on #1
```

### Graceful Shutdown
<img src="https://img.shields.io/badge/SIGTERM-graceful-success?style=flat-square" alt="Graceful" />

`SIGTERM` waits for the current task to complete (configurable timeout), then exits cleanly. No orphaned sessions.

### Health & Monitoring
<img src="https://img.shields.io/badge/Prometheus-metrics-E6522C?style=flat-square&logo=prometheus" alt="Prometheus" />

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness check (returns status, mode, queue stats) |
| `GET /ready` | Readiness check (false during shutdown) |
| `GET /status` | Detailed JSON status |
| `GET /metrics` | Prometheus-format metrics |

```bash
curl http://localhost:9090/health
```
```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0",
  "mode": "sdk",
  "queue": { "pending": 2, "running": 1, "done": 47, "failed": 3 },
  "currentTask": { "id": 50, "prompt": "...", "elapsedSeconds": 120 },
  "shuttingDown": false
}
```

### Multi-Channel Notifications
<img src="https://img.shields.io/badge/Discord-bot-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" />
<img src="https://img.shields.io/badge/Slack-bot-4A154B?style=flat-square&logo=slack&logoColor=white" alt="Slack" />
<img src="https://img.shields.io/badge/Webhook-HTTP_POST-blue?style=flat-square" alt="Webhook" />

| Channel | Setup |
|---------|-------|
| **Discord** | Bot with slash commands (`/task`, `/status`, `/cancel`) |
| **Slack** | Socket mode bot with commands |
| **Webhook** | HTTP POST to any URL with HMAC signature |

### Smart Completion Detection
<img src="https://img.shields.io/badge/detection-multi--layer-informational?style=flat-square" alt="Detection" />

The daemon doesn't just wait for "idle" - it validates completion:

1. **Output Validation**: Ensures actual assistant/tool output exists
2. **Todo Check**: Waits if todos are incomplete
3. **Stability Detection**: 3 consecutive stable polls before marking done
4. **Completion Signals**: Recognizes `[TASK_COMPLETE]` markers

### Structured Logging
<img src="https://img.shields.io/badge/format-JSON-yellow?style=flat-square" alt="JSON" />
<img src="https://img.shields.io/badge/rotation-automatic-lightgrey?style=flat-square" alt="Rotation" />

```bash
# Pretty logs (default)
LOG_LEVEL=debug npm start

# JSON logs for production
LOG_FORMAT=json LOG_FILE=/var/log/sleepless.log npm start
```

Automatic log rotation when file exceeds 10MB (configurable).

---

## Usage

### Discord Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Submit a new task |
| `/task <prompt> priority:urgent` | High priority task |
| `/task <prompt> project:/path/to/code` | Task with specific project |
| `/status` | Check queue status |
| `/tasks` | List recent tasks |
| `/tasks filter:pending` | Filter by status |
| `/cancel <id>` | Cancel a pending task |

### CLI Commands

```bash
# Add tasks
sleepless add "Implement OAuth2" --priority high
sleepless add "Add OAuth tests" --depends-on 1

# View queue
sleepless list
sleepless list --status pending
sleepless status

# Task details
sleepless get 42

# Cancel
sleepless cancel 42
```

### MCP Server

Expose tools to agents via MCP:

```json
{
  "mcp": {
    "sleepless": {
      "command": ["node", "/path/to/sleepless-opencode/dist/mcp-server.js"]
    }
  }
}
```

Tools: `sleepless_queue`, `sleepless_status`, `sleepless_list`, `sleepless_cancel`, `sleepless_result`

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| **Notifications** |||
| `DISCORD_BOT_TOKEN` | - | Discord bot token |
| `DISCORD_NOTIFICATION_USER_ID` | - | User ID for DM notifications |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | - | Channel for notifications |
| `DISCORD_ALLOWED_USER_IDS` | - | Comma-separated allowed user IDs |
| `DISCORD_ALLOWED_CHANNEL_IDS` | - | Comma-separated allowed channel IDs |
| `SLACK_BOT_TOKEN` | - | Slack bot token |
| `SLACK_APP_TOKEN` | - | Slack app token (socket mode) |
| `SLACK_NOTIFICATION_CHANNEL` | - | Slack channel name |
| `WEBHOOK_URL` | - | Webhook endpoint URL |
| `WEBHOOK_SECRET` | - | HMAC secret for webhook signature |
| `WEBHOOK_EVENTS` | all | Comma-separated: `started,completed,failed` |
| **Daemon** |||
| `OPENCODE_WORKSPACE` | `cwd` | Default workspace path |
| `OPENCODE_AGENT` | `sleepless-executor` | Agent to use for tasks |
| `OPENCODE_PATH` | auto | Path to opencode binary |
| `POLL_INTERVAL_MS` | `5000` | Queue poll interval |
| `TASK_TIMEOUT_MS` | `1800000` | Task timeout (30 min) |
| `ITERATION_TIMEOUT_MS` | `600000` | Single iteration timeout (10 min) |
| `SHUTDOWN_TIMEOUT_MS` | `60000` | Graceful shutdown timeout |
| **Health** |||
| `HEALTH_PORT` | `9090` | Health server port |
| **Logging** |||
| `LOG_LEVEL` | `info` | debug, info, warn, error |
| `LOG_FORMAT` | `pretty` | pretty or json |
| `LOG_FILE` | - | Log file path (enables file logging) |
| `LOG_MAX_SIZE` | `10485760` | Max log file size (10MB) |
| `LOG_MAX_FILES` | `5` | Number of rotated files to keep |
| **Data** |||
| `SLEEPLESS_DATA_DIR` | `./data` | SQLite database directory |

### Access Control

Restrict who can use the Discord bot:

```env
# Only these users can submit tasks
DISCORD_ALLOWED_USER_IDS=123456789,987654321

# Only respond in these channels
DISCORD_ALLOWED_CHANNEL_IDS=111222333,444555666
```

---

## API

### Webhook Payload

```json
{
  "event": "completed",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "task": {
    "id": 42,
    "prompt": "Implement OAuth2 authentication",
    "status": "done",
    "priority": "high",
    "project_path": "/home/user/myapp",
    "source": "discord",
    "created_at": "2024-01-15T10:00:00.000Z",
    "started_at": "2024-01-15T10:00:05.000Z",
    "completed_at": "2024-01-15T10:30:00.000Z",
    "iteration": 3,
    "retry_count": 0
  },
  "result": "Successfully implemented OAuth2..."
}
```

Webhook requests include `X-Sleepless-Signature` header (HMAC-SHA256) when `WEBHOOK_SECRET` is set.

### Health Response

```json
{
  "status": "healthy|degraded|unhealthy",
  "uptime": 3600,
  "version": "1.0.0",
  "mode": "sdk|cli",
  "queue": {
    "pending": 2,
    "running": 1,
    "done": 47,
    "failed": 3
  },
  "currentTask": {
    "id": 50,
    "prompt": "...",
    "startedAt": "2024-01-15T10:00:00.000Z",
    "elapsedSeconds": 120
  },
  "shuttingDown": false
}
```

### Prometheus Metrics

```
sleepless_uptime_seconds 3600
sleepless_tasks_total{status="pending"} 2
sleepless_tasks_total{status="running"} 1
sleepless_tasks_total{status="done"} 47
sleepless_tasks_total{status="failed"} 3
sleepless_mode{mode="sdk"} 1
sleepless_mode{mode="cli"} 0
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    sleepless-opencode                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Discord │  │  Slack  │  │   CLI   │  │   MCP   │        │
│  │   Bot   │  │   Bot   │  │         │  │ Server  │        │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘        │
│       │            │            │            │              │
│       └────────────┴─────┬──────┴────────────┘              │
│                          │                                  │
│                   ┌──────▼──────┐                           │
│                   │ Task Queue  │ SQLite + WAL              │
│                   │  (SQLite)   │ Priority ordering         │
│                   └──────┬──────┘ Dependency tracking       │
│                          │                                  │
│                   ┌──────▼──────┐                           │
│                   │   Daemon    │ Timeout enforcement       │
│                   │             │ Graceful shutdown         │
│                   │             │ SDK auto-reconnect        │
│                   └──────┬──────┘                           │
│                          │                                  │
│            ┌─────────────┼─────────────┐                    │
│            │             │             │                    │
│     ┌──────▼──────┐ ┌────▼────┐ ┌──────▼──────┐            │
│     │  OpenCode   │ │ Health  │ │  Notifier   │            │
│     │ SDK or CLI  │ │ Server  │ │  (multi)    │            │
│     └─────────────┘ └─────────┘ └─────────────┘            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Running as a Service

### systemd (Linux)

```bash
sudo cp sleepless-opencode.service /etc/systemd/system/
sudo systemctl enable sleepless-opencode
sudo systemctl start sleepless-opencode
sudo journalctl -u sleepless-opencode -f
```

### launchd (macOS)

```bash
cp com.sleepless-opencode.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sleepless-opencode.plist
```

### Docker

```bash
docker run -d \
  --name sleepless \
  -e DISCORD_BOT_TOKEN=your-token \
  -v sleepless-data:/app/data \
  ghcr.io/engelswtf/sleepless-opencode:latest
```

### tmux (Quick)

```bash
tmux new-session -d -s sleepless "cd /path/to/sleepless-opencode && npm start"
```

---

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create new application → Bot tab → Create bot → Copy token
3. OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Use Slash Commands`
4. Use generated URL to invite bot to your server
5. Set `DISCORD_BOT_TOKEN` in your `.env`

**Get User ID**: Enable Developer Mode in Discord settings → Right-click yourself → Copy ID

---

## Slack Bot Setup

1. Go to [Slack API](https://api.slack.com/apps) → Create New App
2. Enable Socket Mode → Generate App Token (`xapp-...`)
3. OAuth & Permissions → Add scopes: `chat:write`, `commands`
4. Slash Commands → Create: `/task`, `/status`, `/tasks`, `/cancel`
5. Install to Workspace → Copy Bot Token (`xoxb-...`)
6. Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in your `.env`

---

## Error Handling

| Error Type | Behavior |
|------------|----------|
| `rate_limit` | Retry with exponential backoff + jitter, respects Retry-After |
| `context_exceeded` | Fail permanently (task too large) |
| `agent_not_found` | Fail permanently (configuration issue) |
| `tool_result_missing` | Attempt recovery injection, then retry |
| `dependency_failed` | Fail task and all dependents |
| `timeout` | Retry with backoff |
| `unknown` | Retry with backoff |

---

## Security

| Feature | Status |
|---------|--------|
| Input validation on all prompts and paths | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| Parameterized SQL queries (no injection) | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| WAL mode for SQLite concurrency | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| Project path restrictions | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| Task timeouts prevent infinite loops | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| Access control for Discord/Slack bots | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| Lock file prevents duplicate daemon instances | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |
| HMAC signatures for webhook verification | <img src="https://img.shields.io/badge/-implemented-success?style=flat-square" /> |

---

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

---

## License

MIT © [engels](https://github.com/engelswtf)

---

<p align="center">
  <strong>Stop babysitting your AI. Let it work while you sleep.</strong>
</p>
