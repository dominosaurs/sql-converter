import { describe, expect, test } from 'bun:test'
import {
    convertMariaDbBlobToSqlite,
    convertMariaDbToSqlite,
} from '../src/sql-converter'

describe('convertMariaDbToSqlite', () => {
    test('converts a common MariaDB dump table to SQLite', () => {
        const input = `
            SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
            CREATE TABLE \`users\` (
              \`id\` int(10) unsigned NOT NULL AUTO_INCREMENT,
              \`email\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
              \`status\` enum('active','disabled') NOT NULL DEFAULT 'active',
              \`created_at\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (\`id\`),
              UNIQUE KEY \`users_email_unique\` (\`email\`),
              KEY \`users_status_index\` (\`status\`)
            ) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain(
            '"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
        )
        expect(result.sql).toContain('"email" TEXT NOT NULL')
        expect(result.sql).toContain(
            '"status" TEXT NOT NULL DEFAULT \'active\'',
        )
        expect(result.sql).toContain(
            '"created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        )
        expect(result.sql).toContain('UNIQUE ("email")')
        expect(result.sql).not.toContain('ENGINE=')
        expect(result.sql).toContain(
            'CREATE INDEX "users_users_status_index" ON "users" ("status");',
        )
        expect(result.sql).not.toContain('KEY `users_status_index`')
        expect(result.warnings).toHaveLength(1)
    })

    test('preserves multi-row inserts with semicolons inside strings', () => {
        const input =
            "INSERT INTO `notes` (`body`) VALUES ('one; two'), ('three');"

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            'INSERT INTO "notes" ("body") VALUES (\'one; two\'), (\'three\');',
        )
    })

    test('preserves single-row inserts with html entity semicolons', () => {
        const input =
            "INSERT INTO `expenses` (`description`) VALUES ('PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');"

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            'INSERT INTO "expenses" ("description") VALUES (\'PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG\');',
        )
    })

    test('preserves risky multi-row inserts with apostrophes before semicolon values', () => {
        const input =
            "INSERT INTO `rent_item_rents` VALUES ('BIKIN JALAN DI KEBUN PAK MU\\'MIN'),('PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');"

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            "INSERT INTO \"rent_item_rents\" VALUES ('BIKIN JALAN DI KEBUN PAK MU''MIN'),('PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');",
        )
    })

    test('preserves multi-row inserts when semicolon appears many rows after apostrophe escaping', () => {
        const middleRows = Array.from(
            { length: 150 },
            (_, index) => `('middle row ${index + 1}')`,
        )
        const input = [
            "INSERT INTO `rent_item_rents` VALUES ('BIKIN JALAN DI KEBUN PAK MU\\'MIN')",
            ...middleRows,
            "('PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG')",
        ].join(',')

        const result = convertMariaDbToSqlite(`${input};`)

        expect(result.sql.trim()).toContain(
            "INSERT INTO \"rent_item_rents\" VALUES ('BIKIN JALAN DI KEBUN PAK MU''MIN'),('middle row 1')",
        )
        expect(result.sql.trim()).toContain(
            "('middle row 150'),('PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');",
        )
    })

    test('skips MariaDB database and locking statements', () => {
        const input = `
            CREATE DATABASE \`legacy\`;
            USE \`legacy\`;
            LOCK TABLES \`users\` WRITE;
            UNLOCK TABLES;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toBe('')
        expect(result.warnings).toHaveLength(4)
    })

    test('skips mysqldump SET directives even when comments precede them', () => {
        const input = `
            -- MariaDB dump 10.19
            /*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
            -- saved client
            SET NAMES utf8mb4;
            /*!40000 ALTER TABLE \`users\` DISABLE KEYS */;
            INSERT INTO \`users\` (\`id\`) VALUES (1);
            /*!40000 ALTER TABLE \`users\` ENABLE KEYS */;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toBe('INSERT INTO "users" ("id") VALUES (1);\n')
        expect(result.sql).not.toMatch(/\bSET\b/i)
        expect(result.sql).not.toMatch(/\bDISABLE\s+KEYS\b/i)
        expect(result.sql).not.toMatch(/\bENABLE\s+KEYS\b/i)
    })

    test('converts MariaDB hex literals outside quoted strings', () => {
        const input =
            "INSERT INTO `files` (`bin`, `label`) VALUES (0xDEADBEEF, 'keep 0xCAFE text');"

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            'INSERT INTO "files" ("bin", "label") VALUES (X\'DEADBEEF\', \'keep 0xCAFE text\');',
        )
    })

    test('handles table options comments with closing parenthesis', () => {
        const input = `
            CREATE TABLE \`comments\` (
              \`id\` int(11) NOT NULL AUTO_INCREMENT,
              \`body\` varchar(255) NOT NULL,
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='text with ) inside';
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain('CREATE TABLE "comments"')
        expect(result.sql).toContain(
            '"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
        )
        expect(result.sql).toContain('"body" TEXT NOT NULL')
        expect(result.sql).not.toContain('COMMENT=')
    })

    test('removes table primary key when auto increment column becomes sqlite primary key', () => {
        const input = `
            CREATE TABLE \`educations\` (
              \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
              \`name\` varchar(255) NOT NULL,
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain(
            '"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
        )
        expect(result.sql).toContain('"name" TEXT NOT NULL')
        expect(result.sql).not.toContain('PRIMARY KEY ("id")')
    })

    test('keeps composite table primary key when there is no auto increment column', () => {
        const input = `
            CREATE TABLE \`user_roles\` (
              \`user_id\` bigint(20) unsigned NOT NULL,
              \`role_id\` bigint(20) unsigned NOT NULL,
              PRIMARY KEY (\`user_id\`, \`role_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain('PRIMARY KEY ("user_id", "role_id")')
    })

    test('converts table constraints without treating CONSTRAINT as a column', () => {
        const input = `
            CREATE TABLE \`orders\` (
              \`id\` int(11) NOT NULL,
              \`user_id\` int(11) NOT NULL,
              CONSTRAINT \`orders_user_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
              KEY \`orders_user_id_index\` (\`user_id\`(10))
            ) ENGINE=InnoDB;
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain('"id" INTEGER NOT NULL')
        expect(result.sql).toContain(
            'FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE',
        )
        expect(result.sql).toContain(
            'CREATE INDEX "orders_orders_user_id_index" ON "orders" ("user_id");',
        )
        expect(result.sql).not.toContain('CONSTRAINT')
        expect(result.sql).not.toContain('"CONSTRAINT"')
    })

    test('converts json check columns and MySQL escaped json insert values', () => {
        const input = `
            CREATE TABLE \`mart_product_movement_details\` (
              \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
              \`product_state\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'state before movement' CHECK (json_valid(\`product_state\`)),
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            INSERT INTO \`mart_product_movement_details\` (\`id\`, \`product_state\`) VALUES
            (1,'{\\"name\\":\\"OWNER\\'S PRODUCT\\"}');
        `

        const result = convertMariaDbToSqlite(input)

        expect(result.sql).toContain(
            '"product_state" TEXT DEFAULT NULL CHECK (json_valid("product_state"))',
        )
        expect(result.sql).toContain(`'{"name":"OWNER''S PRODUCT"}'`)
        expect(result.sql).not.toContain('\\"')
        expect(result.sql).not.toContain("\\'")
    })

    test('uses standard sqlite quote escaping for apostrophes in insert values', () => {
        const input =
            "INSERT INTO `rent_item_rents` VALUES ('BIKIN JALAN DI KEBUN PAK MU\\'MIN','PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');"

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            "INSERT INTO \"rent_item_rents\" VALUES ('BIKIN JALAN DI KEBUN PAK MU''MIN','PENGANTARAN SOLAR EXCA SANY 01 &amp; EXCA XCMG');",
        )
    })

    test('preserves literal backticks inside JSON string values', () => {
        const input = `INSERT INTO \`activity_logs\` (\`model_value_changed\`) VALUES ('{\\"note\\":\\"\`\\",\\"uuid\\":\\"019cab37\\"}');`

        const result = convertMariaDbToSqlite(input)

        expect(result.sql.trim()).toBe(
            `INSERT INTO "activity_logs" ("model_value_changed") VALUES ('{"note":"\`","uuid":"019cab37"}');`,
        )
        expect(result.sql).not.toContain(`"note":"""`)
    })

    test('can wrap output for sqlite import', () => {
        const input = 'INSERT INTO `users` (`id`) VALUES (1);'

        const result = convertMariaDbToSqlite(input, {
            includeImportPragmas: true,
        })

        expect(result.sql).toContain('PRAGMA foreign_keys = OFF;')
        expect(result.sql).toContain('INSERT INTO "users" ("id") VALUES (1);')
        expect(result.sql).toContain('PRAGMA foreign_keys = ON;')
        expect(result.sql).not.toContain('BEGIN TRANSACTION;')
        expect(result.sql).not.toContain('COMMIT;')
        expect(result.sql).not.toContain('PRAGMA synchronous')
        expect(result.sql).not.toContain('PRAGMA journal_mode')
    })

    test('can explicitly wrap output in a transaction', () => {
        const input = 'INSERT INTO `users` (`id`) VALUES (1);'

        const result = convertMariaDbToSqlite(input, {
            includeImportPragmas: true,
            wrapInTransaction: true,
        })

        expect(result.sql).toContain('BEGIN TRANSACTION;')
        expect(result.sql).toContain('COMMIT;')
    })

    test('streams blob conversion without requiring full output in memory', async () => {
        const input = new Blob([
            'CREATE TABLE `users` (`id` int(11) NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`));',
            'INSERT INTO `users` (`id`) VALUES (1);',
        ])
        const chunks: string[] = []

        const result = await convertMariaDbBlobToSqlite(input, {
            async write(chunk) {
                chunks.push(chunk)
            },
        })

        expect(chunks.join('')).toContain(
            '"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
        )
        expect(chunks.join('')).toContain(
            'INSERT INTO "users" ("id") VALUES (1);',
        )
        expect(result.statementsConverted).toBe(2)
        expect(result.bytesRead).toBe(input.size)
    })

    test('streaming conversion skips commented mysqldump directives', async () => {
        const input = new Blob([
            '-- dump\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
            '\nINSERT INTO `users` (`id`) VALUES (1);',
        ])
        const chunks: string[] = []

        await convertMariaDbBlobToSqlite(input, {
            async write(chunk) {
                chunks.push(chunk)
            },
        })

        expect(chunks.join('')).toBe(
            'INSERT INTO "users" ("id") VALUES (1);\n\n',
        )
    })
})
