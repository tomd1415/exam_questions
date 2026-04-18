-- Per-user font preference. Chunk 7 (Phase 2) accessibility pass.
--
-- 'system' uses the default --font-sans stack. 'dyslexic' switches the
-- whole page to OpenDyslexic (self-hosted, SIL OFL) via a data-font
-- attribute on <html> that the CSS branches on. We keep the value set
-- narrow and enforced at the DB layer so an admin SQL edit cannot slip
-- an unexpected value through.

ALTER TABLE users
  ADD COLUMN font_preference TEXT NOT NULL DEFAULT 'system'
    CHECK (font_preference IN ('system', 'dyslexic'));
