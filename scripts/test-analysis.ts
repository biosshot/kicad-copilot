import assert from 'node:assert/strict';
import { analyzePcb, analyzeSchematic, compactAnalysis } from '../src/analysis/kicad-happy';
import { auditLifecycle } from '../src/analysis/lifecycle-operation';
import { waitOperation } from '../src/operations/control';
import { createOperationId, parseOperationId } from '../src/operations/id';
import { projectPcb, projectSchematic } from '../src/analysis/projections';
import { runCompactTool } from '../src/utils/tool-result';
import { runProcessChecked } from '../src/utils/process';

const compactToolResult = await runCompactTool(async () => ({ status: 'pass', empty: undefined }));
assert.equal(compactToolResult.content[0].text, '{"status":"pass"}');
for (const kind of ['pcb-layout', 'pcb-dsl', 'lifecycle'] as const) {
    const operationId = createOperationId(kind);
    assert.match(operationId, new RegExp(`^${kind}:[0-9a-f]{8}$`));
    assert.equal(parseOperationId(operationId).kind, kind);
}
assert.throws(() => parseOperationId('lifecycle:not-hex'), /Invalid operation_id/);

const processController = new AbortController();
const cancellableProcess = runProcessChecked(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'],
    { timeoutMs: 30_000, signal: processController.signal },
);
processController.abort();
await assert.rejects(cancellableProcess, /Operation cancelled/);

const syntheticSchematic = {
    nets: {
        SWCLK: { pins: [{ component: '#PORT1', pin_type: 'power_in' }] },
        VBUS: { pins: [{ component: '#PWR1', pin_type: 'power_in' }] },
    },
    findings: [
        {
            severity: 'warning', detector: 'audit_rail_sources', rule_id: 'RS-001',
            category: 'power', summary: 'SWCLK has no declared source',
            recommendation: 'Add PWR_FLAG.', nets: ['SWCLK'], pins: ['#PORT1.1'],
        },
        {
            severity: 'warning', detector: 'audit_rail_sources', rule_id: 'RS-001',
            category: 'power', summary: 'VBUS has no declared source',
            recommendation: 'Declare the external source.', nets: ['VBUS'], pins: ['#PWR1.1'],
        },
        {
            severity: 'warning', detector: 'analyze_usb_compliance', rule_id: 'UC-002',
            category: 'usb', summary: 'No ESD protection on VBUS',
            recommendation: 'Add a TVS diode.', components: ['J1'], nets: ['VBUS'],
        },
        {
            severity: 'warning', detector: 'audit_datasheet_coverage', rule_id: 'DS-002',
            category: 'verification', summary: 'No datasheets directory found.',
            recommendation: 'Sync datasheets.', components: ['U1'],
        },
        {
            severity: 'info', detector: 'audit_connector_ground_distribution', rule_id: 'CG-AUD',
            category: 'connectors', summary: 'J4 has too few ground pins',
            recommendation: 'Add ground pins.', components: ['J4'],
        },
        {
            severity: 'info', detector: 'detect_crystal_circuits', rule_id: 'XL-DET',
            category: 'timing', summary: 'Crystal detected', recommendation: '', components: ['Y1'],
        },
    ],
};

const schematic = compactAnalysis(syntheticSchematic, 'schematic', {
    includeActionableInfo: true,
});
assert.equal(schematic.status, 'warn');
assert.deepEqual(schematic.skipped, []);
assert.equal(schematic.findings?.length, 3);
assert.ok(!JSON.stringify(schematic).includes('SWCLK'));
assert.ok(!JSON.stringify(schematic).includes('rule_id'));
assert.ok(!JSON.stringify(schematic).includes('detector'));

const syntheticPcb = {
    findings: Array.from({ length: 25 }, (_, index) => ({
        severity: 'error', detector: 'analyze_connectivity', rule_id: 'RT-001',
        category: 'connectivity', summary: `Unrouted net N${index} (${index + 2} pads)`,
        recommendation: `Route net N${index}`, nets: [`N${index}`], pad_count: index + 2,
        pads: Array.from({ length: index + 2 }, (__, pad) => `U1.${pad}`),
    })),
};
const pcb = compactAnalysis(syntheticPcb, 'pcb', {
    includeActionableInfo: true,
});
assert.equal(pcb.status, 'fail');
assert.equal(pcb.findings?.length, 1);
assert.match(pcb.findings![0].message, /^25 unrouted nets\./);
assert.equal(pcb.findings![0].refs?.length, 12);
assert.deepEqual(pcb.findings![0].refs?.slice(0, 3), ['N0', 'N1', 'N2']);
assert.equal(pcb.findings![0].fix, 'Route the listed nets before detailed PCB review.');
assert.ok(!('report' in pcb));

const schematicProjection = projectSchematic({
    statistics: { total_components: 12, total_nets: 8 },
    sheets: ['root', 'power'],
    power_budget: { rails: [{ name: '+3V3' }] },
    assembly_complexity: { complexity_score: 24 },
}, { overview: true, power: true, assembly: true });
assert.deepEqual(Object.keys(schematicProjection), ['overview', 'power', 'assembly']);

const pcbProjection = projectPcb({
    statistics: { footprint_count: 12, unrouted_net_count: 2 },
    findings: [],
}, {}, { overview: true, all: false });
assert.deepEqual(Object.keys(pcbProjection), ['overview']);

const fixture = process.env.KICAD_ANALYSIS_FIXTURE;
if (fixture) {
    const schematicResult = await analyzeSchematic(fixture, { all: true });
    const pcbResult = await analyzePcb(fixture, { all: true, proximity: true });
    const focusedResult = await analyzeSchematic(fixture, { findings: false, power: true });
    assert.equal(focusedResult.findings, undefined);
    assert.ok(focusedResult.power);
    assert.ok(Array.isArray(focusedResult.skipped));
    assert.ok(!('report' in schematicResult));
    assert.ok(!JSON.stringify(schematicResult).includes('simulation_readiness'));
    assert.ok(!JSON.stringify(schematicResult).includes('ic_lib_id'));
    assert.ok(!JSON.stringify(schematicResult).includes('ic_value'));
    assert.ok(!JSON.stringify(schematicResult).includes('single_pin_net_findings'));
    const serializedResult = await runCompactTool(async () => schematicResult);
    const serialized = serializedResult.content[0].text;
    assert.equal(serialized.split('\n').length, 1);
    assert.ok(!serialized.includes(':""'));
    assert.ok(!serialized.includes(':[]'));
    assert.ok(!serialized.includes(':{}'));
    assert.ok(!/neighbor_components":\[[^\]]*"type"/.test(serialized));
    console.log(JSON.stringify({
        schematic: {
            status: schematicResult.status,
            bytes: JSON.stringify(schematicResult).length,
            pretty_lines: JSON.stringify(schematicResult, null, 2).split('\n').length,
            fields: Object.keys(schematicResult),
        },
        pcb: {
            status: pcbResult.status,
            bytes: JSON.stringify(pcbResult).length,
            fields: Object.keys(pcbResult),
        },
        focused: {
            status: focusedResult.status,
            bytes: JSON.stringify(focusedResult).length,
            fields: Object.keys(focusedResult),
        },
    }, null, 2));
} else {
    console.log('Analysis normalization tests passed.');
}

const lifecycleFixture = process.env.KICAD_LIFECYCLE_FIXTURE;
if (lifecycleFixture) {
    let lifecycle = await auditLifecycle(lifecycleFixture, { sources: ['lcsc'] }, 1_000);
    while (lifecycle.status === 'running') {
        lifecycle = await waitOperation(lifecycle.operation_id, 30_000);
    }
    console.log(JSON.stringify({
        lifecycle: {
            status: lifecycle.status,
            bytes: JSON.stringify(lifecycle).length,
            fields: Object.keys(lifecycle),
        },
    }, null, 2));
}
