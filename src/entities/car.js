import * as THREE from 'three';
import { mergeGeometries } from '../world/props.js';

/**
 * The hero car. It is TINY on screen (~4% of frame width), so silhouette and
 * value contrast against the ground matter far more than detail. Read order:
 *   1. overall boxy shape + bright body colour
 *   2. dark glasshouse
 *   3. wheels as dark blocks at the corners
 * Everything else is gravy.
 */

export function buildCarMesh({ body = 0xef4d4d, accent = 0xffffff } = {}) {
  const root = new THREE.Group();
  root.name = 'car';

  const bodyMat = new THREE.MeshLambertMaterial({ color: body, flatShading: true });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x1e2a38, flatShading: true });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0x22252b, flatShading: true });
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });

  // --- lower body: a slightly tapered wedge ---
  const lower = new THREE.BoxGeometry(4.0, 0.85, 1.85);
  lower.translate(0, 0.62, 0);
  const nose = new THREE.BoxGeometry(0.7, 0.62, 1.72);
  nose.translate(2.1, 0.56, 0);
  const bodyGeo = mergeGeometries([lower, nose]);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  root.add(bodyMesh);

  // --- cabin ---
  const cabin = new THREE.BoxGeometry(2.0, 0.72, 1.62);
  cabin.translate(-0.25, 1.4, 0);
  const cabinMesh = new THREE.Mesh(cabin, bodyMat);
  cabinMesh.castShadow = true;
  root.add(cabinMesh);

  // --- glasshouse: a dark band that reads instantly from above ---
  const glass = new THREE.BoxGeometry(1.75, 0.5, 1.68);
  glass.translate(-0.25, 1.46, 0);
  const glassMesh = new THREE.Mesh(glass, glassMat);
  root.add(glassMesh);

  // --- roof ---
  const roof = new THREE.BoxGeometry(1.85, 0.14, 1.6);
  roof.translate(-0.3, 1.78, 0);
  root.add(new THREE.Mesh(roof, bodyMat));

  // --- rally details: light bar, spoiler, sump guard ---
  const bar = new THREE.BoxGeometry(0.3, 0.16, 1.5);
  bar.translate(2.2, 1.06, 0);
  root.add(new THREE.Mesh(bar, trimMat));
  const spoiler = new THREE.BoxGeometry(0.28, 0.1, 1.8);
  spoiler.translate(-2.02, 1.42, 0);
  root.add(new THREE.Mesh(spoiler, trimMat));
  const spoilerL = new THREE.BoxGeometry(0.12, 0.42, 0.12);
  spoilerL.translate(-1.95, 1.2, 0.75);
  const spoilerR = spoilerL.clone(); spoilerR.translate(0, 0, -1.5);
  root.add(new THREE.Mesh(mergeGeometries([spoilerL, spoilerR]), trimMat));

  // --- headlights / tail lights ---
  const hlL = new THREE.BoxGeometry(0.1, 0.24, 0.42);
  hlL.translate(2.44, 0.7, 0.52);
  const hlR = hlL.clone(); hlR.translate(0, 0, -1.04);
  root.add(new THREE.Mesh(mergeGeometries([hlL, hlR]), lightMat));

  const tlL = new THREE.BoxGeometry(0.09, 0.2, 0.36);
  tlL.translate(-2.02, 0.78, 0.6);
  const tlR = tlL.clone(); tlR.translate(0, 0, -1.2);
  const tails = new THREE.Mesh(mergeGeometries([tlL, tlR]), tailMat);
  root.add(tails);

  // --- racing stripe for readability from height ---
  const stripe = new THREE.BoxGeometry(4.6, 0.03, 0.3);
  stripe.translate(0, 1.06, 0);
  const stripeMesh = new THREE.Mesh(stripe, new THREE.MeshBasicMaterial({ color: accent }));
  root.add(stripeMesh);

  // --- wheels ---
  const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.36, 10);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x181a1f, flatShading: true });
  const hubMat = new THREE.MeshLambertMaterial({ color: 0xd8d8dc, flatShading: true });

  const wheels = [];
  const positions = [
    [1.35, 0.44, 0.92], [1.35, 0.44, -0.92],
    [-1.35, 0.44, 0.92], [-1.35, 0.44, -0.92],
  ];
  for (const [x, y, z] of positions) {
    const g = new THREE.Group();
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.castShadow = true;
    g.add(w);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.38, 8), hubMat);
    hub.rotation.x = Math.PI / 2;
    g.add(hub);
    g.position.set(x, y, z);
    root.add(g);
    wheels.push(g);
  }

  return { root, wheels, bodyMesh, tails, bodyMat };
}

/** Visual layer over the Vehicle physics: lean, squat, wheel spin, lights. */
export class CarView {
  constructor(opts) {
    const built = buildCarMesh(opts);
    this.root = built.root;
    this.wheels = built.wheels;
    this.tails = built.tails;
    this.bodyMat = built.bodyMat;
    this.chassis = new THREE.Group();
    // Reparent everything under a chassis node so we can lean it.
    while (this.root.children.length) this.chassis.add(this.root.children[0]);
    this.root.add(this.chassis);

    this.wheelSpin = 0;
    this._roll = 0;
    this._pitch = 0;

    // Headlights: a spot per side, cheap but they sell dusk biomes.
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 90, 0.42, 0.5, 1.2);
    this.headlight.position.set(2.4, 0.8, 0);
    this.headlightTarget = new THREE.Object3D();
    this.headlightTarget.position.set(40, -6, 0);
    this.headlight.target = this.headlightTarget;
    this.root.add(this.headlight, this.headlightTarget);
  }

  setHeadlights(on) {
    this.headlight.intensity = on ? 260 : 0;
  }

  /**
   * @param {import('./vehicle.js').Vehicle} v
   * @param {{normal: THREE.Vector3, height: number}} ground
   */
  update(dt, v, ground) {
    this.root.position.set(v.position.x, ground.height, v.position.z);
    this.root.rotation.y = v.heading;

    // Body roll from lateral acceleration, pitch from longitudinal.
    const targetRoll = THREE.MathUtils.clamp(-v.lateralSlip * 0.30, -0.24, 0.24);
    const accel = (v.speed - (this._lastSpeed ?? v.speed)) / Math.max(dt, 1e-4);
    this._lastSpeed = v.speed;
    const targetPitch = THREE.MathUtils.clamp(-accel * 0.006, -0.09, 0.09);

    this._roll += (targetRoll - this._roll) * Math.min(1, dt * 9);
    this._pitch += (targetPitch - this._pitch) * Math.min(1, dt * 7);

    // Conform to the ground normal so the car hugs hills.
    const n = ground.normal;
    const slopeX = Math.atan2(n.x, n.y);
    const slopeZ = Math.atan2(n.z, n.y);
    const c = Math.cos(-v.heading), s = Math.sin(-v.heading);
    const localPitch = slopeX * c - slopeZ * s;
    const localRoll = slopeX * s + slopeZ * c;

    this.chassis.rotation.z = this._pitch - localPitch;
    this.chassis.rotation.x = this._roll + localRoll;

    // Wheels: steer the fronts, spin all four, spin faster when slipping.
    this.wheelSpin += (v.speed * (1 + v.wheelSlip[2] * 0.8)) * dt * 2.2;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.rotation.set(0, 0, 0);
      if (i < 2) w.rotation.y = v.steer * 1.05;
      w.rotation.z = 0;
      w.children[0].rotation.z = -this.wheelSpin;
      w.children[1].rotation.z = -this.wheelSpin;
    }

    // Brake lights.
    this.tails.material.color.setHex(v._braking ? 0xff3a3a : 0x8a1616);
  }
}
