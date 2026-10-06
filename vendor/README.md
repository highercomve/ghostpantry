# Oriel source snapshot

This is Oriel 0.9.3 at upstream commit `0e1283af103e62546faaaf75e80c2918998df877`, with the generic Android extension and Maven dependency registration changes developed for GhostPantry. Source is copied from Oriel’s package paths, including its MIT license. Build caches and binaries are excluded.

The extension API and SDK dependency wiring are implemented in the framework; GhostPantry’s native sources stay in `android/native/`. The snapshot makes fresh clones and CI reproducible while these changes await an Oriel release. The framework contract is documented in [android-extensions.md](oriel/docs/android-extensions.md).

When upstream publishes these changes, replace `.dependencies.oriel.path` with the released URL and hash using `zig fetch --save=oriel`, then remove this snapshot. Local framework work can use `zig build --fork=../oriel`.
