{
  "kind": "choice",
  "context": "mcp",
  "action": [
    {
      "kind": "action",
      "op": "mcp-server/adopt",
      "name": "Add MCP",
      "params": {
        "input": ""
      }
    }
  ],
  "alternateActions": [
    {
      "kind": "action",
      "op": "mcp-server/adopt",
      "name": "Add MCP",
      "hotkey": "control-n",
      "params": {
        "input": ""
      }
    }
  ],
  "choices": [
    {
      "kind": "choice",
      "name": "Add MCP",
      "description": "Paste an https:// URL or a stdio command",
      "action": [
        {
          "kind": "action",
          "op": "mcp-server/adopt",
          "name": "Add MCP"
        }
      ]
    }
  ]
}
