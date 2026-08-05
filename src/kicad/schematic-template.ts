import { basename } from 'node:path';
import { quoteSExpression } from './sexpr/scan';

const FORMAT_VERSION: Record<9 | 10, string> = {
    9: '20250114',
    10: '20260306',
};

type SchematicTemplateOptions = {
    uuid: string;
    major?: 9 | 10;
    version?: string;
    paperForm?: string;
    root?: boolean;
};

export function schematicTemplate(options: SchematicTemplateOptions) {
    const version = options.version || FORMAT_VERSION[options.major!];
    if (!version) throw new Error('unsupported KiCad version');

    const paper = options.paperForm || '(paper "A4")';
    const sheetInstances = options.root === false
        ? ''
        : `\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)`;
    const embeddedFonts = Number(version) >= 20260000 ? '\n\t(embedded_fonts no)' : '';

    return `(kicad_sch
\t(version ${version})
\t(generator "kicad-copilot")
\t(generator_version "0.1.0")
\t(uuid "${options.uuid}")
\t${paper}
\t(lib_symbols)${sheetInstances}${embeddedFonts}
)\n`;
}

export function projectTemplate(projectPath: string, rootSchematicUuid: string) {
    const filename = basename(projectPath);
    const name = basename(projectPath, '.kicad_pro');

    return `${JSON.stringify({
        board: {},
        boards: [],
        cvpcb: { equivalence_files: [] },
        erc: {},
        libraries: {
            pinned_footprint_libs: [],
            pinned_symbol_libs: [],
        },
        meta: {
            filename,
            version: 1,
        },
        net_settings: {
            classes: [],
            meta: { version: 3 },
            net_colors: null,
            netclass_assignments: null,
            netclass_patterns: [],
        },
        pcbnew: {},
        schematic: {
            meta: { version: 1 },
            top_level_sheets: [{
                filename: `${name}.kicad_sch`,
                name,
                uuid: rootSchematicUuid,
            }],
        },
        sheets: [[rootSchematicUuid, '']],
        text_variables: {},
    }, null, 2)}\n`;
}

type SheetSymbolOptions = {
    name: string;
    sheetFile: string;
    uuid: string;
    projectName: string;
    rootUuid: string;
    page: number;
    x: number;
    y: number;
};

export function sheetSymbol(options: SheetSymbolOptions) {
    const width = 50.8;
    const height = 25.4;

    return `\t(sheet
\t\t(at ${options.x} ${options.y})
\t\t(size ${width} ${height})
\t\t(exclude_from_sim no)
\t\t(in_bom yes)
\t\t(on_board yes)
\t\t(dnp no)
\t\t(stroke (width 0) (type solid))
\t\t(fill (color 0 0 0 0.0000))
\t\t(uuid ${quoteSExpression(options.uuid)})
\t\t(property "Sheetname" ${quoteSExpression(options.name)}
\t\t\t(at ${options.x} ${options.y - 0.7625} 0)
\t\t\t(effects (font (size 1.27 1.27)) (justify left bottom))
\t\t)
\t\t(property "Sheetfile" ${quoteSExpression(options.sheetFile)}
\t\t\t(at ${options.x} ${options.y + height + 0.7625} 0)
\t\t\t(effects (font (size 1.27 1.27)) (justify left top))
\t\t)
\t\t(instances
\t\t\t(project ${quoteSExpression(options.projectName)}
\t\t\t\t(path ${quoteSExpression(`/${options.rootUuid}`)}
\t\t\t\t\t(page ${quoteSExpression(String(options.page))})
\t\t\t\t)
\t\t\t)
\t\t)
\t)`;
}
