/**
 * Local routing DSL. A file is a sequence of statements followed by exactly
 * exactly one of applyDrcRules(), applyStackup(), runCopper(), runRouting(),
 * or runAll(). Dimensions are mm.
 * Omitted values inherit the imported board/DSN rules.
 */

type PhysicalLayer = "TOP" | "BOTTOM" | `INNER_${number}`;
type LayerSelector = PhysicalLayer | "OUTER" | "ALL" | PhysicalLayer[];
type CopperTarget = object;
type RegionSelector = object;
type FanoutTarget = object;

interface ViaOptions {
  /** Nominal/preferred via diameter. */
  diameterMm?: number;
  /** Nominal/preferred drill diameter. */
  drillMm?: number;
  /** Hard minimum via diameter. */
  minDiameterMm?: number;
  /** Hard minimum drill diameter. */
  minDrillMm?: number;
}

interface FanoutOptions {
  /** auto tries a surface stub first, then underpad for the remaining nets. */
  method?: "auto" | "stub" | "underpad";
  /** Distance past the pad edge before the surface stub bends. Default: 0.1 mm. */
  extensionMm?: number;
}

interface RuleOptions {
  /** Nominal/preferred width used for ordinary routing. */
  trackWidthMm?: number;
  /** Hard lower bound used by neck-down and final validation. */
  minTrackWidthMm?: number;
  clearanceMm?: number;
  edgeClearanceMm?: number;
  holeToHoleClearanceMm?: number;
  allowedLayers?: LayerSelector;
  via?: ViaOptions;
}

interface ImpedanceOptions {
  targetOhm: number;
  tolerancePercent?: number;
  /** Omitted/auto selects the nearest unambiguous solid reference copper. */
  referenceNet?: string | "auto";
}

interface ZoneOptions {
  clearanceMm?: number;
  minThicknessMm?: number;
  fill?: {
    style?: "solid" | "hatched";
    hatchThicknessMm?: number;
    hatchGapMm?: number;
    hatchOrientationDeg?: number;
  };
  padConnection?: {
    mode?: "solid" | "thermal" | "none";
    thermalGapMm?: number;
    spokeWidthMm?: number;
    spokeCount?: number;
    spokeAngleDeg?: number;
  };
  removeIslandsBelowMm2?: number;
}

declare function pad(component: string, pad: string | number): CopperTarget;
/** Select an entire component for component-scoped routing policy. */
declare function component(designator: string): FanoutTarget;
declare function net(name: string): CopperTarget;
declare function board(): RegionSelector;
/** Component-bounded region; currently implemented for viaStitch grid/around. */
declare function components(...designators: string[]): RegionSelector;

interface PolygonBuilder {
  connect(...targets: CopperTarget[]): this;
  on(layers: LayerSelector): this;
  compact(options?: { maxPadFreeGapWidths?: number }): this;
  maxPadFreeGapWidths(value: number): this;
  zone(options: ZoneOptions): this;
}

declare function polygon(net: string): PolygonBuilder;

declare function plane(options: {
  net: string;
  layers?: LayerSelector;
  region?: RegionSelector;
  paddingMm?: number;
  zone?: ZoneOptions;
  stitching?: false | true | {
    gridMm?: number;
    maxVisibleViaDistanceMm?: number;
    via?: "drc-min" | Pick<ViaOptions, "diameterMm" | "drillMm">;
    viaInPad?: boolean;
    maxVias?: number;
  };
}): void;

declare function drc(options: RuleOptions): void;
declare function netClass(name: string, options: RuleOptions & { nets: string[] }): void;

declare function signalNet(net: string, options?: RuleOptions & {
  netClass?: string;
  impedance?: ImpedanceOptions;
}): void;

declare function powerNet(net: string, options?: RuleOptions & {
  netClass?: string;
  maxCurrentA?: number;
  maxTempRiseC?: number;
  maxTrackWidthMm?: number;
  /** Pads carrying the trunk current. Other pads use tapWidthMm. */
  powerPads?: CopperTarget[];
  tapWidthMm?: number | "drc-min";
}): void;

declare function diffPair(id: string, options: RuleOptions & {
  positive: string;
  negative: string;
  gapMm?: number;
  maxSkewMm?: number;
  maxUncoupledLengthMm?: number;
  impedance?: ImpedanceOptions;
}): void;

declare function matchedGroup(id: string, options: {
  nets: string[];
  toleranceMm?: number;
}): void;

interface ViaStitchCommon {
  via?: Pick<ViaOptions, "diameterMm" | "drillMm"> | "drc-min";
  maxVias?: number;
}

type ViaStitchOptions =
  | ViaStitchCommon & {
      mode: "grid";
      net: string;
      region: RegionSelector;
      pitchMm: number;
      viaInPad?: boolean;
    }
  | ViaStitchCommon & {
      mode: "along";
      net: string;
      routes: string[];
      pitchMm?: number;
      offsetMm?: number;
      rows?: number;
      rowSpacingMm?: number;
      stagger?: boolean;
    }
  | ViaStitchCommon & {
      mode: "around";
      net: string;
      target: RegionSelector | FanoutTarget;
      pitchMm?: number;
      offsetMm?: number;
      rows?: number;
      side?: "inside" | "outside";
    }
  | ViaStitchCommon & {
      mode: "return";
      referenceNet: string | "auto";
      forNets?: string[];
      maxDistanceMm?: number;
    };

declare function viaStitch(id: string, options: ViaStitchOptions): void;

interface BusDetectOptions {
  detectionRadiusMm?: number;
  minNets?: number;
  attractionRadiusMm?: number;
}

/** true emits only backend enablement; omitted numeric fields stay backend defaults. */
declare function busDetect(enabled: boolean | BusDetectOptions): void;

/** Configure automatic fanout for a component or one logical pad. */
declare function fanout(target: FanoutTarget, options?: FanoutOptions): void;

/**
 * Disable automatic dense-package fanout for whole components or individual
 * logical pads. This does not exclude their nets from normal routing.
 */
declare function disableFanout(...targets: FanoutTarget[]): void;

declare function stack(options: {
  boardThicknessMm?: number;
  fallbackCopperThicknessOz?: number;
  viaPlatingThicknessUm?: number;
  maxTrackWidthMm?: number;
  layers?: Array<
    | { kind: "copper"; name: PhysicalLayer; thicknessOz?: number; thicknessMm?: number }
    | { kind: "dielectric"; name?: string; thicknessMm?: number; relativePermittivity?: number; lossTangent?: number; material?: string }
  >;
  solderMask?: {
    top?: { thicknessMm?: number; relativePermittivity?: number };
    bottom?: { thicknessMm?: number; relativePermittivity?: number };
  };
}): void;

declare function quality(options: {
  profile?: "fast" | "balanced" | "quality-first" | "completion-first";
  /** 1..16; KRT also uses this as the cheap special-stage candidate cap. */
  maxCandidates?: number;
}): void;

declare function onlyNets(...nets: string[]): void;
declare function ignoreNets(...nets: string[]): void;
declare function clearRouting(options?: {
  nets?: "all" | string[];
  /** Alias for nets, retained for natural agent requests. */
  only?: string[];
  items?: Array<"tracks" | "vias" | "zones">;
}): void;

declare function applyDrcRules(): void;
declare function applyStackup(): void;
declare function runCopper(): void;
declare function runRouting(): void;
declare function runAll(): void;
