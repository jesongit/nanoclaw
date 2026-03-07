# Intent: src/ipc.ts modifications

## What changed
No QQ-specific IPC changes are required. Existing task scheduling and group registration IPC behavior remains unchanged.

## Invariants
- Existing task scheduling and registration authorization rules remain unchanged
- No QQ-specific router state is introduced
- Non-main groups are still blocked from privileged IPC actions
