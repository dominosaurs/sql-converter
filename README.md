# SQL Converter

SQL Converter converts MariaDB/MySQL `.sql` dump files into SQLite-compatible SQL in the browser.

Live app: https://dominosaurs.github.io/sql-converter/

## ✨ Why This Exists

MariaDB and MySQL dumps often contain syntax that SQLite cannot import directly: backtick identifiers, `AUTO_INCREMENT`, engine options, charset/collation options, MariaDB dump directives, and MySQL-style escaped strings.

SQL Converter rewrites the common parts of those dumps so the output can be imported into SQLite with fewer manual edits.

## 🔒 Privacy

Conversion runs locally in your browser.

- The input dump is read from your disk.
- The converted file is written back to your disk.
- The app does not upload your database dump to a server.

## 🌐 Browser Requirement

Large-file conversion uses the File System Access API so output can be streamed directly to disk.

Recommended browsers:

- Chrome
- Edge

Firefox and Safari may not support the required `showSaveFilePicker` API for large-file direct-to-disk conversion.

## 🚀 Usage

1. Open https://dominosaurs.github.io/sql-converter/
2. Select a MariaDB/MySQL `.sql` dump file.
3. Choose where to save the converted SQLite SQL file.
4. Wait for conversion to finish.
5. Import the generated `.sqlite.sql` file with your SQLite client.

## 🔁 Example

MariaDB/MySQL dump input:

```sql
CREATE TABLE `users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `users` VALUES
(1,'O\'Connor');
```

SQLite output:

```sql
CREATE TABLE "users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" TEXT NOT NULL
);

INSERT INTO "users" VALUES
(1,'O''Connor');
```

## ✅ Supported Conversion Scope

The converter is designed for common `mysqldump`, MariaDB dump, and phpMyAdmin-style SQL exports.

Currently handled:

- `CREATE TABLE`
- `DROP TABLE`
- `INSERT`
- Backtick identifiers to SQLite double-quoted identifiers
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

Generated string values use standard SQLite single-quoted strings:

```sql
'O''Connor'
```

Multi-row inserts are preserved for performance.

## ⚠️ Known Limits

This is a practical dump converter, not a full SQL parser or validator.

Known limits:

- Stored procedures are not supported.
- Triggers and views may need manual review.
- Generated columns may need manual review.
- Vendor-specific functions may need manual review.
- A single extremely large SQL statement can still be expensive, even though file reading/writing is streamed.
- SQLite client/importer behavior varies. Some GUI tools may have script execution bugs even when the generated SQL is valid SQLite.

## 📥 Import Notes

If your SQLite GUI client fails to import a generated file, test the failing statement with another importer before assuming the SQL is invalid.

Recommended SQLite CLI import:

```bash
sqlite3 output.sqlite < converted.sqlite.sql
```

Or inside SQLite:

```sql
.read converted.sqlite.sql
```

## 🛠️ Local Development

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
