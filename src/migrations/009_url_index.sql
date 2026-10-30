-- The Chrome extension looks a job up by the page's url (findJobByUrl in web/lib/extension.ts): an exact match, or
-- one that only differs in query, hash or trailing slash. Both sides of that OR need an index, else every lookup
-- reads the whole jobs table. The expression must stay identical to NORMALIZED in web/lib/extension.ts
-- (tests/migrate.test.ts checks that the planner uses it).
CREATE INDEX IF NOT EXISTS jobs_url ON jobs (url);
CREATE INDEX IF NOT EXISTS jobs_url_normalized ON jobs ((rtrim(split_part(split_part(url, '#', 1), '?', 1), '/')));
