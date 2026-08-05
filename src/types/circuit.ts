import * as z from 'zod/v4';

export type ExplainPin = {
    pin_number: string | number;
    name: string;
    signal_name: string;
};

export type ExplainComponent = {
    designator: string;
    value: string;
    pins: ExplainPin[];
    part_uuid: string | null;
    footprint_name?: string | null;
};

export type ExplainCircuit = {
    components: ExplainComponent[];
};

const pinSchema = z.object({
    pin_number: z.union([z.number(), z.string()]),
    name: z.string(),
    signal_name: z.string(),
});

const baseComponentSchema = z.object({
    designator: z.string().min(1),
    value: z.string(),
    pins: z.array(pinSchema),
    block_name: z.string(),
    search_query: z.string(),
});

export const circuitModSchema = z.object({
    add_components: z.array(baseComponentSchema.extend({
        part_uuid: z.string().regex(/^[a-f0-9]{32}$/i, 'invalid part_uuid'),
    })),
    add_reused_blocks: z.array(z.object({
        block_uuid: z.string().min(1),
        parameters_to_recalc: z.array(z.object({
            name: z.string(),
            new_value: z.number(),
        })),
        ports: z.array(z.object({
            port_number: z.union([z.string(), z.number()]),
            signal_name: z.string(),
        })),
    })),
    rm_components: z.array(z.string()).nullable(),
    external_rm_connect: z.array(z.object({
        designator: z.string(),
        pin_number: z.union([z.string(), z.number()]),
    })).nullable(),
    external_connect: z.array(z.object({
        designator: z.string(),
        pin_number: z.union([z.string(), z.number()]),
        signal_name: z.string(),
    })).nullable(),
});

export type CircuitMod = z.infer<typeof circuitModSchema>;

export type CircuitAssemblyComponent = {
    designator: string;
    value: string;
    pins: ExplainPin[];
    block_name: string;
    search_query: string;
    part_uuid: string | null;
    sub_part_name?: string;
    pos: {
        x: number;
        y: number;
        center?: { x: number; y: number };
        width: number;
        height: number;
        rotate?: number;
        mirror?: boolean;
    };
};

export type CircuitAssembly = {
    metadata: {
        project_name: string;
        description: string;
    };
    components: CircuitAssemblyComponent[];
    edges: Array<{
        sources: string[];
        targets: string[];
        container: string;
        sections: Array<{
            id: string;
            startPoint: { x: number; y: number };
            endPoint: { x: number; y: number };
            bendPoints?: Array<{ x: number; y: number }>;
            incomingShape?: string;
            outgoingShape?: string;
        }>;
        junctionPoints?: Array<{ x: number; y: number }>;
    }>;
    blocks_rect?: Array<{
        name: string;
        description: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    assembly_options?: {
        centered?: boolean;
        draw_blocks?: boolean;
    };
    added_net?: Array<{
        designator: string;
        pin_number: string | number;
        net: string;
    }>;
    rm_net?: Array<{
        designator: string;
        pin_number: string | number;
        net: string;
    }>;
    rm_components?: string[];
    replace_components?: string[];
};
