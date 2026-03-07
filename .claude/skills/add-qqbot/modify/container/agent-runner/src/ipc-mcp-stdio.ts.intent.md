# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
No QQ-specific MCP tool changes are required.

## Invariants
- Existing scheduling, messaging, and group registration tools remain unchanged
- No QQ-specific runtime configuration tool is exposed to agents
- Authorization still relies on the host IPC watcher using the source group identity
