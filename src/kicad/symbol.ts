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

export type LibraryPropertyPosition = {
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

export function librarySymbolPropertyPositions(symbol: SExpression[]) {
    const positions = new Map<string, LibraryPropertyPosition>();
    for (const item of symbol) {
        if (!isSExpressionList(item) || listHead(item) !== 'property') continue;
        const name = atom(item[1]);
        const at = findChild(item, 'at');
        const x = Number(atom(at?.[1]));
        const y = Number(atom(at?.[2]));
        const angle = Number(atom(at?.[3]) || 0);
        if (!name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) continue;
        positions.set(name, { x, y, angle });
    }
    return positions;
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

const PASSIVE_PREFIXES = new Set([
    'R', 'C', 'L', 'FB', 'D', 'LED', 'F', 'J', 'P', 'SW', 'S', 'X', 'Y', 'Q', 'T', 'K', 'RV',
]);

function designatorPrefix(designator: string) {
    return designator.trim().match(/^[A-Za-z]+/)?.[0].toUpperCase() || '';
}

function inferredPinType(designator: string, name: string, current: string) {
    if (PASSIVE_PREFIXES.has(designatorPrefix(designator))) return 'passive';
    if (current && current !== 'unspecified') return current;

    const normalized = name.toUpperCase().replace(/[~\s]/g, '');
    if (/^(GND|AGND|DGND|PGND|VSS|VEE|VCC|VDD|AVCC|AVDD|DVCC|DVDD|VBAT|VREF[+-]?)$/.test(normalized)) {
        return 'power_in';
    }
    if (/^(OUT|OUT[A-Z0-9]*|DOUT|SOUT|TX|TXD|MISO|Q[0-9A-Z]*|DISCH|PWM[0-9A-Z]*)$/.test(normalized)) {
        return 'output';
    }
    if (/^([+-]?IN|[+-]?IN[A-Z0-9]*|AIN[0-9A-Z]*|TRIG|THRES|THR|CONT|CTRL|RST|RESET|EN|ENABLE|CLK|CS|SCK|MOSI|RX|RXD)$/.test(normalized)) {
        return 'input';
    }
    if (/^(IO|I\/O|GPIO|SDA|SCL)[0-9A-Z_]*$/.test(normalized)) return 'bidirectional';
    return 'passive';
}

export function normalizedComponentSymbol(
    sourceInput: SExpression[],
    designator: string,
    footprintLibrary = 'kicad-copilot',
    footprintPrefix = '',
) {
    const source = structuredClone(sourceInput) as SExpression[];
    visitSExpression(source, (item) => {
        if (listHead(item) !== 'pin') return;
        const name = atom(findChild(item, 'name')?.[1]) || '';
        item[1] = token(inferredPinType(designator, name, atom(item[1]) || ''));
    });
    for (const item of source) {
        if (!isSExpressionList(item) || listHead(item) !== 'property') continue;
        if (atom(item[1]) !== 'Footprint') continue;
        const footprint = atom(item[2]) || '';
        const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint;
        if (name) item[2] = token(`${footprintLibrary}:${footprintPrefix}${name}`, true);
    }
    return source;
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
        propertyPositions: librarySymbolPropertyPositions(source),
    };
}
