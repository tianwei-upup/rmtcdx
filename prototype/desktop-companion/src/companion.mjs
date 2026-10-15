// Retired acceptance-only launcher. Use the MCP owner and durable full-turn locks.
// Keeping the old CLI unavailable prevents parallel use of its ACK-only lock.
throw Object.assign(new Error('legacy_launcher_retired_use_mcp_server'), { code: 'legacy_launcher_retired_use_mcp_server' });
