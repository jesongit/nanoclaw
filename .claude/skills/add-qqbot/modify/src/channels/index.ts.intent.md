# Intent: Add QQBot channel import

Add `import './qqbot.js';` to the channel barrel file so the QQBot
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
