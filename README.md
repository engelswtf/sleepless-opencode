# sleepless-opencode

24/7 AI agent daemon for OpenCode - works while you sleep.

Submit tasks via Discord or Slack, and the daemon processes them using OpenCode in the background. Get notified when tasks complete.

## Features

- **Task Queue**: SQLite-backed persistent queue with priorities
- **Discord Bot**: Slash commands to submit and manage tasks
- **Slack Bot**: Alternative interface (optional)
- **Notifications**: DM or channel notifications when tasks complete
- **CLI**: Command-line interface for quick task management
- **Systemd Service**: Run as a background service

## Quick Start

### 1. Install

```bash
git clone https://github.com/yourusername/sleepless-opencode
cd sleepless-opencode
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your tokens
```

**Required** (at least one):
- `DISCORD_BOT_TOKEN` - Discord bot token
- `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` - Slack bot tokens

**Optional**:
- `DISCORD_NOTIFICATION_USER_ID` - Your Discord user ID (for DM notifications)
- `DISCORD_NOTIFICATION_CHANNEL_ID` - Channel for notifications
- `SLACK_NOTIFICATION_CHANNEL` - Slack channel for notifications
- `OPENCODE_WORKSPACE` - Default workspace path
- `POLL_INTERVAL_MS` - Queue poll interval (default: 5000)

### 3. Set up Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" tab, create a bot, copy the token
4. Go to "OAuth2" > "URL Generator"
   - Select scopes: `bot`, `applications.commands`
   - Select permissions: `Send Messages`, `Use Slash Commands`
5. Use the generated URL to invite the bot to your server

### 4. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Or install as systemd service
sudo cp sleepless-opencode.service /etc/systemd/system/
sudo systemctl enable sleepless-opencode
sudo systemctl start sleepless-opencode
```

## Usage

### Discord Commands

| Command | Description |
|---------|-------------|
| `/task <prompt>` | Submit a new task |
| `/task <prompt> --priority high` | Submit high priority task |
| `/status` | Check queue status |
| `/tasks` | List recent tasks |
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
┌─────────────────────────────────────────────────────────┐
│                   sleepless-opencode                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Discord/Slack ──→ Task Queue (SQLite) ──→ Daemon       │
│       │                   │                    │        │
│   /task "..."        Persists tasks      Spawns         │
│   /status            across restarts     OpenCode       │
│   /cancel                 │              sessions       │
│       │                   │                    │        │
│       └───────────→ Notifications ←──── Results        │
│                     (DM/Channel)                        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

1. Submit tasks via Discord, Slack, or CLI
2. Tasks are stored in SQLite with priority ordering
3. Daemon polls queue, picks highest priority pending task
4. Creates an OpenCode session and runs the task
5. Sends notification when complete (or failed)

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | One of Discord/Slack | Discord bot token |
| `SLACK_BOT_TOKEN` | One of Discord/Slack | Slack bot token |
| `SLACK_APP_TOKEN` | With Slack | Slack app token (socket mode) |
| `DISCORD_NOTIFICATION_USER_ID` | No | User ID for DM notifications |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | No | Channel for notifications |
| `SLACK_NOTIFICATION_CHANNEL` | No | Slack channel name |
| `OPENCODE_WORKSPACE` | No | Default workspace path |
| `OPENCODE_PORT` | No | OpenCode server port |
| `POLL_INTERVAL_MS` | No | Poll interval in ms (default: 5000) |
| `SLEEPLESS_DATA_DIR` | No | Data directory (default: ./data) |

## License

MIT
