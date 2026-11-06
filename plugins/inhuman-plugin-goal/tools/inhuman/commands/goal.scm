{
  "kind": "choice",
  "context": "goal",
  "action": [
    {
      "kind": "action",
      "op": "plugin/method",
      "name": "Set goal",
      "params": {
        "plugin": "inhuman-plugin-goal",
        "method": "set",
        "args": "{\"loops\": 32}",
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
      "description": "Drop the session goal",
      "action": [
        {
          "kind": "action",
          "op": "plugin/method",
          "params": {
            "plugin": "inhuman-plugin-goal",
            "method": "clear"
          }
        }
      ]
    }
  ]
}
