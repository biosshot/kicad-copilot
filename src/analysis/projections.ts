import { basename } from 'node:path';

export type JsonRecord = Record<string, unknown>;

export type SchematicAnalysisOptions = {
    findings?: boolean;
    overview?: boolean;
    hierarchy?: boolean;
    blocks?: boolean;
    connectivity?: boolean;
    power?: boolean;
    buses?: boolean;
    bom?: boolean;
    assembly?: boolean;
    verification?: boolean;
    all?: boolean;
};

export type PcbAnalysisOptions = {
    schematic?: string;
    findings?: boolean;
    overview?: boolean;
    placement?: boolean;
    routing?: boolean;
    connectivity?: boolean;
    power?: boolean;
    buses?: boolean;
    assembly?: boolean;
    dfm?: boolean;
    cross?: boolean;
    thermal?: boolean;
    emc?: boolean;
    proximity?: boolean;
    all?: boolean;
};

export function asRecord(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : undefined;
}

function array(value: unknown) {
    return Array.isArray(value) ? value : [];
}

function value(record: JsonRecord | undefined, key: string) {
    return record?.[key];
}

function selected(options: { all?: boolean }, key: string) {
    return options.all === true || options[key as keyof typeof options] === true;
}

const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 7;

function isEmpty(value: unknown) {
    return value === undefined
        || value === null
        || (typeof value === 'string' && value.trim() === '')
        || (Array.isArray(value) && value.length === 0)
        || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

/** Keep optional report sections useful to an LLM without returning raw track/net dumps. */
function bounded(input: unknown, depth = 0): unknown {
    if (input === null || input === undefined) return undefined;
    if (typeof input === 'string') return input.trim() || undefined;
    if (typeof input !== 'object') return input;
    if (depth >= MAX_DEPTH) return '[nested details omitted]';
    if (Array.isArray(input)) {
        const items = input.slice(0, MAX_ARRAY_ITEMS)
            .map(item => bounded(item, depth + 1))
            .filter(item => !isEmpty(item));
        if (!items.length) return undefined;
        return input.length > MAX_ARRAY_ITEMS
            ? { count: input.length, items, truncated: input.length - MAX_ARRAY_ITEMS }
            : items;
    }

    const source = input as JsonRecord;
    const entries = Object.entries(source);
    const output: JsonRecord = {};
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
        // Coordinate-level copper is available through report, never inline.
        if ((key === 'segments' || key === 'arcs' || key === 'vias') && Array.isArray(item)) {
            if (item.length) output[`${key}_count`] = item.length;
            continue;
        }
        const compacted = bounded(item, depth + 1);
        if (!isEmpty(compacted)) output[key] = compacted;
    }
    if (entries.length > MAX_OBJECT_KEYS) output.truncated_keys = entries.length - MAX_OBJECT_KEYS;
    return Object.keys(output).length ? output : undefined;
}

function pick(record: JsonRecord, keys: string[]) {
    const output: JsonRecord = {};
    for (const key of keys) {
        if (record[key] !== undefined) output[key] = bounded(record[key]);
    }
    return output;
}

function findingFacts(raw: JsonRecord | undefined, predicate: (finding: JsonRecord) => boolean) {
    return array(raw?.findings)
        .map(asRecord)
        .filter((finding): finding is JsonRecord => finding !== undefined && predicate(finding))
        .slice(0, MAX_ARRAY_ITEMS)
        .map((finding) => ({
            severity: finding.severity,
            message: finding.summary || finding.title || finding.description,
            components: bounded(finding.components),
            nets: bounded(finding.nets),
        }));
}

function compactIcPinAnalysis(raw: unknown) {
    return array(raw)
        .map(asRecord)
        .filter((item): item is JsonRecord => item !== undefined && /^U\d/i.test(String(item.reference || '')))
        .map((item) => {
            const pins = array(item.power_pins).map(asRecord).filter((pin): pin is JsonRecord => pin !== undefined);
            const grouped = new Map<string, JsonRecord[]>();
            for (const pin of pins) {
                const net = String(pin.net || 'unnamed');
                grouped.set(net, [...(grouped.get(net) || []), pin]);
            }
            return {
                reference: item.reference,
                function: item.function,
                total_pins: item.total_pins,
                unconnected_pins: Array.isArray(item.unconnected_pins)
                    ? item.unconnected_pins.length
                    : item.unconnected_pins,
                power_rails: Object.fromEntries([...grouped].map(([net, railPins]) => [
                    net,
                    railPins.map(pin => `${pin.pin_number}:${pin.pin_name}`),
                ])),
                undecoupled_power_pins: pins
                    .filter(pin => pin.has_decoupling_cap !== true)
                    .map(pin => `${pin.pin_number}:${pin.pin_name}@${pin.net}`),
            };
        });
}

function compactSubcircuits(raw: unknown) {
    return array(raw).map(asRecord).filter((item): item is JsonRecord => item !== undefined).map(item => ({
        center_ic: item.center_ic,
        ic_mpn: item.ic_mpn,
        neighbor_components: array(item.neighbor_components)
            .map(asRecord)
            .filter((neighbor): neighbor is JsonRecord => neighbor !== undefined)
            .map(neighbor => ({ ref: neighbor.ref, value: neighbor.value })),
        description: item.description,
    }));
}

function compactPowerDomains(raw: unknown) {
    return value(asRecord(raw), 'domain_groups');
}

function compactGroundDomains(raw: unknown) {
    const ground = asRecord(raw);
    const nets = asRecord(ground?.ground_nets);
    const entries = Object.entries(nets || {});
    if (ground?.multiple_domains !== true && entries.length <= 1) return undefined;
    return {
        nets: nets ? Object.fromEntries(entries.map(([name, rawNet]) => {
            const net = asRecord(rawNet);
            return [name, { domain: net?.domain, connections: net?.connections }];
        })) : undefined,
        multiple_domains: ground?.multiple_domains,
    };
}

function compactPowerBudget(raw: unknown) {
    const rails = asRecord(asRecord(raw)?.rails);
    if (!rails) return undefined;
    return Object.fromEntries(Object.entries(rails).map(([name, rawRail]) => {
        const rail = asRecord(rawRail);
        const regulator = asRecord(rail?.regulator);
        const loads = array(rail?.ics).map(asRecord).filter(Boolean).map(load => ({
            ref: load?.ref,
            estimated_mA: load?.estimated_mA,
        }));
        return [name, {
            estimated_load_mA: rail?.estimated_load_mA,
            loads: loads.length > 1 ? loads : undefined,
            regulator: regulator ? {
                ref: regulator.ref,
                topology: regulator.topology,
            } : undefined,
        }];
    }));
}

function compactSleepCurrent(raw: unknown) {
    const sleep = asRecord(raw);
    const rails = asRecord(sleep?.rails);
    return {
        rails: rails ? Object.fromEntries(Object.entries(rails).map(([name, rawRail]) => {
            const rail = asRecord(rawRail);
            return [name, {
                always_on_uA: rail?.always_on_uA,
                conditional_uA: rail?.conditional_uA,
                realistic_uA: rail?.realistic_uA,
                paths: array(rail?.current_paths).map(asRecord).filter(Boolean).map(path => ({
                    ref: path?.ref,
                    type: path?.type,
                    current_uA: path?.current_uA,
                    has_enable_pin: path?.has_enable_pin,
                    likely_state: path?.likely_state,
                    realistic_uA: path?.realistic_uA,
                })),
            }];
        })) : undefined,
        realistic_total_uA: sleep?.realistic_total_uA,
    };
}

function compactInrush(raw: unknown) {
    return array(asRecord(raw)?.rails).map(asRecord).filter(Boolean).map(rail => ({
        regulator: rail?.regulator,
        output_rail: rail?.output_rail,
        total_output_capacitance_uF: rail?.total_output_capacitance_uF,
        estimated_inrush_A: rail?.estimated_inrush_A,
        assumed_soft_start_ms: rail?.assumed_soft_start_ms,
    }));
}

function compactBom(raw: unknown) {
    return array(raw).map(asRecord).filter((item): item is JsonRecord => item !== undefined).map(item => ({
        value: item.value === item.mpn ? undefined : item.value,
        footprint: typeof item.footprint === 'string' ? item.footprint.split(':').at(-1) : item.footprint,
        mpn: item.mpn,
        manufacturer: item.manufacturer,
        digikey: item.digikey,
        mouser: item.mouser,
        lcsc: item.lcsc,
        element14: item.element14,
        references: item.references,
        dnp: item.dnp === true ? true : undefined,
    }));
}

function compactSourcing(raw: unknown) {
    const sourcing = asRecord(raw);
    return {
        total_components: sourcing?.total_bom_components,
        mpn_coverage: sourcing?.mpn_coverage,
        mpn_percent: sourcing?.mpn_percent,
    };
}

function compactCrossDomainSignals(raw: unknown) {
    const groups = new Map<string, { nets: string[]; ics: unknown; power_domains: unknown; needs_level_shifter: unknown }>();
    for (const rawSignal of array(raw)) {
        const signal = asRecord(rawSignal);
        if (!signal) continue;
        const key = JSON.stringify([signal.ics, signal.power_domains, signal.needs_level_shifter]);
        const existing = groups.get(key);
        if (existing) existing.nets.push(String(signal.net));
        else groups.set(key, {
            nets: [String(signal.net)],
            ics: signal.ics,
            power_domains: signal.power_domains,
            needs_level_shifter: signal.needs_level_shifter,
        });
    }
    return [...groups.values()];
}

function compactTrust(raw: unknown) {
    const trust = asRecord(raw);
    return {
        trust_level: trust?.trust_level,
        findings_by_confidence: trust?.by_confidence,
        provenance_coverage_pct: trust?.provenance_coverage_pct,
    };
}

function compactHierarchySheets(raw: unknown) {
    return array(raw).map(sheet => typeof sheet === 'string' ? basename(sheet) : sheet);
}

function compactPdnImpedance(raw: unknown) {
    const pdn = asRecord(raw);
    if (!pdn) return undefined;
    const railEntries = Object.entries(asRecord(pdn.rails) || {});
    const rails: JsonRecord = {};

    for (const [name, railValue] of railEntries.slice(0, MAX_ARRAY_ITEMS)) {
        const rail = asRecord(railValue);
        if (!rail) continue;
        rails[name] = {
            cap_count: rail.cap_count ?? array(rail.capacitors).length,
            total_capacitance_uF: rail.total_capacitance_uF,
            min_impedance: bounded(rail.min_impedance),
            anti_resonances: array(rail.anti_resonances).map(asRecord).filter(Boolean).map(item => ({
                frequency: item?.freq_formatted,
                impedance_ohm: item?.impedance_ohm,
            })),
        };
    }

    return {
        rails,
        observations: bounded(pdn.observations),
        ...(railEntries.length > MAX_ARRAY_ITEMS
            ? { truncated_rails: railEntries.length - MAX_ARRAY_ITEMS }
            : {}),
    };
}

function compactConnectivityGraph(raw: unknown) {
    const graph = asRecord(raw);
    if (!graph) return undefined;
    const entries = Object.entries(graph);
    const nets = entries.slice(0, MAX_ARRAY_ITEMS).map(([net, item]) => {
        const detail = asRecord(item);
        return {
            net,
            islands: detail?.islands,
            gaps: bounded(detail?.gaps),
            disconnected_pads: bounded(detail?.disconnected_pads),
        };
    });
    return {
        net_count: entries.length,
        nets,
        ...(entries.length > MAX_ARRAY_ITEMS ? { truncated: entries.length - MAX_ARRAY_ITEMS } : {}),
    };
}

export function projectSchematic(raw: JsonRecord, options: SchematicAnalysisOptions) {
    const output: JsonRecord = {};
    const statistics = asRecord(raw.statistics);
    const design = asRecord(raw.design_analysis);

    if (selected(options, 'overview')) {
        output.overview = bounded({
            sheets: array(raw.sheets).length,
            components: value(statistics, 'total_components'),
            unique_parts: value(statistics, 'unique_parts'),
            dnp_parts: value(statistics, 'dnp_parts'),
            nets: value(statistics, 'total_nets'),
            wires: value(statistics, 'total_wires'),
            no_connects: value(statistics, 'total_no_connects'),
            kicad_version: raw.kicad_version,
            file_version: raw.file_version,
            title_block: raw.title_block,
        });
    }

    if (selected(options, 'hierarchy')) {
        output.hierarchy = bounded(pick(raw, [
            'hierarchical_labels', 'hierarchy_context', 'hierarchy_warning',
        ]));
        const hierarchy = asRecord(output.hierarchy);
        if (hierarchy) hierarchy.sheets = bounded(compactHierarchySheets(raw.sheets));
    }

    if (selected(options, 'blocks')) {
        const detections = findingFacts(raw, finding => {
            const detector = String(finding.detector || '');
            const rule = String(finding.rule_id || '');
            const message = String(finding.summary || finding.title || '');
            return (detector.startsWith('detect_') || rule.endsWith('-DET'))
                && !detector.includes('decoupl')
                && !message.toLowerCase().startsWith('decoupling');
        });
        output.blocks = bounded({
            subcircuits: compactSubcircuits(raw.subcircuits),
            detections,
            ic_pin_analysis: compactIcPinAnalysis(raw.ic_pin_analysis),
            transistor_pin_analysis: compactIcPinAnalysis(raw.transistor_pin_analysis),
        });
    }

    if (selected(options, 'connectivity')) {
        const issues = asRecord(raw.connectivity_issues);
        output.connectivity = bounded({
            issues: {
                unconnected_pins: issues?.unconnected_pins,
                single_pin_nets: issues?.single_pin_nets,
                multi_driver_nets: issues?.multi_driver_nets,
            },
            labels: Array.isArray(raw.labels) ? { count: raw.labels.length } : undefined,
            no_connects: raw.no_connects,
            annotation_issues: raw.annotation_issues,
            label_shape_warnings: raw.label_shape_warnings,
            pwr_flag_warnings: raw.pwr_flag_warnings,
        });
    }

    if (selected(options, 'power')) {
        output.power = bounded({
            rails: raw.rail_voltages,
            domains: compactPowerDomains(value(design, 'power_domains')),
            ground_domains: compactGroundDomains(raw.ground_domains),
            sequencing: value(asRecord(raw.power_sequencing_validation), 'power_tree'),
            budget: compactPowerBudget(raw.power_budget),
            sleep_current: compactSleepCurrent(raw.sleep_current_audit),
            // Raw impedance profiles contain dozens of samples per rail. The
            // extrema and anti-resonances are the actionable part for an LLM.
            pdn_impedance: compactPdnImpedance(raw.pdn_impedance),
            inrush: compactInrush(raw.inrush_analysis),
        });
    }

    if (selected(options, 'buses')) {
        output.buses = bounded({
            topology: raw.bus_topology,
            analysis: value(design, 'bus_analysis'),
            differential_pairs: value(design, 'differential_pairs'),
            cross_domain_signals: compactCrossDomainSignals(value(design, 'cross_domain_signals')),
            net_classifications: raw.net_classifications,
        });
    }

    if (selected(options, 'bom')) {
        output.bom = bounded({
            component_groups: compactBom(raw.bom),
            sourcing: compactSourcing(raw.sourcing_audit),
            optimization: raw.bom_optimization,
            missing_mpn: value(statistics, 'missing_mpn'),
            missing_footprint: value(statistics, 'missing_footprint'),
        });
    }

    if (selected(options, 'assembly')) output.assembly = bounded(raw.assembly_complexity || {});

    if (selected(options, 'verification')) {
        output.verification = bounded({
            test_coverage: raw.test_coverage,
            usb_compliance: raw.usb_compliance,
            erc_warnings: value(design, 'erc_warnings'),
            trust: compactTrust(raw.trust_summary),
        });
    }

    return output;
}

export type PcbRelatedReports = {
    schematic?: JsonRecord;
    cross?: JsonRecord;
    thermal?: JsonRecord;
    emc?: JsonRecord;
};

export function projectPcb(raw: JsonRecord, related: PcbRelatedReports, options: PcbAnalysisOptions) {
    const output: JsonRecord = {};
    const statistics = asRecord(raw.statistics);
    const schematicDesign = asRecord(related.schematic?.design_analysis);

    if (selected(options, 'overview')) {
        output.overview = bounded({
            footprints: value(statistics, 'footprint_count'),
            front_side: value(statistics, 'front_side'),
            back_side: value(statistics, 'back_side'),
            smd: value(statistics, 'smd_count'),
            tht: value(statistics, 'tht_count'),
            copper_layers: value(statistics, 'copper_layer_names'),
            tracks: value(statistics, 'track_segments'),
            vias: value(statistics, 'via_count'),
            zones: value(statistics, 'zone_count'),
            board_width_mm: value(statistics, 'board_width_mm'),
            board_height_mm: value(statistics, 'board_height_mm'),
            board_area_mm2: value(statistics, 'board_area_mm2'),
            routing_complete: value(statistics, 'routing_complete'),
            unrouted_nets: value(statistics, 'unrouted_net_count'),
        });
    }

    if (selected(options, 'placement')) {
        output.placement = bounded({
            density: raw.placement_density,
            component_groups: raw.component_groups,
            decoupling: raw.decoupling_placement,
            issues: findingFacts(raw, finding => {
                const detector = String(finding.detector || '');
                return detector === 'analyze_placement' || detector.includes('keepout');
            }),
        });
    }

    if (selected(options, 'routing')) {
        output.routing = bounded({
            complete: value(statistics, 'routing_complete'),
            unrouted_nets: value(statistics, 'unrouted_net_count'),
            total_track_length_mm: value(statistics, 'total_track_length_mm'),
            tracks: raw.tracks,
            vias: raw.vias,
            net_lengths: raw.net_lengths,
            layer_transitions: raw.layer_transitions,
            proximity: raw.trace_proximity,
        });
    }

    if (selected(options, 'connectivity')) {
        output.connectivity = bounded({
            summary: raw.connectivity,
            graph: compactConnectivityGraph(raw.connectivity_graph),
            copper_presence: raw.copper_presence_summary,
            ground_domains: raw.ground_domains,
        });
    }

    if (selected(options, 'power')) {
        output.power = bounded({
            routing: raw.power_net_routing,
            ground_domains: raw.ground_domains,
            decoupling: raw.decoupling_proximity,
            switching_loops: raw.switching_loop_areas,
            thermal_pads: raw.thermal_pad_scan,
            findings: findingFacts(raw, finding => {
                const category = String(finding.category || '');
                return category.includes('power') || category.includes('current')
                    || String(finding.detector || '').includes('thermal_pad');
            }),
        });
    }

    if (selected(options, 'buses')) {
        output.buses = bounded({
            schematic: {
                analysis: value(schematicDesign, 'bus_analysis'),
                differential_pairs: value(schematicDesign, 'differential_pairs'),
            },
            net_lengths: raw.net_lengths,
            cross_findings: findingFacts(related.cross, finding => {
                const category = String(finding.category || '');
                return category.includes('signal') || category.includes('differential')
                    || category.includes('return_path');
            }),
        });
    }

    if (selected(options, 'assembly')) {
        output.assembly = bounded({
            schematic_complexity: related.schematic?.assembly_complexity,
            counts: {
                smd: value(statistics, 'smd_count'),
                tht: value(statistics, 'tht_count'),
                front_side: value(statistics, 'front_side'),
                back_side: value(statistics, 'back_side'),
            },
            density: raw.placement_density,
            silkscreen: raw.silkscreen,
            issues: findingFacts(raw, finding => {
                const detector = String(finding.detector || '');
                const category = String(finding.category || '');
                return category === 'assembly' || [
                    'analyze_fiducials', 'analyze_orientation_consistency',
                    'analyze_test_point_coverage', 'analyze_silkscreen_pad_overlaps',
                    'analyze_tombstoning_risk', 'analyze_via_in_pad',
                ].includes(detector);
            }),
        });
    }

    if (selected(options, 'dfm')) {
        const projectSettings = asRecord(raw.project_settings);
        output.dfm = bounded({
            summary: raw.dfm_summary,
            design_rule_compliance: raw.design_rule_compliance,
            project_settings: projectSettings ? {
                source: projectSettings.source,
                design_rules: projectSettings.design_rules,
                net_classes: projectSettings.net_classes,
                custom_rules: projectSettings.custom_rules,
            } : undefined,
            issues: findingFacts(raw, finding => {
                const category = String(finding.category || '');
                return category === 'dfm' || category.includes('manufactur');
            }),
        });
    }

    if (selected(options, 'cross') && related.cross) {
        output.cross = bounded({
            summary: related.cross.summary,
            findings: findingFacts(related.cross, () => true),
            trust: related.cross.trust_summary,
        });
    }
    if (selected(options, 'thermal') && related.thermal) {
        output.thermal = bounded({
            summary: related.thermal.summary,
            assessments: related.thermal.thermal_assessments || related.thermal.assessments,
            findings: findingFacts(related.thermal, () => true),
            trust: related.thermal.trust_summary,
        });
    }
    if (selected(options, 'emc') && related.emc) {
        output.emc = bounded({
            summary: related.emc.summary,
            category_summary: related.emc.category_summary,
            per_net_scores: related.emc.per_net_scores,
            test_plan: related.emc.test_plan,
            regulatory_coverage: related.emc.regulatory_coverage,
            board_info: related.emc.board_info,
            findings: findingFacts(related.emc, () => true),
            trust: related.emc.trust_summary,
        });
    }

    return output;
}
