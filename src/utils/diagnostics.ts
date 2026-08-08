export const MAX_TOOL_DIAGNOSTICS = 36;

export type DiagnosticSummary = {
    errors: string[];
    error_count: number;
    omitted_errors: number;
    warnings: string[];
    warning_count: number;
    omitted_warnings: number;
};

export type DiagnosticReporter = (error: unknown, context?: string) => void;

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function errorWithDiagnostics(error: unknown, summary: DiagnosticSummary) {
    if (!summary.error_count) return error instanceof Error ? error : new Error(errorMessage(error));
    const messages = [errorMessage(error), ...summary.errors]
        .filter((message, index, values) => values.indexOf(message) === index)
        .slice(0, MAX_TOOL_DIAGNOSTICS);
    const omitted = Math.max(0, summary.error_count + 1 - messages.length);
    return new Error([
        ...messages,
        ...(omitted ? [`${omitted} more error(s) omitted`] : []),
    ].join('\n'));
}

export function createDiagnosticCollector(
    limit = MAX_TOOL_DIAGNOSTICS,
    write: (message: string) => void = (message) => console.error(message),
) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let errorCount = 0;
    let warningCount = 0;

    const report: DiagnosticReporter = (error, context) => {
        const message = context ? `${context}: ${errorMessage(error)}` : errorMessage(error);
        errorCount += 1;
        if (errors.length < limit) errors.push(message);
        write(`[schematic assembly] ${message}`);
    };

    const warn: DiagnosticReporter = (warning, context) => {
        const message = context ? `${context}: ${errorMessage(warning)}` : errorMessage(warning);
        warningCount += 1;
        if (warnings.length < limit) warnings.push(message);
        write(`[schematic assembly warning] ${message}`);
    };

    const summary = (): DiagnosticSummary => ({
        errors: [...errors],
        error_count: errorCount,
        omitted_errors: Math.max(0, errorCount - errors.length),
        warnings: [...warnings],
        warning_count: warningCount,
        omitted_warnings: Math.max(0, warningCount - warnings.length),
    });

    return { report, warn, summary };
}

export function diagnosticToolResult(summary: DiagnosticSummary) {
    if (!summary.error_count && !summary.warning_count) return 'ok';
    return {
        status: 'ok',
        ...(summary.errors.length ? { errors: summary.errors } : {}),
        ...(summary.warnings.length ? { warnings: summary.warnings } : {}),
        ...(summary.omitted_errors ? { omitted_errors: summary.omitted_errors } : {}),
        ...(summary.omitted_warnings ? { omitted_warnings: summary.omitted_warnings } : {}),
    };
}
