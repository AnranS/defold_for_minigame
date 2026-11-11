# Third-party notices

Defold Mini Game is MIT-licensed. It does not ship the Defold engine. The
files listed here come from other projects and stay under their own terms.

## Defold

Copyright 2020-2026 The Defold Foundation.
Copyright 2014-2020 King.
Copyright 2009-2014 Ragnar Svensson, Christian Murray.

Licensed under the Defold License version 1.0, https://www.defold.com/license.
The Defold License is derived from the Apache License 2.0; it permits use,
modification, and redistribution, and does not permit selling Defold itself as
a game engine product.

### What this repository contains

- `test/fixtures/defold-1.14.0/dmloader.template.js` and
  `test/fixtures/defold-1.14.1/dmloader.template.js` are copied verbatim from
  the Defold source tree at the tags `1.14.0` and `1.14.1`. They are used by
  the tests only and are not part of an export.

### What an export contains

An exported mini-game project embeds, unmodified apart from the rewrites
listed in `docs/ARCHITECTURE.md`, two files from **your** Defold HTML5 bundle:
`dmloader.js` and the Emscripten engine glue (`<name>_wasm.js`), plus the
engine binary (`<name>.wasm`). Those files are Defold, built and bundled by
your copy of Defold, and remain under the Defold License. Keep Defold's
license notice with any game you distribute, as you would for an HTML5 build.

## godot_for_minigame

The provider selection (`runtime/common/js/platform_runtime.js`), the layout of
the DOM adapter, and the transactional export design are adapted from
[godot_for_minigame](https://github.com/AnranS/godot_for_minigame), MIT License,
Copyright (c) 2025 godot_tt contributors.

## Platform logos on the website

`website/assets/logos/wechat.svg`, `douyin.svg`, and `tiktok.svg` are the
platform icons used by the godot_for_minigame website, copied from that
repository. WeChat, Douyin, and TikTok are trademarks of their owners. The
icons only name the platforms an export targets; they are not covered by this
project's MIT license and do not mean that the platforms endorse the project.
The upstream source and license of each icon file are not recorded in that
repository; replace or remove the files if that matters for your use.

The figures in `docs/images/` are drawn by `scripts/generate_diagrams.mjs` and
are part of this project.
