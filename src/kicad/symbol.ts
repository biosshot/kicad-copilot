import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    SExpression,
    token,
    visitSExpression,
} from './sexpr/ast';

export type LibraryPin = {
    number: string;
    name: string;
    x: number;
    y: number;
    angle: number;
};

export function librarySymbolName(symbol: SExpression[]) {
    const name = atom(symbol[1]);
    if (!name) throw new Error('KiCad symbol name not found');
    return name;
}

export function librarySymbolProperties(symbol: SExpression[]) {
    return Object.fromEntries(symbol
        .filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === 'property')
        .map((item) => [atom(item[1]) || '', atom(item[2]) || '']));
}

export function librarySymbolPins(symbol: SExpression[]) {
    const pins: LibraryPin[] = [];
    visitSExpression(symbol, (item) => {
        if (listHead(item) !== 'pin') return;
        const at = findChild(item, 'at');
        const number = findChild(item, 'number');
        const name = findChild(item, 'name');
        if (!at || !number) return;

        const pinNumber = atom(number[1]);
        const x = Number(atom(at[1]));
        const y = Number(atom(at[2]));
        if (!pinNumber || !Number.isFinite(x) || !Number.isFinite(y)) return;
        pins.push({
            number: pinNumber,
            name: atom(name?.[1]) || '',
            x,
            y,
            angle: Number(atom(at[3]) || 0),
        });
    });
    return pins;
}

function normalizedProperty(property: SExpression[]) {
    const output = property.filter(
        (item) => !isSExpressionList(item) || listHead(item) !== 'id',
    );
    const effects = findChild(output, 'effects');
    let hidden = false;
    if (effects) {
        hidden = effects.some((item) => !isSExpressionList(item) && atom(item) === 'hide');
        effects.splice(0, effects.length, ...effects.filter(
            (item) => isSExpressionList(item) || atom(item) !== 'hide',
        ));
    }

    const effectsIndex = output.findIndex(
        (item) => isSExpressionList(item) && listHead(item) === 'effects',
    );
    const insertAt = effectsIndex < 0 ? output.length : Math.max(3, effectsIndex);
    output.splice(insertAt, 0,
        [token('show_name'), token('no')],
        [token('do_not_autoplace'), token('no')],
    );
    if (hidden) output.splice(insertAt + 2, 0, [token('hide'), token('yes')]);
    return output;
}

export function embeddedLibrarySymbol(
    sourceInput: SExpression[],
    libraryName: string,
    targetVersion: number,
) {
    const source = structuredClone(sourceInput) as SExpression[];
    const sourceName = librarySymbolName(source);
    const body = source.slice(2)
        .filter((item) => !isSExpressionList(item)
            || !['exclude_from_sim', 'in_bom', 'on_board', 'in_pos_files', 'duplicate_pin_numbers_are_jumpers', 'embedded_fonts']
                .includes(listHead(item) || ''))
        .map((item) => {
            if (!isSExpressionList(item) || listHead(item) !== 'property') return item;
            const effects = findChild(item, 'effects');
            const oldSyntax = Boolean(findChild(item, 'id'))
                || Boolean(effects?.some((entry) => !isSExpressionList(entry) && atom(entry) === 'hide'));
            return oldSyntax ? normalizedProperty(item) : item;
        });

    const modern = targetVersion >= 20260000;
    const output: SExpression[] = [
        token('symbol'),
        token(`${libraryName}:${sourceName}`, true),
        [token('exclude_from_sim'), token('no')],
        [token('in_bom'), token('yes')],
        [token('on_board'), token('yes')],
        ...(modern ? [
            [token('in_pos_files'), token('yes')],
            [token('duplicate_pin_numbers_are_jumpers'), token('no')],
        ] : []),
        ...body,
        ...(modern ? [[token('embedded_fonts'), token('no')]] : []),
    ];

    return {
        id: `${libraryName}:${sourceName}`,
        sourceName,
        symbol: output,
        pins: librarySymbolPins(source),
        properties: librarySymbolProperties(source),
    };
}
