#!/bin/bash
export SLEEPLESS_DATA_DIR="/root/projects/sleepless-opencode/data"
exec node /root/projects/sleepless-opencode/dist/mcp-server.js "$@"
