export type SExpressionToken = {
    value: string;
    quoted: boolean;
};

export type SExpression = SExpressionToken | SExpression[];

export function token(value: string, quoted = false): SExpressionToken {
    return { value, quoted };
}

export function isSExpressionList(value: SExpression | undefined): value is SExpression[] {
    return Array.isArray(value);
}

export function atom(value: SExpression | undefined) {
    return value && !isSExpressionList(value) ? value.value : undefined;
}

export function listHead(value: SExpression | undefined) {
    return isSExpressionList(value) ? atom(value[0]) : undefined;
}

export function findChild(value: SExpression[], head: string) {
    return value.find((item) => isSExpressionList(item) && listHead(item) === head) as SExpression[] | undefined;
}

function tokenize(source: string) {
    const output: Array<SExpressionToken | '(' | ')'> = [];

    for (let index = 0; index < source.length;) {
        const char = source[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (char === ';') {
            while (index < source.length && source[index] !== '\n') index += 1;
            continue;
        }
        if (char === '(' || char === ')') {
            output.push(char);
            index += 1;
            continue;
        }
        if (char === '"') {
            let value = '';
            index += 1;
            while (index < source.length && source[index] !== '"') {
                if (source[index] === '\\' && index + 1 < source.length) {
                    const escaped = source[index + 1];
                    value += escaped === 'n' ? '\n' : escaped;
                    index += 2;
                } else {
                    value += source[index];
                    index += 1;
                }
            }
            if (source[index] !== '"') throw new Error('unterminated S-expression string');
            output.push(token(value, true));
            index += 1;
            continue;
        }

        let end = index;
        while (end < source.length && !/[\s()]/.test(source[end])) end += 1;
        output.push(token(source.slice(index, end)));
        index = end;
    }

    return output;
}

export function parseSExpression(source: string) {
    const tokens = tokenize(source);
    let cursor = 0;

    const parseOne = (): SExpression => {
        const current = tokens[cursor];
        cursor += 1;
        if (current !== '(') {
            if (current === ')' || current === undefined) throw new Error('unexpected S-expression token');
            return current;
        }

        const list: SExpression[] = [];
        while (tokens[cursor] !== ')') {
            if (cursor >= tokens.length) throw new Error('unclosed S-expression list');
            list.push(parseOne());
        }
        cursor += 1;
        return list;
    };

    const root = parseOne();
    if (!isSExpressionList(root) || cursor !== tokens.length) {
        throw new Error('invalid S-expression root');
    }
    return root;
}

function quote(value: string) {
    return `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')}"`;
}

export function printSExpression(value: SExpression): string {
    if (!isSExpressionList(value)) return value.quoted ? quote(value.value) : value.value;
    return `(${value.map(printSExpression).join(' ')})`;
}

export function visitSExpression(value: SExpression, visitor: (node: SExpression[]) => void) {
    if (!isSExpressionList(value)) return;
    visitor(value);
    for (const child of value) visitSExpression(child, visitor);
}
