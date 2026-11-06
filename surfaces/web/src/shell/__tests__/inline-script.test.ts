import { describe, expect, it } from "vitest";

import { detectInlineScript } from "../inline-script.js";

describe("inline scripts", () => {
  it.each([
    [
      "python heredoc",
      "python3 - <<'PY'\nfrom pathlib import Path\nprint('one lift row dropped')\nPY",
      {
        lang: "python",
        label: "Python script",
        source: "from pathlib import Path\nprint('one lift row dropped')",
      },
    ],
    [
      "node heredoc",
      "node - <<'JS'\nconsole.log(1)\nJS",
      { lang: "javascript", label: "NodeJS script", source: "console.log(1)" },
    ],
    ["python -c", 'python3 -c "print(1)"', { lang: "python", label: "Python script", source: "print(1)" }],
    [
      "node --eval",
      "node --eval 'console.log(1)'",
      { lang: "javascript", label: "NodeJS script", source: "console.log(1)" },
    ],
    ["python -m", "python -m pytest tests/", null],
    ["node file", "node scripts/build.js", null],
    ["cat heredoc", "cat > app.py <<'PY'\nx = 1\nPY", null],
    ["echo then python", "echo hi && python3 - <<'PY'\nprint(1)\nPY", null],
    [
      "trailing and",
      "python3 - <<'PY' && echo done\nprint(1)\nPY",
      { lang: "python", label: "Python script", source: "print(1)" },
    ],
    [
      "cd prefix",
      "cd ../quickdraw && python3 - <<'PY'\nprint(1)\nPY",
      { lang: "python", label: "Python script", source: "print(1)" },
    ],
    [
      "env sudo version",
      "FOO=1 sudo python3.12 - <<PY\nprint(1)\nPY",
      { lang: "python", label: "Python script", source: "print(1)" },
    ],
    [
      "unclosed",
      "python3 - <<'PY'\nfrom pathlib import Path\n",
      { lang: "python", label: "Python script", source: "from pathlib import Path" },
    ],
    [
      "nodejs -e",
      'nodejs -e "console.log(1)"',
      { lang: "javascript", label: "NodeJS script", source: "console.log(1)" },
    ],
    [
      "absolute python",
      "/usr/bin/python3 - <<'EOF'\nprint(1)\nEOF",
      { lang: "python", label: "Python script", source: "print(1)" },
    ],
    ["python file", "python3 lift.py", null],
    ["python stdin dash", "python3 -", null],
    [
      "delimiter inside a string",
      "python3 - <<'PY'\nprint('PY')\nprint(1)\nPY",
      { lang: "python", label: "Python script", source: "print('PY')\nprint(1)" },
    ],
  ] as const)("%s", (_name, command, expected) => {
    expect(detectInlineScript(command)).toEqual(expected);
  });
});
