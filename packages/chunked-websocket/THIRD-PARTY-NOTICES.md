# Third-party notices

## y-partykit (chunking protocol)

`src/protocol.ts` and parts of `src/ChunkedWebSocket.ts` are adapted from
`packages/y-partykit/src/chunking.ts` in the PartyKit monorepo
(https://github.com/partykit/partykit). The wire protocol (sentinel string +
JSON chunk markers) is preserved binary-compatible with partykit's.

The PartyKit repository is licensed under the MIT License, reproduced in full
below. (The `y-partykit` npm package's `license` field reads "ISC"; the
repository-level LICENSE governs and is MIT.)

```
MIT License

Copyright (c) 2023 PartyKit, Inc.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
