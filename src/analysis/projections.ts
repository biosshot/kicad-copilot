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

/** Keep optional report sections useful to an LLM without returning raw track/net dumps. */
function bounded(input: unknown, depth = 0): unknown {
    if (input === null || input === undefined || typeof input !== 'object') return input;
    if (depth >= MAX_DEPTH) return '[nested details omitted]';
    if (Array.isArray(input)) {
        const items = input.slice(0, MAX_ARRAY_ITEMS).map(item => bounded(item, depth + 1));
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
            output[`${key}_count`] = item.length;
            continue;
        }
        output[key] = bounded(item, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) output.truncated_keys = entries.length - MAX_OBJECT_KEYS;
    return output;
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
    return array(raw).map(asRecord).filter((item): item is JsonRecord => item !== undefined).map((item) => ({
        reference: item.reference,
        value: item.value,
        function: item.function,
        total_pins: item.total_pins,
        unconnected_pins: Array.isArray(item.unconnected_pins)
            ? item.unconnected_pins.length
            : item.unconnected_pins,
        power_pins: array(item.power_pins).map(asRecord).filter(Boolean).map((pin) => ({
            pin: pin?.pin_number,
            name: pin?.pin_name,
            net: pin?.net,
            has_decoupling_cap: pin?.has_decoupling_cap,
        })),
        decoupling_caps_by_rail: item.decoupling_caps_by_rail,
    }));
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
            anti_resonances: bounded(rail.anti_resonances),
            capacitors: array(rail.capacitors).slice(0, 12).map(asRecord).filter(Boolean).map(cap => ({
                reference: cap?.reference ?? cap?.ref,
                value: cap?.value,
                type: cap?.type,
                srf: cap?.srf_formatted ?? cap?.srf,
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
            'sheets', 'hierarchical_labels', 'hierarchy_context', 'hierarchy_warning',
        ]));
    }

    if (selected(options, 'blocks')) {
        const detections = findingFacts(raw, finding => {
            const detector = String(finding.detector || '');
            const rule = String(finding.rule_id || '');
            return detector.startsWith('detect_') || rule.endsWith('-DET');
        });
        output.blocks = bounded({
            subcircuits: raw.subcircuits,
            detections,
            ic_pin_analysis: compactIcPinAnalysis(raw.ic_pin_analysis),
            transistor_pin_analysis: compactIcPinAnalysis(raw.transistor_pin_analysis),
        });
    }

    if (selected(options, 'connectivity')) {
        output.connectivity = bounded({
            issues: raw.connectivity_issues,
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
            domains: value(design, 'power_domains'),
            ground_domains: raw.ground_domains,
            sequencing: raw.power_sequencing_validation,
            budget: raw.power_budget,
            sleep_current: raw.sleep_current_audit,
            // Raw impedance profiles contain dozens of samples per rail. The
            // extrema and anti-resonances are the actionable part for an LLM.
            pdn_impedance: compactPdnImpedance(raw.pdn_impedance),
            inrush: raw.inrush_analysis,
        });
    }

    if (selected(options, 'buses')) {
        output.buses = bounded({
            topology: raw.bus_topology,
            analysis: value(design, 'bus_analysis'),
            differential_pairs: value(design, 'differential_pairs'),
            cross_domain_signals: value(design, 'cross_domain_signals'),
            net_classifications: raw.net_classifications,
        });
    }

    if (selected(options, 'bom')) {
        output.bom = bounded({
            component_groups: raw.bom,
            sourcing: raw.sourcing_audit,
            optimization: raw.bom_optimization,
            missing_mpn: value(statistics, 'missing_mpn'),
            missing_footprint: value(statistics, 'missing_footprint'),
        });
    }

    if (selected(options, 'assembly')) output.assembly = bounded(raw.assembly_complexity || {});

    if (selected(options, 'verification')) {
        output.verification = bounded({
            test_coverage: raw.test_coverage,
            simulation_readiness: raw.simulation_readiness,
            usb_compliance: raw.usb_compliance,
            erc_warnings: value(design, 'erc_warnings'),
            trust: raw.trust_summary,
            capability: raw.capability_mode_ref,
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
