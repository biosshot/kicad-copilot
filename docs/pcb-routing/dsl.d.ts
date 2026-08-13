/**
 * Installed copy of @easyeda-copilot/router/docs/routing-dsl.d.ts.
 * A DSL file is one sequence of statements and exactly one terminal command.
 * All dimensions are millimetres unless a field says otherwise.
 */

type LayerSelector = object;
type CopperTarget = object;
type RegionSelector = object;
declare function pad(component: string, pad: string | number): CopperTarget;
declare function net(name: string): CopperTarget;
declare function topLayer(): LayerSelector;
declare function bottomLayer(): LayerSelector;
declare function outerLayers(): LayerSelector;
declare function layers(...names: string[]): LayerSelector;
declare function board(): RegionSelector;
/** Reserved: component-bounded planes are validated but not generated yet. */
declare function components(...designators: string[]): RegionSelector;
interface PolygonBuilder {
  connect(...targets: CopperTarget[]): this;
  on(layers: LayerSelector): this;
  compact(): this;
  priority(value: number): this;
  maxPadFreeGapWidths(value: number): this;
}
declare function polygon(net: string): PolygonBuilder;
interface ViaOptions {
  diameterMm?: number;
  drillMm?: number;
}
interface ImpedanceOptions {
  targetOhm: number;
  tolerancePercent?: number;
}
declare function plane(options: {
  net: string;
  layers?: LayerSelector;
  region?: RegionSelector;
  paddingMm?: number;
  priority?: number;
  stitching?: false | true | {
    gridMm?: number;
    maxPadViaDistanceMm?: number;
    via?: 'drc-min' | Required<ViaOptions>;
    viaInPad?: boolean;
    maxVias?: number;
  };
}): void;

declare function powerNet(net: string, options: {
  maxCurrentA?: number;
  maxTempRiseC?: number;
  minTrackWidthMm?: number;
  maxTrackWidthMm?: number;
  clearanceMm?: number;
  allowedLayers?: LayerSelector;
  via?: ViaOptions;
}): void;

declare function signalNet(net: string, options?: {
  trackWidthMm?: number;
  minTrackWidthMm?: number;
  clearanceMm?: number;
  maxLengthMm?: number;
  allowedLayers?: LayerSelector;
  via?: ViaOptions;
  impedance?: ImpedanceOptions;
}): void;

declare function diffPair(id: string, options: {
  positive: string;
  negative: string;
  trackWidthMm?: number;
  gapMm?: number;
  maxSkewMm?: number;
  maxUncoupledLengthMm?: number;
  clearanceMm?: number;
  allowedLayers?: LayerSelector;
  via?: ViaOptions;
  impedance?: ImpedanceOptions;
}): void;

declare function matchedGroup(id: string, options: {
  nets: string[];
  toleranceMm?: number;
}): void;

declare function fabrication(options: {
  fallbackCopperThicknessOz?: number;
  viaPlatingThicknessUm?: number;
  maxTrackWidthMm?: number;
}): void;

/** Write effective DRC rules only; no routing is run. */
declare function applyDrcRules(): void;
/** Route using effective rules without persisting DSL rule overrides. */
declare function runRouting(): void;
/** Apply effective DRC rules and run all routing stages. */
declare function runAll(): void;
