-- 0093 — allow Russian as a preferred language
--
-- THE GAP: `users.preferred_lang` has been `in ('en','id','zh')` since 0001.
-- The UI, however, ships four languages — `LANGS` in public/i18n.jsx is
-- ENG | ID | 中 | RU, and the switcher renders a RU button. So the app offers a
-- choice the database refuses.
--
-- That never surfaced because the language choice was never sent to the server
-- at all: `setLang` only wrote localStorage. The column was effectively dead,
-- and a Russian user's preference silently reset to English on every new device.
--
-- Fixing one without the other is worse than leaving both: persisting the choice
-- while the CHECK still rejects 'ru' would turn "your language resets" into "the
-- request 500s". So this migration lands together with the write path
-- (/api/me PATCH + setLang) and the widened `PreferredLang` union in
-- lib/types.ts.

begin;

alter table users drop constraint if exists users_preferred_lang_check;
alter table users add constraint users_preferred_lang_check
  check (preferred_lang in ('en','id','zh','ru'));

commit;
