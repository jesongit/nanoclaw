# Intent: src/index.ts modifications

## What changed
No changes are required in `src/index.ts` for QQBot. The core message loop stays channel-agnostic.

## Invariants
- `TRIGGER_PATTERN` logic in the main message loop is unchanged
- Message storage and agent orchestration stay channel-agnostic
- QQBot trigger normalization remains fully inside `src/channels/qqbot.ts`
