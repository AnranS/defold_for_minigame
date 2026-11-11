# Defold 1.14.1 loader template

`dmloader.template.js` is copied verbatim from the Defold source tree at tag
`1.14.1` (commit `ee283d4dad9fa451dd6399d83602e1dc25133681`):

    com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/bundle/resources/web/dmloader.js

It is the Mustache template `bob.jar` renders into every HTML5 bundle. The
tests render it with `test/helpers/bundle_fixture.mjs` so the exporter and the
runtime are exercised against the real loader instead of a re-implementation.

Copyright 2020-2026 The Defold Foundation. Licensed under the Defold License
version 1.0, https://www.defold.com/license. See `THIRD_PARTY_NOTICES.md` in
the repository root.
