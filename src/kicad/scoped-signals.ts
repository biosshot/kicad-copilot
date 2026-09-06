export const HIERARCHICAL_DIRECTIONS = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const;
export type HierarchicalDirection = typeof HIERARCHICAL_DIRECTIONS[number];
export type SignalReference = { kind: 'global' | 'local' | 'hier'; name: string; sheet?: string; direction?: HierarchicalDirection }
    | { kind: 'empty'; name: '' } | { kind: 'nc'; name: '' };

export function parseSignal(value: string): SignalReference {
    if (!value) return { kind: 'empty', name: '' };
    if (value === 'NC') return { kind: 'nc', name: '' };
    const match = /^(local|global|hier(?:_([a-z_]+))?):/.exec(value);
    if (!match) return { kind: 'global', name: value };
    const direction = match[2] as HierarchicalDirection | undefined;
    if (direction && !HIERARCHICAL_DIRECTIONS.includes(direction)) throw new Error(`invalid hierarchical direction: ${direction}`);
    const kind = match[1].startsWith('hier') ? 'hier' : match[1] as 'local' | 'global';
    const rest = value.slice(match[0].length);
    if (kind === 'global') {
        if (!rest) throw new Error('global signal name must not be empty');
        return { kind, name: rest };
    }
    const separator = rest.indexOf(':');
    if (separator <= 0 || separator === rest.length - 1) throw new Error(`invalid scoped signal: ${value}`);
    return { kind, sheet: rest.slice(0, separator), name: rest.slice(separator + 1), ...(direction ? { direction } : {}) };
}
export function globalSignal(name: string) {
    return name.toUpperCase() === 'NC' || /^(local|global|hier(?:_[a-z_]+)?):/.test(name) ? `global:${name}` : name;
}
