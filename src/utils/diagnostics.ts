export const MAX_TOOL_DIAGNOSTICS = 36;

export type DiagnosticSummary = {
    errors: string[];
    error_count: number;
    omitted_errors: number;
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
    let errorCount = 0;

    const report: DiagnosticReporter = (error, context) => {
        const message = context ? `${context}: ${errorMessage(error)}` : errorMessage(error);
        errorCount += 1;
        if (errors.length < limit) errors.push(message);
        write(`[schematic assembly] ${message}`);
    };

    const summary = (): DiagnosticSummary => ({
        errors: [...errors],
        error_count: errorCount,
        omitted_errors: Math.max(0, errorCount - errors.length),
    });

    return { report, summary };
}

export function diagnosticToolResult(summary: DiagnosticSummary) {
    if (!summary.error_count) return 'ok';
    return {
        status: 'ok',
        errors: summary.errors,
        ...(summary.omitted_errors ? { omitted_errors: summary.omitted_errors } : {}),
    };
}
