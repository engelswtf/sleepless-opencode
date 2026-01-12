# sleepless-opencode

24/7 AI agent daemon for OpenCode - works while you sleep.

Submit tasks via Discord or Slack, and the daemon processes them using OpenCode in the background. Get notified when tasks complete.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/engelswtf/sleepless-opencode/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/engelswtf/sleepless-opencode
cd sleepless-opencode
npm install
npm run build
```

## Setup

Run the interactive setup wizard:

```bash
npm run setup
```

This will guide you through:
1. Discord or Slack bot configuration
2. Notification preferences
3. Workspace settings

## Features

- **Persistent Task Queue**: SQLite-backed queue survives restarts
- **Priority System**: urgent/high/medium/low priority ordering
- **Discord Bot**: Slash commands to submit and manage tasks
- **Slack Bot**: Alternative interface (optional)
- **Access Control**: Restrict bot to specific users or channels
- **Smart Completion Detection**: Validates actual output before marking complete
- **Todo-Aware**: Checks for incomplete todos before finishing tasks
- **Error Recovery**: Automatic recovery from tool_result_missing errors
- **Error Categorization**: Detects rate limits, context exceeded, agent not found
- **Progress Tracking**: Tracks tool calls, last tool, last message
- **Retry with Backoff**: Exponential backoff for transient failures
- **Task Timeout**: Configurable timeout prevents stuck tasks (30 min default)
- **CLI**: Command-line interface for quick task management
- **MCP Server**: Expose tools so agents can queue tasks
- **Systemd Service**: Run as a background service

## Usage

### Start the Daemon

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### Discord Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Submit a new task |
| `/task <prompt> priority:high` | Submit high priority task |
| `/task <prompt> project:/path/to/project` | Task with specific project |
| `/status` | Check queue status |
| `/tasks` | List recent tasks |
| `/tasks filter:pending` | List pending tasks only |
| `/cancel <id>` | Cancel a pending task |

### Slack Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Submit a new task |
| `/task <prompt> -p high` | Submit high priority task |
| `/status` | Check queue status |
| `/tasks` | List recent tasks |
| `/cancel <id>` | Cancel a pending task |

### CLI

```bash
# Add a task
npx sleepless add "Implement OAuth2 authentication" --priority high

# List tasks
npx sleepless list
npx sleepless list --status pending

# Check status
npx sleepless status

# Get task details
npx sleepless get 1

# Cancel a task
npx sleepless cancel 1
```

## How It Works

```
+----------------------------------------------------------+
|                   sleepless-opencode                      |
+----------------------------------------------------------+
|                                                          |
|  Discord/Slack --> Task Queue (SQLite) --> Daemon        |
|       |                   |                    |         |
|   /task "..."        Persists tasks      Spawns          |
|   /status            across restarts     OpenCode        |
|   /cancel                 |              sessions        |
|       |                   |                    |         |
|       +------------> Notifications <---- Results         |
|                     (DM/Channel)                         |
|                                                          |
+----------------------------------------------------------+
```

1. Submit tasks via Discord, Slack, or CLI
2. Tasks are stored in SQLite with priority ordering
3. Daemon polls queue, picks highest priority pending task
4. Creates an OpenCode session (SDK or CLI fallback)
5. Monitors session with smart completion detection:
   - Validates actual output exists
   - Checks for incomplete todos
   - Uses stability detection (3 consecutive stable polls)
   - Respects minimum idle time (5s)
6. Sends notification when complete (or failed)

## Completion Detection

The daemon uses multiple layers to detect task completion:

| Check | Purpose |
|-------|---------|
| `session.idle` event | Primary completion signal |
| Output validation | Ensures actual assistant/tool output exists |
| Todo check | Waits if todos are incomplete |
| Stability detection | 3 consecutive polls with unchanged messages |
| Minimum idle time | Ignores premature idle events (<5s) |
| Completion signals | Looks for `[TASK_COMPLETE]` in output |

## Error Handling

Errors are categorized for smarter retry logic:

| Error Type | Behavior |
|------------|----------|
| `rate_limit` | Retry with exponential backoff |
| `context_exceeded` | No retry (task too large) |
| `agent_not_found` | No retry (configuration issue) |
| `tool_result_missing` | Attempt recovery, then retry |
| `timeout` | Retry with backoff |
| `unknown` | Retry with backoff |

## Progress Tracking

Tasks track execution progress:

```sql
progress_tool_calls   -- Number of tool calls made
progress_last_tool    -- Name of last tool used  
progress_last_message -- Last assistant message (truncated)
progress_updated_at   -- Timestamp of last update
```

## Run as a Service

### Linux (systemd)

```bash
# Copy service file
sudo cp sleepless-opencode.service /etc/systemd/system/

# Edit paths in the service file
sudo nano /etc/systemd/system/sleepless-opencode.service

# Enable and start
sudo systemctl enable sleepless-opencode
sudo systemctl start sleepless-opencode

# Check logs
sudo journalctl -u sleepless-opencode -f
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.sleepless-opencode.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sleepless-opencode</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/sleepless-opencode/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/sleepless-opencode</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.sleepless-opencode.plist
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | One of Discord/Slack | - | Discord bot token |
| `SLACK_BOT_TOKEN` | One of Discord/Slack | - | Slack bot token |
| `SLACK_APP_TOKEN` | With Slack | - | Slack app token (socket mode) |
| `DISCORD_NOTIFICATION_USER_ID` | No | - | User ID for DM notifications |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | No | - | Channel for notifications |
| `DISCORD_ALLOWED_USER_IDS` | No | - | Comma-separated user IDs allowed to use bot |
| `DISCORD_ALLOWED_CHANNEL_IDS` | No | - | Comma-separated channel IDs where bot responds |
| `SLACK_NOTIFICATION_CHANNEL` | No | - | Slack channel name |
| `OPENCODE_WORKSPACE` | No | `cwd` | Default workspace path |
| `OPENCODE_AGENT` | No | `sleepless-executor` | Agent to use for tasks |
| `POLL_INTERVAL_MS` | No | `5000` | Poll interval in ms |
| `TASK_TIMEOUT_MS` | No | `1800000` | Task timeout (30 min) |
| `ITERATION_TIMEOUT_MS` | No | `600000` | Single iteration timeout (10 min) |
| `SLEEPLESS_DATA_DIR` | No | `./data` | Data directory |

### Access Control

Restrict who can use the Discord bot:

```env
# Allow specific users only
DISCORD_ALLOWED_USER_IDS=123456789,987654321

# Allow specific channels only
DISCORD_ALLOWED_CHANNEL_IDS=111222333,444555666

# Allow both (user OR channel must match)
DISCORD_ALLOWED_USER_IDS=123456789
DISCORD_ALLOWED_CHANNEL_IDS=111222333
```

If neither is set, the bot is open to everyone who can see it.

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" tab, create bot, copy token
4. Go to "OAuth2" then "URL Generator"
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Use Slash Commands`
5. Use the generated URL to invite bot to your server
6. To get your User ID for DMs:
   - Enable Developer Mode in Discord settings
   - Right-click yourself, select Copy ID

## Slack Bot Setup

1. Go to [Slack API](https://api.slack.com/apps)
2. Create a new app, select "From scratch"
3. Enable Socket Mode, generate App Token (`xapp-...`)
4. OAuth & Permissions, add Bot Token Scopes:
   - `chat:write`
   - `commands`
5. Slash Commands, create:
   - `/task` - Submit a task
   - `/status` - Check status
   - `/tasks` - List tasks
   - `/cancel` - Cancel task
6. Install to Workspace, copy Bot Token (`xoxb-...`)

## MCP Server

The daemon includes an MCP server that exposes tools for agents:

| Tool | Description |
|------|-------------|
| `sleepless_queue` | Queue a task for background processing |
| `sleepless_status` | Check queue status or specific task |
| `sleepless_list` | List queued tasks |
| `sleepless_cancel` | Cancel a pending task |
| `sleepless_result` | Get full result of a completed task |

Add to your `opencode.json`:

```json
{
  "mcp": {
    "sleepless": {
      "command": ["node", "/path/to/sleepless-opencode/dist/mcp-server.js"]
    }
  }
}
```

## Security

- Input validation on all prompts and paths
- Parameterized SQL queries (no injection)
- WAL mode for SQLite concurrency
- Project path restrictions (no system paths)
- Task timeouts prevent infinite loops
- Access control for Discord bot
- Lock file prevents duplicate daemon instances

## License

MIT
