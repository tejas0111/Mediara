# Third-party notices

The Mediara web UI is **hand-written** (HTML/CSS/JS, no framework, no build
step) and vendors no UI library. There is therefore no bundled third-party
front-end code to attribute.

Runtime dependencies are installed via npm (not vendored). Their licenses are
available in `node_modules/<pkg>/LICENSE` after `npm install`:

| Package | License | Use |
|---|---|---|
| `@mysten-incubation/memwal` | see package | Walrus Memory SDK |
| `@mysten/sui` (transitive) | Apache-2.0 | Sui wallet signature verification + tx building |
| `express` | MIT | HTTP server |
| `dotenv` | BSD-2-Clause | env loading |
| `node-telegram-bot-api` (optional) | MIT | Telegram channel |

> History: an earlier revision of the UI used the Deep Chat component (MIT,
> Ovidijus Parsiunas) as a drop-in widget; it was replaced by the bespoke UI in
> `app/public/` and the vendored bundle was removed.
