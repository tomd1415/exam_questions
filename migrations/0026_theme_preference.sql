-- Phase 2.5 chunk 2.5n — per-user theme preference (light / dark / auto).
--
-- Adds users.theme_preference, a TEXT column constrained to the three
-- string literals the chrome template expects. Default 'auto' so a user
-- whose OS prefers dark immediately gets dark, while a user whose OS
-- prefers light sees the existing light theme unchanged. Explicit
-- 'light' / 'dark' values pin the theme regardless of OS preference.
--
-- The column is written to by POST /me/preferences/theme, and read by
-- the chrome template which renders <html data-theme="{value}">. Dark
-- theme is token-only (see src/static/design-tokens.css [data-theme="dark"]
-- override block); no component CSS needs to change.
--
-- Backfill is implicit: DEFAULT 'auto' means every existing row becomes
-- 'auto' on first read. No migration backfill script required.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'auto'
    CHECK (theme_preference IN ('light', 'dark', 'auto'));
