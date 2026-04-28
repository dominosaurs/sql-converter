import { useRef, useState } from 'react'
import {
    type ConversionProgress,
    type ConversionWarning,
    convertMariaDbBlobToSqlite,
} from './sql-converter'

declare const __APP_VERSION__: string

type FileSystemWritableFileStreamLike = {
    write(chunk: string): Promise<void>
    close(): Promise<void>
    abort?: () => Promise<void>
}

type FileSystemFileHandleLike = {
    name?: string
    createWritable(): Promise<FileSystemWritableFileStreamLike>
}

type WindowWithSaveFilePicker = Window & {
    showSaveFilePicker?: (options: {
        suggestedName?: string
        types?: Array<{
            description: string
            accept: Record<string, string[]>
        }>
    }) => Promise<FileSystemFileHandleLike>
}

type ConversionState =
    | 'idle'
    | 'selecting'
    | 'converting'
    | 'success'
    | 'error'
    | 'cancelled'

export default function App() {
    const inputFileRef = useRef<null | HTMLInputElement>(null)
    const abortControllerRef = useRef<AbortController | null>(null)
    const [warnings, setWarnings] = useState<ConversionWarning[]>([])
    const [progress, setProgress] = useState<ConversionProgress | null>(null)
    const [selectedFileName, setSelectedFileName] = useState('')
    const [selectedFileSize, setSelectedFileSize] = useState(0)
    const [outputFileName, setOutputFileName] = useState('')
    const [status, setStatus] = useState(
        'Choose a MariaDB .sql dump, then convert it to a SQLite import file.',
    )
    const [conversionState, setConversionState] =
        useState<ConversionState>('idle')
    const [isConverting, setIsConverting] = useState(false)

    const handleConvertClick = () => {
        const file = inputFileRef.current?.files?.[0]

        if (!file) {
            inputFileRef.current?.click()
            return
        }

        void convertFile(file)
    }

    const handleFileChange = (file: File | undefined) => {
        setSelectedFileName(file?.name ?? '')
        setSelectedFileSize(file?.size ?? 0)

        if (file) {
            void convertFile(file)
        }
    }

    const convertFile = async (file: File) => {
        if (!file || isConverting) return

        const saveFilePicker = (window as WindowWithSaveFilePicker)
            .showSaveFilePicker

        if (!saveFilePicker) {
            setStatus(
                'This browser cannot stream directly to disk. Use Chrome or Edge for large 1GB files.',
            )
            setConversionState('error')
            return
        }

        setIsConverting(true)
        setWarnings([])
        setProgress(null)
        setOutputFileName('')
        setStatus('Waiting for output file selection...')
        setConversionState('selecting')

        let writable: FileSystemWritableFileStreamLike | null = null
        let wasCancelled = false
        const abortController = new AbortController()
        abortControllerRef.current = abortController

        try {
            const suggestedOutputFileName = `${file.name.replace(/\.sql$/i, '')}.sqlite.sql`
            const outputHandle = await saveFilePicker({
                suggestedName: suggestedOutputFileName,
                types: [
                    {
                        accept: { 'application/sql': ['.sql'] },
                        description: 'SQLite SQL file',
                    },
                ],
            })

            const outputName = outputHandle.name ?? suggestedOutputFileName
            writable = await outputHandle.createWritable()
            setOutputFileName(outputName)
            setStatus('')
            setConversionState('converting')

            const result = await convertMariaDbBlobToSqlite(
                file,
                writable,
                {
                    includeImportPragmas: true,
                    preserveIndexes: true,
                    signal: abortController.signal,
                },
                setProgress,
            )

            setWarnings(result.warnings)
            setStatus(
                `Success. Converted ${result.statementsConverted.toLocaleString()} SQL statements to ${outputName}.`,
            )
            setConversionState('success')
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                wasCancelled = true
                setStatus('Conversion cancelled. No output file was completed.')
                setConversionState('cancelled')
            } else {
                setStatus(
                    'Conversion failed. The output file may be incomplete.',
                )
                setConversionState('error')
            }
        } finally {
            if (wasCancelled) {
                await writable?.abort?.()
            } else {
                await writable?.close()
            }
            abortControllerRef.current = null
            setIsConverting(false)
        }
    }

    const handleCancel = () => {
        abortControllerRef.current?.abort()
    }

    const handleReset = () => {
        if (inputFileRef.current) {
            inputFileRef.current.value = ''
        }

        setWarnings([])
        setProgress(null)
        setSelectedFileName('')
        setSelectedFileSize(0)
        setOutputFileName('')
        setStatus(
            'Choose a MariaDB .sql dump, then convert it to a SQLite import file.',
        )
        setConversionState('idle')
    }

    const isFinished =
        conversionState === 'success' ||
        conversionState === 'error' ||
        conversionState === 'cancelled'

    return (
        <main className="page-shell">
            <section aria-labelledby="page-title" className="hero">
                <div className="hero-copy">
                    <p className="eyebrow">Browser-side database migration</p>
                    <h1 id="page-title">SQL Converter</h1>
                    <p className="lede">
                        Convert MariaDB and MySQL dump files into
                        SQLite-compatible SQL. Built for large `.sql` exports,
                        streamed directly from your browser to a local output
                        file.
                    </p>

                    <div className="feature-row">
                        <span>MariaDB to SQLite</span>
                        <span>MySQL dump support</span>
                        <span>No upload required</span>
                    </div>
                </div>

                <form
                    className="converter-card"
                    onSubmit={event => event.preventDefault()}
                >
                    <div>
                        <p className="card-kicker">Convert a dump</p>
                        <h2>Generate SQLite import SQL</h2>
                        <p className="card-copy">
                            Select a `.sql` dump, choose where to save the
                            converted file, then import it with your SQLite
                            client.
                        </p>
                    </div>

                    <label className="file-drop">
                        <input
                            accept=".sql"
                            disabled={isConverting}
                            onChange={event =>
                                handleFileChange(event.currentTarget.files?.[0])
                            }
                            ref={inputFileRef}
                            type="file"
                        />
                        <span>
                            {selectedFileName ||
                                'Choose MariaDB/MySQL .sql file'}
                        </span>
                    </label>

                    <div className="action-row">
                        <button
                            className="primary-action"
                            disabled={isConverting}
                            onClick={handleConvertClick}
                            type="button"
                        >
                            {isConverting
                                ? 'Converting...'
                                : 'Convert to SQLite SQL'}
                        </button>

                        {isConverting ? (
                            <button
                                className="secondary-action danger-action"
                                onClick={handleCancel}
                                type="button"
                            >
                                Cancel
                            </button>
                        ) : null}

                        {isFinished ? (
                            <button
                                className="secondary-action"
                                onClick={handleReset}
                                type="button"
                            >
                                Try another file
                            </button>
                        ) : null}
                    </div>

                    {status ? (
                        <p
                            className={`status status-${conversionState}`}
                            role="status"
                        >
                            {status}
                        </p>
                    ) : null}

                    {outputFileName ? (
                        <p className="output-file">
                            Output file: <strong>{outputFileName}</strong>
                        </p>
                    ) : null}

                    {progress ? (
                        <div className="progress-block">
                            <div className="progress-meta">
                                <strong>
                                    {formatPercent(
                                        progress.bytesRead,
                                        selectedFileSize,
                                    )}
                                </strong>
                                <span>
                                    {formatBytes(progress.bytesRead)} of{' '}
                                    {formatBytes(selectedFileSize)}
                                </span>
                            </div>
                            <div
                                aria-valuemax={100}
                                aria-valuemin={0}
                                aria-valuenow={getProgressPercent(
                                    progress.bytesRead,
                                    selectedFileSize,
                                )}
                                className="progress-line"
                                role="progressbar"
                            >
                                <span
                                    style={{
                                        width: formatPercent(
                                            progress.bytesRead,
                                            selectedFileSize,
                                        ),
                                    }}
                                />
                            </div>
                            <div className="progress-panel">
                                <span>
                                    Converted{' '}
                                    {progress.statementsConverted.toLocaleString()}{' '}
                                    statements
                                </span>
                                <span>{progress.warnings} warnings</span>
                            </div>
                        </div>
                    ) : null}
                </form>
            </section>

            <section
                aria-label="SQL Converter details"
                className="content-grid"
            >
                <article>
                    <h2>What gets converted?</h2>
                    <p>
                        SQL Converter rewrites common MariaDB and MySQL dump
                        syntax for SQLite: data types, quoted identifiers,
                        auto-increment primary keys, indexes, foreign keys, JSON
                        checks, dump directives, and escaped insert values.
                    </p>
                </article>

                <article>
                    <h2>Large file friendly</h2>
                    <p>
                        The converter streams input and output instead of
                        loading the whole file into a textarea. That keeps
                        memory use practical for large database exports.
                    </p>
                </article>

                <article>
                    <h2>Private by design</h2>
                    <p>
                        Conversion runs locally in the browser. Your database
                        dump is read from disk and written back to disk without
                        being uploaded to a server.
                    </p>
                </article>
            </section>

            <section aria-labelledby="sample-title" className="sample-section">
                <div className="sample-heading">
                    <p className="card-kicker">Example conversion</p>
                    <h2 id="sample-title">MariaDB dump SQL into SQLite SQL</h2>
                    <p>
                        The converter keeps your data and rewrites common dump
                        syntax so SQLite can import it.
                    </p>
                </div>

                <div className="sample-grid">
                    <article>
                        <h3>MariaDB / MySQL input</h3>
                        <pre>
                            <code>{`CREATE TABLE \`users\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`users\` VALUES
(1,'O\\'Connor');`}</code>
                        </pre>
                    </article>

                    <article>
                        <h3>SQLite output</h3>
                        <pre>
                            <code>{`CREATE TABLE "users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" TEXT NOT NULL
);

INSERT INTO "users" VALUES
(1,'O''Connor');`}</code>
                        </pre>
                    </article>
                </div>
            </section>

            {warnings.length > 0 ? (
                <section
                    aria-labelledby="warnings-title"
                    className="warnings-panel"
                >
                    <details open>
                        <summary id="warnings-title">
                            {warnings.length} skipped or adjusted
                            MariaDB-specific statements
                        </summary>
                        <ul>
                            {warnings.slice(0, 100).map(warning => (
                                <li
                                    key={`${warning.reason}-${warning.statement}`}
                                >
                                    {warning.reason}{' '}
                                    <code>{warning.statement}</code>
                                </li>
                            ))}
                        </ul>
                        {warnings.length > 100 ? (
                            <p>Showing first 100 warnings only.</p>
                        ) : null}
                    </details>
                </section>
            ) : null}

            <footer className="site-footer">
                <div>
                    <strong>SQL Converter v{__APP_VERSION__}</strong>
                    <p>
                        A browser-side MariaDB/MySQL dump to SQLite SQL
                        converter. Files are processed locally and are not
                        uploaded.
                    </p>
                </div>

                <nav aria-label="Footer links">
                    <a
                        href="https://github.com/dominosaurs/sql-converter"
                        rel="noreferrer"
                        target="_blank"
                    >
                        GitHub
                    </a>
                    <a
                        href="https://github.com/dominosaurs/sql-converter/issues"
                        rel="noreferrer"
                        target="_blank"
                    >
                        Issues
                    </a>
                </nav>
            </footer>
        </main>
    )
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function getProgressPercent(bytesRead: number, totalBytes: number): number {
    if (totalBytes <= 0) return 0
    return Math.min(100, Math.round((bytesRead / totalBytes) * 100))
}

function formatPercent(bytesRead: number, totalBytes: number): string {
    return `${getProgressPercent(bytesRead, totalBytes)}%`
}
