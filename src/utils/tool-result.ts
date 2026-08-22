export function textResult(value: unknown, compact = false) {
    return {
        content: [{
            type: 'text' as const,
            text: typeof value === 'string' ? value : JSON.stringify(value, null, compact ? undefined : 2),
        }],
    };
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function errorResult(error: unknown) {
    console.error(error);

    return {
        isError: true,
        content: [{
            type: 'text' as const,
            text: errorMessage(error),
        }],
    };
}

export async function runTool(operation: () => Promise<unknown>) {
    try {
        return textResult(await operation());
    } catch (error) {
        return errorResult(error);
    }
}

/** Serialize token-sensitive machine reports without indentation. */
export async function runCompactTool(operation: () => Promise<unknown>) {
    try {
        return textResult(await operation(), true);
    } catch (error) {
        return errorResult(error);
    }
}
