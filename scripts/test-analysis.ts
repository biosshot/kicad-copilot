import assert from 'node:assert/strict';
import { analyzePcb, analyzeSchematic, compactAnalysis } from '../src/analysis/kicad-happy';

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
    reportPath: 'schematic.json',
});
assert.equal(schematic.status, 'warn');
assert.equal(schematic.findings.length, 3);
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
    reportPath: 'pcb.json',
});
assert.equal(pcb.status, 'fail');
assert.equal(pcb.findings.length, 1);
assert.match(pcb.findings[0].message, /^25 unrouted nets\./);
assert.equal(pcb.findings[0].refs?.length, 12);
assert.deepEqual(pcb.findings[0].refs?.slice(0, 3), ['N0', 'N1', 'N2']);
assert.equal(pcb.findings[0].fix, 'Route the listed nets before detailed PCB review.');
assert.equal(pcb.report, 'pcb.json');

const fixture = process.env.KICAD_ANALYSIS_FIXTURE;
if (fixture) {
    const schematicResult = await analyzeSchematic(fixture, 'full');
    const pcbResult = await analyzePcb(fixture, true, true);
    console.log(JSON.stringify({ schematic: schematicResult, pcb: pcbResult }, null, 2));
} else {
    console.log('Analysis normalization tests passed.');
}
