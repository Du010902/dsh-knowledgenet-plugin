/** Plugin-owned screen-sized nodes and camera-facing dependency arrowheads. */
export function patchSpaceVisuals(source) {
  let code = source;
  const replace = (before, after) => {
    if (!code.includes(before)) throw new Error(`Space renderer changed: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  replace('private readonly nodeGeometry: SphereGeometry;', 'private readonly nodeGeometry: PlaneGeometry;');
  replace('private readonly arrowGeometry: ConeGeometry;', 'private readonly arrowGeometry: BufferGeometry;');
  replace('this.nodeGeometry = new SphereGeometry(1, 24, 16);', 'this.nodeGeometry = new PlaneGeometry(2.6, 2.6);');
  replace('  private radiusAttribute: InstancedBufferAttribute | null = null;', '  private radiusAttribute: InstancedBufferAttribute | null = null;\n  private distanceAttribute: InstancedBufferAttribute | null = null;');
  replace('      nodes.geometry.setAttribute("aRadius", this.radiusAttribute);', '      nodes.geometry.setAttribute("aRadius", this.radiusAttribute);\n      this.distanceAttribute = new InstancedBufferAttribute(new Float32Array(count), 1);\n      nodes.geometry.setAttribute("aDistance", this.distanceAttribute);');
  replace('      this.dimAttribute = null;', '      this.dimAttribute = null;\n      this.distanceAttribute = null;');
  replace('  attribute float aRadius;', '  attribute float aRadius;\n  attribute float aDistance;\n  varying vec2 vNodePoint;\n  varying float vDistance;');
  replace('    vTint = instanceColor;', '    vTint = instanceColor;\n    vNodePoint = (uv - 0.5) * 2.6;\n    vDistance = aDistance;');
  replace('  uniform vec3 uRim;', '  varying vec2 vNodePoint;\n  varying float vDistance;\n  uniform vec3 uRim;');
  replace('    vec3 n = normalize(vViewNormal);\n    vec2 p = vec2(n.x, n.y);\n    float s = length(p);', '    vec2 p = vNodePoint;\n    float s = length(p);\n    float softness = mix(0.025, 0.23, vDistance);\n    float coverage = 1.0 - smoothstep(1.0 - softness, 1.0 + softness, s);\n    if (coverage < 0.015) discard;');
  replace('    col = mix(col, strokeColor, stroke * mix(0.65, 0.18, vDim));', '    col = mix(col, strokeColor, stroke * mix(0.4, 0.12, vDim) * (1.0 - vDistance));');
  replace('    gl_FragColor = vec4(col, mix(1.0, uDimAlpha, vDim));', '    col = mix(col, vTint, 0.25);\n    gl_FragColor = vec4(col, coverage * mix(1.0, 0.45, vDistance) * mix(1.0, 0.82, vDim));');
  replace(`        const basePixels = Math.max(
          NODE_MIN_PIXELS,
          Math.min(NODE_MAX_PIXELS, (graph.radius[i] ?? 4) / worldPerPixel),
        );`, '        const basePixels = 5;');
  replace('        this.dummy.scale.setScalar(pixels * worldPerPixel);', `        this.dummy.quaternion.copy(camera.quaternion);
        this.dummy.scale.setScalar(pixels * worldPerPixel);
        const range = Math.max(40, bounds.radius * 2.8);
        const observerDistance = Math.hypot(px - basis.position[0], py - basis.position[1], pz - basis.position[2]);
        const distanceCue = Math.max(0, Math.min(1, (observerDistance / range - 0.25) / 1.5));
        this.distanceAttribute?.setX(i, distanceCue);`);
  replace('      if (this.radiusAttribute) this.radiusAttribute.needsUpdate = true;', '      if (this.radiusAttribute) this.radiusAttribute.needsUpdate = true;\n      if (this.distanceAttribute) this.distanceAttribute.needsUpdate = true;');
  replace(`    this.arrowGeometry = new ConeGeometry(0.58, 2.2, 10);
    this.arrowGeometry.translate(0, -1.1, 0); // 尖端落在原点：定位时只算一个点`, `    this.arrowGeometry = new BufferGeometry();
    this.arrowGeometry.setAttribute("position", new BufferAttribute(new Float32Array([
      0, 0, 0, -4, -7, 0, -2.6, -7, 0, 0, -2.3, 0, 2.6, -7, 0, 4, -7, 0,
    ]), 3));
    this.arrowGeometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);`);
  replace('this.arrowMaterial = new MeshBasicMaterial({ color: toColor(palette.edgeActiveRgb) });', 'this.arrowMaterial = new MeshBasicMaterial({ color: toColor(palette.edgeActiveRgb), side: DoubleSide, depthWrite: false });');
  const start = code.indexOf('  private updateArrows(');
  const end = code.indexOf('\n  /** 选中环', start);
  if (start < 0 || end < 0) throw new Error('Missing arrow method');
  code = code.slice(0, start) + `  private updateArrows(focal: number, halfHeight: number, basis: CameraBasis): void {
    if (!this.graph) return;
    const project = (point: number[]) => {
      const relative = point.map((value, axis) => value - basis.position[axis]!);
      const dot = (axis: number[]) => relative.reduce((sum, value, i) => sum + value * axis[i]!, 0);
      const depth = dot(basis.forward);
      return { depth, x: dot(basis.right) * focal * halfHeight / depth, y: dot(basis.up) * focal * halfHeight / depth };
    };
    this.relatedEdges.forEach(([from, to], index) => {
      const arrow = this.arrowPool[index];
      if (!arrow) return;
      const start = this.pointAt(from);
      const end = this.pointAt(to);
      const a = project(start);
      const b = project(end);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (a.depth <= NEAR_PLANE || b.depth <= NEAR_PLANE || length < 24) { arrow.visible = false; return; }
      const worldPerPixel = b.depth / (focal * halfHeight);
      const gap = (5 * (to === this.selected ? SELECTED_SCALE : 1) + 3) * worldPerPixel;
      const ux = dx / length;
      const uy = dy / length;
      arrow.position.set(
        end[0] - (basis.right[0] * ux + basis.up[0] * uy) * gap,
        end[1] - (basis.right[1] * ux + basis.up[1] * uy) * gap,
        end[2] - (basis.right[2] * ux + basis.up[2] * uy) * gap,
      );
      arrow.quaternion.copy(this.camera.quaternion);
      arrow.rotateZ(-Math.atan2(dx, dy));
      arrow.scale.setScalar(worldPerPixel);
      arrow.visible = true;
    });
  }
` + code.slice(end);
  return code;
}
