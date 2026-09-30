# Third-party notices

DoseDaughter bundles the following third-party open-source components. Their
licenses are reproduced below as required.

---

## Deep Chat — `app/public/deep-chat.bundle.js`

- Project: Deep Chat — https://github.com/OvidijusParsiunas/deep-chat
- Homepage: https://deepchat.dev
- Version vendored: 2.5.0 (one privacy patch: its default Google Fonts URL is redirected to the same-origin empty `/assets/font.css`; plus a comment header. No logic changed.)
- Used for: the chat interface (web component `<deep-chat>`)
- License: MIT

```
MIT License

Copyright (c) 2024 Ovidijus Parsiunas

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

---

## Runtime dependencies (installed via npm, not vendored)

| Package | License | Use |
|---|---|---|
| `@mysten-incubation/memwal` | see package | Walrus Memory SDK |
| `@mysten/sui` (transitive) | Apache-2.0 | Sui wallet signature verification + tx building |
| `express` | MIT | HTTP server |
| `dotenv` | BSD-2-Clause | env loading |
| `node-telegram-bot-api` (optional) | MIT | Telegram channel |

Each package's own license is available in `node_modules/<pkg>/LICENSE` after
`npm install`.
