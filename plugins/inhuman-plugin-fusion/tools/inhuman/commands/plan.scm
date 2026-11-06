{
  "kind": "choice",
  "context": "plan",
  "action": [
    {
      "kind": "action",
      "op": "plugin/method",
      "name": "Open plan",
      "params": {
        "plugin": "fusion",
        "method": "open",
        "args": "{\"steps\": 8}",
        "field": "text",
        "input": ""
      }
    }
  ],
  "choices": [
    {
      "kind": "choice",
      "name": "status"
    },
    {
      "kind": "choice",
      "name": "clear",
      "description": "Drop the session plan",
      "action": [
        {
          "kind": "action",
          "op": "plugin/method",
          "params": {
            "plugin": "fusion",
            "method": "clear"
          }
        }
      ]
    }
  ]
}
