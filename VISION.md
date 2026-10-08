# Vision

`LightHouse` exists so that a reader can read, collect, and annotate books across physical e-ink hardware and mobile readers without commercial cloud lock-in, format fragmentation, or manual library maintenance.
It serves a reader with dedicated e-ink hardware and personal note vaults, turning raw web articles, light novel releases, and reading sessions into a pristine, synchronized digital library.
It owns exactly one thing: the private reading pipeline connecting reader devices, library storage, ingestion engines, progress sync, and personal notes.

## Canonical EPUB and Storage Immutability

LightHouse maintains a strictly EPUB-only book collection, deferring spoken audio media until personal listening tools mature.
Non-EPUB formats are refused at library ingestion, requiring conversion tooling to compile raw scans into clean EPUB containers first.
Physical library storage structures on disk are managed strictly by Calibre and are never reorganized out of band.
User downloads and device deliveries derive clean, human-readable filenames dynamically from book metadata.
Damaged archive containers are healed in-process or rejected before entering library storage.

## Hardware Realism and Physical Sync

The reading workflow prioritizes physical e-ink readers and disconnected reading sessions.
Device synchronization relies on physical USB transfers and open reader protocols rather than reverse-engineering proprietary cloud sync services.
Transfers eliminate ghost metadata files, verify available disk headroom upfront, and support instant safe cancellation.
Local home networks remain friction-free, while remote reverse tunnels authenticate mutating requests without breaking read-only reader feeds.
Background server processes yield resources when idle to preserve host memory.

## Volume Precision and Source Veracity

Series indexing distinguishes individual volume identities, specific covers, and distinct synopses.
A series overview or digital revision tag never overwrites volume-level metadata or artwork.
Novel discovery anchors to verified online sources, direct manifests, and decentralized archives to locate unindexed releases.
When public APIs lack descriptions, localized intelligence may synthesize volume synopses and character glossaries without hallucinating volume sequences.
Burmese literature and non-English titles are recognized deterministically and protected from incorrect overseas metadata overrides.

## Idempotent Knowledge and Progress Preservation

Reading progress, highlights, and annotations synchronize without destroying user edits.
Highlights exported to Obsidian vaults are bounded by explicit markers and leave thoughts outside those markers untouched.
Sync routines update reading telemetry and quote collections idempotently, allowing vault edits to enrich library metadata without circular clobbering.
Book deletion from the library prunes cached highlights cleanly while respecting external vault files.
Online database snapshots flush write-ahead logs to create verified point-in-time recovery archives with integrity checksums.

## Fluid Interaction and Quiet Restraint

The catalog interface delivers tactile, physics-based responsiveness modeled on Apple fluid interface principles.
Visual surfaces use dark translucent materials, optical typography, and responsive layouts for both mobile sheets and desktop cards.
System outputs, error banners, and logs communicate with plain text and zero emojis.
Decorative animations yield immediately to user intent and accessibility preferences.

## Scope

LightHouse is a personal reading appliance, not a public multi-tenant SaaS, and not a social reading network.
It is not an unreflowed PDF viewer, comic archive manager, or DRM stripping service.
Private credentials, tunnel keys, and token configurations stay in local environment files and never enter committed library manifests.

A change aligns when it hardens format consistency, improves physical device synchronization, protects volume fidelity, or makes reading notes more durable.
A change should be resisted when it introduces non-EPUB collection formats, reorganizes Calibre storage paths out of band, clobbers user notes, or adds decorative noise to the reading interface.
