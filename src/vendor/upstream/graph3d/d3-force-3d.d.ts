/**
 * d3-force-3d 的最小类型声明
 *
 * 该包（3.0.6）不附带类型，npm 上也没有 @types/d3-force-3d。这里只声明本视图
 * 真正用到的部分：`forceSimulation(nodes, 3)` 与 link / manyBody / collide /
 * x / y / z 六个力，以及手动 tick 所需的开关。
 *
 * 声明保持“够用且可核对”的原则——不把整个 d3-force API 抄一遍，
 * 抄错了反而会掩盖真实的类型错误。
 */
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<N> {
    source: N | string | number;
    target: N | string | number;
    index?: number;
  }

  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[], random: () => number, numDimensions: number): void;
  }

  export interface Simulation<N extends SimulationNodeDatum> {
    tick(iterations?: number): Simulation<N>;
    restart(): Simulation<N>;
    stop(): Simulation<N>;
    nodes(): N[];
    nodes(nodes: N[]): Simulation<N>;
    alpha(): number;
    alpha(alpha: number): Simulation<N>;
    alphaMin(): number;
    alphaMin(min: number): Simulation<N>;
    alphaDecay(): number;
    alphaDecay(decay: number): Simulation<N>;
    alphaTarget(): number;
    alphaTarget(target: number): Simulation<N>;
    velocityDecay(): number;
    velocityDecay(decay: number): Simulation<N>;
    force(name: string): Force<N> | undefined;
    force(name: string, force: Force<N> | null): Simulation<N>;
    numDimensions(): number;
    numDimensions(dimensions: number): Simulation<N>;
    randomSource(): () => number;
    randomSource(source: () => number): Simulation<N>;
    on(typenames: string, listener: ((this: Simulation<N>) => void) | null): Simulation<N>;
  }

  export interface ForceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>
    extends Force<N> {
    links(): L[];
    links(links: L[]): this;
    id(accessor: (node: N, index: number, nodes: N[]) => string | number): this;
    distance(): number | ((link: L, index: number, links: L[]) => number);
    distance(distance: number | ((link: L, index: number, links: L[]) => number)): this;
    strength(): number | ((link: L, index: number, links: L[]) => number);
    strength(strength: number | ((link: L, index: number, links: L[]) => number)): this;
    iterations(iterations: number): this;
  }

  export interface ForceManyBody<N extends SimulationNodeDatum> extends Force<N> {
    strength(): number | ((node: N, index: number, nodes: N[]) => number);
    strength(strength: number | ((node: N, index: number, nodes: N[]) => number)): this;
    theta(theta: number): this;
    distanceMin(distance: number): this;
    distanceMax(distance: number): this;
  }

  export interface ForceCollide<N extends SimulationNodeDatum> extends Force<N> {
    radius(): number | ((node: N, index: number, nodes: N[]) => number);
    radius(radius: number | ((node: N, index: number, nodes: N[]) => number)): this;
    strength(): number | ((node: N, index: number, nodes: N[]) => number);
    strength(strength: number | ((node: N, index: number, nodes: N[]) => number)): this;
    iterations(iterations: number): this;
  }

  export interface ForcePosition<N extends SimulationNodeDatum> extends Force<N> {
    strength(): number | ((node: N, index: number, nodes: N[]) => number);
    strength(strength: number | ((node: N, index: number, nodes: N[]) => number)): this;
  }

  export function forceSimulation<N extends SimulationNodeDatum>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation<N>;

  export function forceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(
    links?: L[],
  ): ForceLink<N, L>;

  export function forceManyBody<N extends SimulationNodeDatum>(): ForceManyBody<N>;
  export function forceCollide<N extends SimulationNodeDatum>(
    radius?: number | ((node: N, index: number, nodes: N[]) => number),
  ): ForceCollide<N>;
  export function forceX<N extends SimulationNodeDatum>(
    x?: number | ((node: N, index: number, nodes: N[]) => number),
  ): ForcePosition<N>;
  export function forceY<N extends SimulationNodeDatum>(
    y?: number | ((node: N, index: number, nodes: N[]) => number),
  ): ForcePosition<N>;
  export function forceZ<N extends SimulationNodeDatum>(
    z?: number | ((node: N, index: number, nodes: N[]) => number),
  ): ForcePosition<N>;
}
