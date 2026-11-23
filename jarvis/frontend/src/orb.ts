import * as THREE from 'three';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';
const COLORS: Record<OrbState, number> = { idle: 0x4aa3df, listening: 0x6ee7b7, thinking: 0xfbbf24, speaking: 0x7dd3fc };

/** Particle sphere that breathes with an audio level in 0..1. */
export class Orb {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  private pts: THREE.Points;
  private base: Float32Array;
  private mat: THREE.PointsMaterial;
  state: OrbState = 'idle';
  level = 0;
  private smooth = 0;

  constructor(canvas: HTMLCanvasElement, n = 2400) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.camera.position.z = 3.2;
    this.base = new Float32Array(n * 3);
    const g = Math.PI * (3 - Math.sqrt(5)); // fibonacci sphere
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = g * i;
      this.base.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.base.slice(), 3));
    this.mat = new THREE.PointsMaterial({ size: 0.02, color: COLORS.idle, transparent: true, opacity: 0.9 });
    this.pts = new THREE.Points(geo, this.mat);
    this.scene.add(this.pts);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop((t) => this.frame(t / 1000));
  }

  private resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(t: number) {
    this.smooth += (this.level - this.smooth) * 0.25;
    const amp = this.state === 'speaking' ? 0.35 : this.state === 'listening' ? 0.15 : 0.05;
    const pulse = this.state === 'thinking' ? 0.08 * Math.sin(t * 5) : 0;
    const pos = this.pts.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = this.base[i * 3], y = this.base[i * 3 + 1], z = this.base[i * 3 + 2];
      const wob = Math.sin(t * 1.5 + x * 4 + y * 3) * 0.02 + Math.sin(t * 6 + z * 7) * amp * this.smooth;
      const s = 1 + wob + this.smooth * amp + pulse;
      pos.setXYZ(i, x * s, y * s, z * s);
    }
    pos.needsUpdate = true;
    this.pts.rotation.y = t * (this.state === 'thinking' ? 0.8 : 0.15);
    this.mat.color.lerp(new THREE.Color(COLORS[this.state]), 0.08);
    this.renderer.render(this.scene, this.camera);
  }
}
