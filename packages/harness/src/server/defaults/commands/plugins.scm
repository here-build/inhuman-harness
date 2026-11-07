{
  "kind": "choice",
  "context": "plugins",
  "action": [
    {
      "kind": "action",
      "op": "plugin/install",
      "name": "Install plugin",
      "params": {
        "spec": ""
      }
    }
  ],
  "alternateActions": [
    {
      "kind": "action",
      "op": "plugin/install",
      "name": "Install plugin",
      "hotkey": "control-n",
      "params": {
        "spec": ""
      }
    }
  ],
  "choices": [
    {
      "kind": "choice",
      "name": "Install plugin",
      "description": "Install an npm package, path, or file: URL",
      "action": [
        {
          "kind": "action",
          "op": "plugin/install",
          "name": "Install plugin"
        }
      ]
    }
  ]
}
