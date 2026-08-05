export type SExpressionRange = {
    start: number;
    end: number;
    text: string;
};

function skipString(source: string, start: number) {
    let escaped = false;

    for (let index = start + 1; index < source.length; index += 1) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') return index + 1;
    }

    throw new Error('unterminated string in KiCad S-expression');
}

function matchingClose(source: string, start: number) {
    let depth = 0;

    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (char === '"') {
            index = skipString(source, index) - 1;
            continue;
        }
        if (char === '(') depth += 1;
        if (char !== ')') continue;

        depth -= 1;
        if (depth === 0) return index + 1;
    }

    throw new Error('unbalanced KiCad S-expression');
}

function listHead(source: string, start: number) {
    let index = start + 1;
    while (/\s/.test(source[index] || '')) index += 1;
    const headStart = index;
    while (index < source.length && !/[\s()]/.test(source[index])) index += 1;
    return source.slice(headStart, index);
}

export function findLists(source: string, head: string) {
    const ranges: SExpressionRange[] = [];

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '"') {
            index = skipString(source, index) - 1;
            continue;
        }
        if (char !== '(' || listHead(source, index) !== head) continue;

        const end = matchingClose(source, index);
        ranges.push({ start: index, end, text: source.slice(index, end) });
        index = end - 1;
    }

    return ranges;
}

function decodeString(value: string) {
    return value.replace(/\\([\\"])/g, '$1');
}

export function findQuotedProperty(source: string, propertyName: string) {
    const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\(property\\s+"${escapedName}"\\s+"((?:\\\\.|[^"\\\\])*)"`);
    const match = source.match(pattern);
    return match ? decodeString(match[1]) : undefined;
}

export function quoteSExpression(value: string) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
