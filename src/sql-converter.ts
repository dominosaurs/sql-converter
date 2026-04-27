export type ConversionWarning = {
    statement: string
    reason: string
}

type ConversionResult = {
    sql: string
    warnings: ConversionWarning[]
}

type ConversionOptions = {
    includeImportPragmas?: boolean
    preserveIndexes?: boolean
    wrapInTransaction?: boolean
    signal?: AbortSignal
}

export type ConversionProgress = {
    bytesRead: number
    statementsConverted: number
    warnings: number
}

type ConversionWriter = {
    write(chunk: string): Promise<void>
}

type StreamingConversionResult = {
    bytesRead: number
    statementsConverted: number
    warnings: ConversionWarning[]
}

type ConvertContext = {
    warnings: ConversionWarning[]
    preserveIndexes: boolean
}

const SKIPPED_STATEMENT_PATTERNS = [
    {
        pattern: /^SET\s+/i,
        reason: 'MariaDB session settings are not supported by SQLite.',
    },
    {
        pattern: /^USE\s+/i,
        reason: 'SQLite has no database selection statement.',
    },
    {
        pattern: /^CREATE\s+DATABASE\b/i,
        reason: 'SQLite databases are files, not schemas created by SQL dumps.',
    },
    {
        pattern: /^ALTER\s+TABLE\b[\s\S]*\b(?:DISABLE|ENABLE)\s+KEYS\b/i,
        reason: 'MariaDB bulk-load key toggles are not supported by SQLite.',
    },
    {
        pattern: /^LOCK\s+TABLES\b/i,
        reason: 'MariaDB table locks are not supported by SQLite.',
    },
    {
        pattern: /^UNLOCK\s+TABLES\b/i,
        reason: 'MariaDB table locks are not supported by SQLite.',
    },
    {
        pattern: /^DELIMITER\b/i,
        reason: 'Custom delimiters are a MariaDB client feature.',
    },
    {
        pattern: /^\/\*![\s\S]*\*\/$/i,
        reason: 'MariaDB versioned directives are not supported by SQLite.',
    },
]

const INDEX_DEFINITION_PATTERN =
    /^(?:KEY|INDEX|FULLTEXT\s+KEY|FULLTEXT\s+INDEX|SPATIAL\s+KEY|SPATIAL\s+INDEX)\b/i

export function convertMariaDbToSqlite(
    input: string,
    options: ConversionOptions = {},
): ConversionResult {
    const warnings: ConversionWarning[] = []
    const statements = splitSqlStatements(input)
    const convertedStatements: string[] = []
    const context: ConvertContext = {
        preserveIndexes: options.preserveIndexes ?? true,
        warnings,
    }

    for (const statement of statements) {
        const converted = convertStatement(statement, context)

        if (converted) {
            convertedStatements.push(ensureSemicolon(converted))
        }
    }

    const sql =
        convertedStatements.join('\n\n') +
        (convertedStatements.length > 0 ? '\n' : '')

    return {
        sql: options.includeImportPragmas
            ? wrapForSqliteImport(sql, options)
            : sql,
        warnings,
    }
}

export async function convertMariaDbBlobToSqlite(
    input: Blob,
    writer: ConversionWriter,
    options: ConversionOptions = {},
    onProgress?: (progress: ConversionProgress) => void,
): Promise<StreamingConversionResult> {
    const warnings: ConversionWarning[] = []
    const context: ConvertContext = {
        preserveIndexes: options.preserveIndexes ?? true,
        warnings,
    }
    const splitter = new SqlStatementStreamSplitter()
    const decoder = new TextDecoder()
    const reader = input.stream().getReader()
    let bytesRead = 0
    let statementsConverted = 0

    if (options.includeImportPragmas) {
        throwIfAborted(options.signal)
        await writer.write(getSqliteImportPrefix(options))
    }

    while (true) {
        throwIfAborted(options.signal)
        const { done, value } = await reader.read()

        if (done) {
            break
        }

        bytesRead += value.byteLength
        const chunk = decoder.decode(value, { stream: true })
        throwIfAborted(options.signal)
        statementsConverted += await convertAndWriteStatements(
            splitter.push(chunk),
            writer,
            context,
        )
        onProgress?.({
            bytesRead,
            statementsConverted,
            warnings: warnings.length,
        })
    }

    throwIfAborted(options.signal)
    const finalChunk = decoder.decode()
    const finalStatements = finalChunk ? splitter.push(finalChunk) : []
    statementsConverted += await convertAndWriteStatements(
        [...finalStatements, ...splitter.finish()],
        writer,
        context,
    )

    if (options.includeImportPragmas) {
        await writer.write(getSqliteImportSuffix(options))
    }

    onProgress?.({ bytesRead, statementsConverted, warnings: warnings.length })

    return { bytesRead, statementsConverted, warnings }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new DOMException('Conversion cancelled.', 'AbortError')
    }
}

function convertStatement(
    statement: string,
    context: ConvertContext,
): string | null {
    const trimmed = stripMariaDbDirectiveComments(
        stripPlainSqlComments(statement.trim()),
    )

    if (!trimmed) {
        return null
    }

    const skipped = SKIPPED_STATEMENT_PATTERNS.find(({ pattern }) =>
        pattern.test(trimmed),
    )

    if (skipped) {
        context.warnings.push({
            reason: skipped.reason,
            statement: summarizeStatement(trimmed),
        })
        return null
    }

    if (/^CREATE\s+TABLE\b/i.test(trimmed)) {
        return convertCreateTable(trimmed, context)
    }

    const converted = convertGeneralStatement(trimmed)

    if (
        /^INSERT\b/i.test(converted) &&
        hasSemicolonInsideSingleQuotedString(converted)
    ) {
        return splitMultiRowInsert(converted)
    }

    return converted
}

function convertCreateTable(
    statement: string,
    context: ConvertContext,
): string {
    const createTableMatch = extractCreateTableParts(statement)

    if (!createTableMatch) {
        return convertGeneralStatement(statement)
    }

    const { prefix, body } = createTableMatch
    const tableName = getCreateTableName(prefix)
    const definitions = splitCommaSeparated(body)
    const autoIncrementColumn = findAutoIncrementColumn(definitions)
    const indexes =
        context.preserveIndexes && tableName
            ? extractIndexes(definitions, tableName, context.warnings)
            : []
    const convertedDefinitions = definitions
        .map(definition =>
            convertTableDefinition(
                definition,
                autoIncrementColumn,
                context.warnings,
            ),
        )
        .filter((definition): definition is string => Boolean(definition))

    if (convertedDefinitions.length === 0) {
        context.warnings.push({
            reason: 'CREATE TABLE had no SQLite-compatible column definitions and was skipped.',
            statement: summarizeStatement(statement),
        })

        return indexes.join(';\n\n')
    }

    const createTable = `${convertGeneralStatement(prefix.trimEnd())}\n  ${convertedDefinitions.join(',\n  ')}\n)`

    return [createTable, ...indexes].join(';\n\n')
}

function convertTableDefinition(
    definition: string,
    autoIncrementColumn: string | null,
    warnings: ConversionWarning[],
): string | null {
    const trimmed = definition.trim()

    if (INDEX_DEFINITION_PATTERN.test(trimmed)) {
        return null
    }

    if (isPrimaryKeyForAutoIncrementColumn(trimmed, autoIncrementColumn)) {
        return null
    }

    if (/^PRIMARY\s+KEY\b/i.test(trimmed)) {
        return convertGeneralStatement(trimmed)
    }

    if (/^FOREIGN\s+KEY\b/i.test(trimmed)) {
        return convertForeignKeyDefinition(trimmed, warnings)
    }

    if (/^CONSTRAINT\b/i.test(trimmed)) {
        return convertConstraintDefinition(trimmed, warnings)
    }

    if (/^CHECK\b/i.test(trimmed)) {
        return convertGeneralStatement(trimmed)
    }

    if (/^UNIQUE\s+(?:KEY|INDEX)\b/i.test(trimmed)) {
        return convertGeneralStatement(
            trimmed.replace(
                /^UNIQUE\s+(?:KEY|INDEX)\s+(?:`[^`]+`|\S+)\s*/i,
                'UNIQUE ',
            ),
        )
    }

    if (!isColumnDefinition(trimmed)) {
        return convertGeneralStatement(trimmed)
    }

    return convertColumnDefinition(trimmed)
}

function convertColumnDefinition(definition: string): string {
    const columnNameMatch = definition.match(
        /^(`[^`]+`|"[^"]+"|\[[^\]]+\]|\S+)\s+([\s\S]+)$/,
    )

    if (!columnNameMatch) {
        return convertGeneralStatement(definition)
    }

    const [, columnName, rest] = columnNameMatch
    const hasAutoIncrement = /\bAUTO_INCREMENT\b/i.test(rest)
    let convertedRest = rest
        .replace(/\bAUTO_INCREMENT\b/gi, '')
        .replace(/\bUNSIGNED\b/gi, '')
        .replace(/\bZEROFILL\b/gi, '')
        .replace(/\s+CHARACTER\s+SET\s+\S+/gi, '')
        .replace(/\s+COLLATE\s+\S+/gi, '')
        .replace(/\s+COMMENT\s+'(?:''|\\'|[^'])*'/gi, '')
        .replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\))?/gi, '')
        .replace(
            /\bDEFAULT\s+current_timestamp\(\)/gi,
            'DEFAULT CURRENT_TIMESTAMP',
        )
        .replace(
            /\bDEFAULT\s+CURRENT_TIMESTAMP\(\)/g,
            'DEFAULT CURRENT_TIMESTAMP',
        )
        .replace(/\s+/g, ' ')
        .trim()

    convertedRest = replaceLeadingColumnType(convertedRest)

    if (hasAutoIncrement) {
        convertedRest = convertedRest
            .replace(/\bPRIMARY\s+KEY\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim()

        return `${convertIdentifier(columnName)} INTEGER PRIMARY KEY AUTOINCREMENT${withoutLeadingIntegerType(convertedRest)}`
    }

    return `${convertIdentifier(columnName)} ${convertGeneralStatement(convertedRest)}`
}

function convertForeignKeyDefinition(
    definition: string,
    warnings: ConversionWarning[],
): string | null {
    if (/\bON\s+(?:DELETE|UPDATE)\s+SET\s+DEFAULT\b/i.test(definition)) {
        warnings.push({
            reason: 'Foreign key action SET DEFAULT was skipped because it is commonly incompatible during SQLite imports.',
            statement: summarizeStatement(definition),
        })
        return null
    }

    return convertGeneralStatement(removeIndexLengths(definition))
}

function convertConstraintDefinition(
    definition: string,
    warnings: ConversionWarning[],
): string | null {
    const withoutSymbolName = definition.replace(
        /^CONSTRAINT\s+(?:`[^`]+`|"[^"]+"|\S+)\s+/i,
        '',
    )

    if (/^FOREIGN\s+KEY\b/i.test(withoutSymbolName)) {
        return convertForeignKeyDefinition(withoutSymbolName, warnings)
    }

    if (/^(?:PRIMARY\s+KEY|UNIQUE|CHECK)\b/i.test(withoutSymbolName)) {
        return convertGeneralStatement(removeIndexLengths(withoutSymbolName))
    }

    warnings.push({
        reason: 'Unsupported MariaDB table constraint was skipped.',
        statement: summarizeStatement(definition),
    })

    return null
}

function replaceLeadingColumnType(rest: string): string {
    const typeMatch = rest.match(/^([a-zA-Z]+)(?:\s*\([^)]*\))?([\s\S]*)$/)

    if (!typeMatch) {
        return rest
    }

    const [, rawType, suffix] = typeMatch
    const type = rawType.toUpperCase()

    if (
        [
            'TINYINT',
            'SMALLINT',
            'MEDIUMINT',
            'INT',
            'INTEGER',
            'BIGINT',
            'YEAR',
            'BIT',
            'BOOL',
            'BOOLEAN',
        ].includes(type)
    ) {
        return `INTEGER${suffix}`
    }

    if (['DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL'].includes(type)) {
        return `REAL${suffix}`
    }

    if (
        [
            'CHAR',
            'VARCHAR',
            'TINYTEXT',
            'TEXT',
            'MEDIUMTEXT',
            'LONGTEXT',
            'ENUM',
            'SET',
            'JSON',
            'DATE',
            'TIME',
            'DATETIME',
            'TIMESTAMP',
        ].includes(type)
    ) {
        return `TEXT${suffix}`
    }

    if (
        [
            'BINARY',
            'VARBINARY',
            'TINYBLOB',
            'BLOB',
            'MEDIUMBLOB',
            'LONGBLOB',
        ].includes(type)
    ) {
        return `BLOB${suffix}`
    }

    return rest.replace(/^([a-zA-Z]+)(?:\s*\([^)]*\))?/, type)
}

function withoutLeadingIntegerType(rest: string): string {
    const suffix = rest.replace(/^INTEGER\b/i, '').trim()
    return suffix ? ` ${suffix}` : ''
}

function convertIdentifier(identifier: string): string {
    return identifier.startsWith('`') && identifier.endsWith('`')
        ? `"${identifier.slice(1, -1)}"`
        : identifier
}

function convertGeneralStatement(statement: string): string {
    return replaceBacktickIdentifiers(
        replaceMySqlStringEscapes(
            replaceMariaDbHexLiterals(
                stripMariaDbDirectiveComments(stripPlainSqlComments(statement)),
            ),
        ),
    )
        .replace(/\bAUTO_INCREMENT\s*=\s*\d+\b/gi, '')
        .replace(/\bENGINE\s*=\s*\w+\b/gi, '')
        .replace(/\bDEFAULT\s+CHARSET\s*=\s*[\w\d_]+/gi, '')
        .replace(/\bCHARSET\s*=\s*[\w\d_]+/gi, '')
        .replace(/\bCOLLATE\s*=\s*[\w\d_]+/gi, '')
        .replace(/\bROW_FORMAT\s*=\s*\w+\b/gi, '')
        .replace(/\s+;/g, ';')
        .replace(/[ \t]+$/gm, '')
        .trim()
}

function hasSemicolonInsideSingleQuotedString(statement: string): boolean {
    let inSingleQuote = false

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (!inSingleQuote) {
            if (char === "'") {
                inSingleQuote = true
            }
            continue
        }

        if (char === "'" && next === "'") {
            index += 1
            continue
        }

        if (char === "'") {
            inSingleQuote = false
            continue
        }

        if (char === ';') {
            return true
        }
    }

    return false
}

function splitMultiRowInsert(statement: string): string {
    const valuesKeywordIndex = findValuesKeywordOutsideQuotes(statement)

    if (valuesKeywordIndex === -1) {
        return statement
    }

    const prefix = statement
        .slice(0, valuesKeywordIndex + 'VALUES'.length)
        .trimEnd()
    const values = statement.slice(valuesKeywordIndex + 'VALUES'.length).trim()
    const valuesWithoutSemicolon = values.endsWith(';')
        ? values.slice(0, -1)
        : values
    const rows = splitCommaSeparated(valuesWithoutSemicolon)

    if (rows.length <= 1 || !rows.every(row => row.startsWith('('))) {
        return statement
    }

    return rows.map(row => `${prefix} ${row}`).join(';\n')
}

function findValuesKeywordOutsideQuotes(statement: string): number {
    let quote: "'" | '"' | '`' | null = null

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (quote) {
            if (char === "'" && quote === "'" && next === "'") {
                index += 1
                continue
            }

            if (char === quote) {
                quote = null
            }
            continue
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char
            continue
        }

        if (/^VALUES\b/i.test(statement.slice(index))) {
            return index
        }
    }

    return -1
}

function extractIndexes(
    definitions: string[],
    tableName: string,
    warnings: ConversionWarning[],
): string[] {
    return definitions.flatMap(definition => {
        const trimmed = definition.trim()

        if (/^(?:KEY|INDEX)\b/i.test(trimmed)) {
            return convertIndexDefinition(trimmed, tableName, false)
        }

        if (/^UNIQUE\s+(?:KEY|INDEX)\b/i.test(trimmed)) {
            return []
        }

        if (/^(?:FULLTEXT|SPATIAL)\s+(?:KEY|INDEX)\b/i.test(trimmed)) {
            warnings.push({
                reason: 'SQLite does not support MariaDB FULLTEXT/SPATIAL indexes directly.',
                statement: summarizeStatement(trimmed),
            })
        }

        return []
    })
}

function convertIndexDefinition(
    definition: string,
    tableName: string,
    unique: boolean,
): string[] {
    const indexMatch = definition.match(
        /^(?:KEY|INDEX)\s+(`[^`]+`|"[^"]+"|\S+)\s*\(([\s\S]+)\)$/i,
    )

    if (!indexMatch) {
        return []
    }

    const [, rawIndexName, rawColumns] = indexMatch
    const indexName = `${stripIdentifierQuotes(tableName)}_${stripIdentifierQuotes(rawIndexName)}`
    const uniqueSql = unique ? 'UNIQUE ' : ''

    return [
        `CREATE ${uniqueSql}INDEX "${indexName}" ON ${quoteIdentifier(tableName)} (${convertIndexColumns(rawColumns)})`,
    ]
}

function convertIndexColumns(columns: string): string {
    return splitCommaSeparated(columns)
        .map(column => removeIndexLengths(column).replace(/`/g, '"').trim())
        .join(', ')
}

function removeIndexLengths(value: string): string {
    return value.replace(/(`[^`]+`|"[^"]+"|\w+)\s*\(\d+\)/g, '$1')
}

function extractCreateTableParts(
    statement: string,
): { prefix: string; body: string } | null {
    const openParenIndex = statement.indexOf('(')

    if (openParenIndex === -1) {
        return null
    }

    let quote: "'" | '"' | '`' | null = null
    let depth = 0

    for (let index = openParenIndex; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (quote) {
            if (char === '\\' && quote !== '`' && next) {
                index += 1
                continue
            }

            if (char === quote) {
                quote = null
            }
            continue
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char
            continue
        }

        if (char === '(') {
            depth += 1
            continue
        }

        if (char === ')') {
            depth -= 1

            if (depth === 0) {
                return {
                    body: statement.slice(openParenIndex + 1, index),
                    prefix: statement.slice(0, openParenIndex + 1),
                }
            }
        }
    }

    return null
}

function getCreateTableName(prefix: string): string | null {
    const tableNameMatch = prefix.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\S+)\s*\($/i,
    )
    return tableNameMatch?.[1] ?? null
}

function quoteIdentifier(identifier: string): string {
    const unquoted = stripIdentifierQuotes(identifier)
    return `"${unquoted.replace(/"/g, '""')}"`
}

function stripIdentifierQuotes(identifier: string): string {
    if (
        (identifier.startsWith('`') && identifier.endsWith('`')) ||
        (identifier.startsWith('"') && identifier.endsWith('"'))
    ) {
        return identifier.slice(1, -1)
    }

    return identifier
}

function replaceMariaDbHexLiterals(statement: string): string {
    let converted = ''
    let quote: "'" | '"' | '`' | null = null

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (quote) {
            converted += char

            if (char === '\\' && quote !== '`' && next) {
                converted += next
                index += 1
                continue
            }

            if (char === quote) {
                quote = null
            }
            continue
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char
            converted += char
            continue
        }

        if (char === '0' && next?.toLowerCase() === 'x') {
            const hexStart = index + 2
            let hexEnd = hexStart

            while (/[a-fA-F0-9]/.test(statement[hexEnd] ?? '')) {
                hexEnd += 1
            }

            if (hexEnd > hexStart) {
                converted += `X'${statement.slice(hexStart, hexEnd)}'`
                index = hexEnd - 1
                continue
            }
        }

        converted += char
    }

    return converted
}

function replaceMySqlStringEscapes(statement: string): string {
    let converted = ''

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]

        if (char !== "'") {
            converted += char
            continue
        }

        const parsed = readSingleQuotedString(statement, index)

        if (!parsed) {
            converted += char
            continue
        }

        converted += `'${parsed.value.replace(/'/g, "''")}'`
        index = parsed.endIndex
    }

    return converted
}

function replaceBacktickIdentifiers(statement: string): string {
    let converted = ''
    let singleQuote = false
    let doubleQuote = false

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (singleQuote) {
            converted += char

            if (char === "'" && next === "'") {
                converted += next
                index += 1
                continue
            }

            if (char === "'") {
                singleQuote = false
            }
            continue
        }

        if (doubleQuote) {
            converted += char

            if (char === '"' && next === '"') {
                converted += next
                index += 1
                continue
            }

            if (char === '"') {
                doubleQuote = false
            }
            continue
        }

        if (char === "'") {
            singleQuote = true
            converted += char
            continue
        }

        if (char === '"') {
            doubleQuote = true
            converted += char
            continue
        }

        if (char === '`') {
            const closingIndex = statement.indexOf('`', index + 1)

            if (closingIndex !== -1) {
                converted += quoteIdentifier(
                    statement.slice(index + 1, closingIndex),
                )
                index = closingIndex
                continue
            }
        }

        converted += char
    }

    return converted
}

function readSingleQuotedString(
    statement: string,
    startIndex: number,
): { value: string; endIndex: number } | null {
    let value = ''

    for (let index = startIndex + 1; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (char === "'" && next === "'") {
            value += "'"
            index += 1
            continue
        }

        if (char === "'") {
            return { endIndex: index, value }
        }

        if (char === '\\' && next !== undefined) {
            const escaped = decodeMySqlEscape(next)
            value += escaped
            index += 1
            continue
        }

        value += char
    }

    return null
}

function decodeMySqlEscape(char: string): string {
    switch (char) {
        case '0':
            return '\0'
        case 'b':
            return '\b'
        case 'n':
            return '\n'
        case 'r':
            return '\r'
        case 't':
            return '\t'
        case 'Z':
            return '\u001A'
        default:
            return char
    }
}

function wrapForSqliteImport(sql: string, options: ConversionOptions): string {
    return `${getSqliteImportPrefix(options)}${sql.trim()}\n\n${getSqliteImportSuffix(options)}`
}

async function convertAndWriteStatements(
    statements: string[],
    writer: ConversionWriter,
    context: ConvertContext,
): Promise<number> {
    let statementsConverted = 0

    for (const statement of statements) {
        const converted = convertStatement(statement, context)

        if (converted) {
            await writer.write(`${ensureSemicolon(converted)}\n\n`)
            statementsConverted += 1
        }
    }

    return statementsConverted
}

function getSqliteImportPrefix(options: ConversionOptions = {}): string {
    const statements = ['PRAGMA foreign_keys = OFF;']

    if (options.wrapInTransaction) {
        statements.push('BEGIN TRANSACTION;')
    }

    return [...statements, ''].join('\n')
}

function getSqliteImportSuffix(options: ConversionOptions = {}): string {
    const statements = ['PRAGMA foreign_keys = ON;']

    if (options.wrapInTransaction) {
        statements.unshift('COMMIT;')
    }

    return [...statements, ''].join('\n')
}

function stripMariaDbDirectiveComments(statement: string): string {
    return statement
        .replace(/\/\*![0-9]{5}\s+([\s\S]*?)\*\//g, '$1')
        .replace(/\/\*!999999\\- enable the sandbox mode \*\//g, '')
        .trim()
}

function stripPlainSqlComments(statement: string): string {
    let converted = ''
    let quote: "'" | '"' | '`' | null = null
    let lineComment = false
    let blockComment = false

    for (let index = 0; index < statement.length; index += 1) {
        const char = statement[index]
        const next = statement[index + 1]

        if (lineComment) {
            if (char === '\n') {
                lineComment = false
                converted += '\n'
            }
            continue
        }

        if (blockComment) {
            if (char === '*' && next === '/') {
                index += 1
                blockComment = false
            }
            continue
        }

        if (quote) {
            converted += char

            if (char === '\\' && quote !== '`' && next) {
                converted += next
                index += 1
                continue
            }

            if (char === quote) {
                quote = null
            }
            continue
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char
            converted += char
            continue
        }

        if (char === '-' && next === '-') {
            lineComment = true
            index += 1
            continue
        }

        if (char === '#') {
            lineComment = true
            continue
        }

        if (char === '/' && next === '*' && statement[index + 2] !== '!') {
            blockComment = true
            index += 1
            continue
        }

        converted += char
    }

    return converted.trim()
}

function splitSqlStatements(sql: string): string[] {
    const splitter = new SqlStatementStreamSplitter()
    return [...splitter.push(sql), ...splitter.finish()]
}

class SqlStatementStreamSplitter {
    private current = ''
    private quote: "'" | '"' | '`' | null = null
    private lineComment = false
    private blockComment = false

    push(sql: string): string[] {
        const statements: string[] = []

        for (let index = 0; index < sql.length; index += 1) {
            const char = sql[index]
            const next = sql[index + 1]

            this.current += char

            if (this.lineComment) {
                if (char === '\n') this.lineComment = false
                continue
            }

            if (this.blockComment) {
                if (char === '*' && next === '/') {
                    this.current += next
                    index += 1
                    this.blockComment = false
                }
                continue
            }

            if (this.quote) {
                if (char === '\\' && this.quote !== '`' && next) {
                    this.current += next
                    index += 1
                    continue
                }

                if (char === this.quote) {
                    this.quote = null
                }
                continue
            }

            if (char === '-' && next === '-') {
                this.lineComment = true
                continue
            }

            if (char === '#') {
                this.lineComment = true
                continue
            }

            if (char === '/' && next === '*') {
                this.current += next
                index += 1
                this.blockComment = true
                continue
            }

            if (char === "'" || char === '"' || char === '`') {
                this.quote = char
                continue
            }

            if (char === ';') {
                statements.push(this.current.slice(0, -1).trim())
                this.current = ''
            }
        }

        return statements.filter(Boolean)
    }

    finish(): string[] {
        const remaining = this.current.trim()
        this.current = ''
        return remaining ? [remaining] : []
    }
}

function splitCommaSeparated(input: string): string[] {
    const parts: string[] = []
    let current = ''
    let quote: "'" | '"' | '`' | null = null
    let depth = 0

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index]
        const next = input[index + 1]

        if (quote) {
            current += char

            if (char === '\\' && quote !== '`' && next) {
                current += next
                index += 1
                continue
            }

            if (char === quote) {
                quote = null
            }
            continue
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char
            current += char
            continue
        }

        if (char === '(') depth += 1
        if (char === ')') depth -= 1

        if (char === ',' && depth === 0) {
            parts.push(current.trim())
            current = ''
            continue
        }

        current += char
    }

    if (current.trim()) parts.push(current.trim())
    return parts
}

function findAutoIncrementColumn(definitions: string[]): string | null {
    const definition = definitions.find(candidate =>
        /\bAUTO_INCREMENT\b/i.test(candidate),
    )
    const match = definition?.match(/^`?([^`\s]+)`?\s+/)
    return match?.[1] ?? null
}

function isPrimaryKeyForAutoIncrementColumn(
    definition: string,
    autoIncrementColumn: string | null,
): boolean {
    if (!autoIncrementColumn) {
        return false
    }

    const primaryKeyMatch = definition.match(/^PRIMARY\s+KEY\s*\(([\s\S]+)\)$/i)

    if (!primaryKeyMatch) {
        return false
    }

    const primaryKeyColumns = splitCommaSeparated(primaryKeyMatch[1]).map(
        column => stripIdentifierQuotes(removeIndexLengths(column).trim()),
    )

    return (
        primaryKeyColumns.length === 1 &&
        primaryKeyColumns[0] === autoIncrementColumn
    )
}

function isColumnDefinition(definition: string): boolean {
    return (
        !/^(?:PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK|KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(
            definition,
        ) && /^(`[^`]+`|"[^"]+"|\[[^\]]+\]|\S+)\s+\w+/i.test(definition)
    )
}

function ensureSemicolon(statement: string): string {
    return statement.endsWith(';') ? statement : `${statement};`
}

function summarizeStatement(statement: string): string {
    return statement.replace(/\s+/g, ' ').slice(0, 120)
}
