# SQL Converter

SQL Converter is a browser-side tool for converting MariaDB/MySQL `.sql` dump files into SQLite-compatible SQL.

Live app: https://dominosaurs.github.io/sql-converter/

## What It Does

- Converts MariaDB/MySQL dump syntax into SQLite-oriented SQL.
- Streams large input files directly from the browser.
- Writes the converted output to a local file without uploading database data.
- Handles common dump features such as data type conversion, quoted identifiers, auto-increment primary keys, indexes, foreign keys, JSON checks, dump directives, and MySQL string escapes.

## Browser Requirement

Large-file conversion uses the File System Access API so the app can stream output directly to disk.

Use a browser that supports `showSaveFilePicker`, such as:

- Chrome
- Edge

Firefox and Safari may not support the required direct-to-disk streaming flow.

## Supported Conversion Scope

The converter is designed for common `mysqldump` / MariaDB dump files.

Currently handled:

- `CREATE TABLE`
- `DROP TABLE`
- `INSERT`
- MariaDB/MySQL integer, decimal, text, blob, date/time, enum/set, and JSON-like column types
- `AUTO_INCREMENT` to SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`
- Table-level primary keys
- Unique constraints
- Normal indexes as separate `CREATE INDEX` statements
- Foreign key constraints
- `CHECK (json_valid(...))`
- MariaDB dump directives such as `SET`, `LOCK TABLES`, and `ALTER TABLE ... DISABLE/ENABLE KEYS`
- MySQL escaped string values in inserts
- MySQL hex literals like `0xDEADBEEF`

Known limits:

- This is not a full SQL parser.
- Stored procedures, triggers, views, generated columns, and complex vendor-specific SQL may need more handling.
- Memory use is bounded by chunks and completed statements, but a single extremely large SQL statement can still be expensive.

## Usage

1. Open https://dominosaurs.github.io/sql-converter/
2. Select a MariaDB/MySQL `.sql` dump file.
3. Choose the output file location when prompted.
4. Wait for conversion to finish.
5. Import the generated `.sqlite.sql` file with your SQLite client.

## Local Development

This project uses Bun.

```bash
bun install
bun run dev
```

Run checks:

```bash
bun run lint
bun test
bun run build
```

Preview production build:

```bash
bun run build
bun run preview
```

## Scripts

- `bun run dev` starts the Vite dev server.
- `bun run build` type-checks and builds the app.
- `bun run lint` runs Knip, Biome, and TypeScript checks.
- `bun run format` applies Biome formatting/fixes.
- `bun test` runs converter tests.
- `bun run preview` previews the production build.

## Deployment

The app is configured for GitHub Pages at:

```text
https://dominosaurs.github.io/sql-converter/
```

Vite uses:

```ts
base: '/sql-converter/'
```

GitHub Actions workflows:

- `.github/workflows/ci.yml` runs lint, tests, and build.
- `.github/workflows/deploy-pages.yml` builds and deploys `dist` to GitHub Pages.

In GitHub repository settings, configure Pages source as **GitHub Actions**.

## Reporting Issues

If a dump fails to import after conversion, open an issue:

https://github.com/dominosaurs/sql-converter/issues

Include:

- The SQLite error message.
- The source SQL statement that caused it.
- The converted output statement.
- Whether the dump came from MariaDB, MySQL, phpMyAdmin, or another tool.

## License

MIT
