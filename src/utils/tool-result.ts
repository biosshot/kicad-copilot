export function textResult(value: unknown) {
    return {
        content: [{
            type: 'text' as const,
            text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
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
