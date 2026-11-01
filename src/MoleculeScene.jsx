import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './scene.css';
import { safePerpendicular, planeNormal, alignedPiOrbitals, electronicPresentation, displayedLonePairs } from './electronGeometry.js';
import { createTapTracker } from './sceneInteraction.js';

const ELEMENTS = {
  H: { color: '#edf2f6', radius: .25, vdw: 1.20 },
  B: { color: '#eaa18f', radius: .43, vdw: 1.92 },
  C: { color: '#3b485b', radius: .43, vdw: 1.70 },
  N: { color: '#3675d8', radius: .42, vdw: 1.55 },
  O: { color: '#ed5a55', radius: .40, vdw: 1.52 },
  F: { color: '#77c383', radius: .37, vdw: 1.47 },
  Si: { color: '#c5ad9c', radius: .49, vdw: 2.10 },
  P: { color: '#e8a14c', radius: .47, vdw: 1.80 },
  S: { color: '#eac34f', radius: .47, vdw: 1.80 },
  Cl: { color: '#58b582', radius: .46, vdw: 1.75 },
  Br: { color: '#a65a42', radius: .49, vdw: 1.85 },
  I: { color: '#9364bd', radius: .53, vdw: 1.98 },
};
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const V = (p) => new THREE.Vector3(...p);
const info = (a) => ELEMENTS[a.element] || { color: '#a1a9b6', radius: .43, vdw: 1.75 };

function disposeGroup(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse((item) => {
    if (item.geometry) geometries.add(item.geometry);
    (Array.isArray(item.material) ? item.material : [item.material]).filter(Boolean).forEach((mat) => {
      materials.add(mat);
      if (mat.map) textures.add(mat.map);
    });
  });
  textures.forEach((x) => x.dispose());
  materials.forEach((x) => x.dispose());
  geometries.forEach((x) => x.dispose());
  group.clear();
}

function labelSprite(text, { color = '#263448', fontSize = 16, pixelHeight = 28, selected = false } = {}) {
  // Paint at 2x CSS resolution, then keep a constant on-screen size. This avoids
  // shrinking text on large molecules or enlarging it when the camera zooms in.
  const resolution = 2;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = `600 ${fontSize * resolution}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
  context.font = font;
  const width = Math.max(36 * resolution, Math.ceil(context.measureText(text).width) + 18 * resolution);
  const height = pixelHeight * resolution;
  canvas.width = width; canvas.height = height;
  context.font = font;
  context.fillStyle = '#ffffff';
  context.strokeStyle = selected ? '#087c75' : '#7c8da0';
  context.lineWidth = selected ? 2 * resolution : resolution;
  const inset = context.lineWidth / 2;
  context.beginPath();
  context.roundRect(inset, inset, width - 2 * inset, height - 2 * inset, 6 * resolution);
  context.fill(); context.stroke();
  context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.userData.pixelLabel = { width: width / resolution, height: pixelHeight, radius: 0, gap: 6, priority: selected ? 50 : 0 };
  sprite.renderOrder = 10;
  return sprite;
}

function electronPairSprite() {
  // Two screen-aligned count dots, with no button-like box. A permanent fine
  // leader ties the notation to its atom even when overlap avoidance moves it.
  const canvas = document.createElement('canvas'); canvas.width = 52; canvas.height = 32;
  const context = canvas.getContext('2d');
  for (const x of [15, 37]) {
    context.beginPath(); context.arc(x, 16, 8, 0, Math.PI * 2);
    context.fillStyle = '#ffffff'; context.fill();
    context.beginPath(); context.arc(x, 16, 5.6, 0, Math.PI * 2);
    context.fillStyle = '#127e79'; context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, toneMapped: false, depthTest: false, depthWrite: false, transparent: true }));
  sprite.userData.pixelLabel = { width: 26, height: 16, radius: .43, gap: 0, priority: 20, alwaysLeader: true, leaderColor: '#32938b' };
  sprite.renderOrder = 11;
  return sprite;
}

const chargeText = charge => charge ? `${Math.abs(charge) > 1 ? String(Math.abs(charge)).replace(/[0-9]/g, n => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+n]) : ''}${charge > 0 ? '⁺' : '⁻'}` : '';

function cylinderBetween(a, b, radius, material, group, geometry, pick) {
  const direction = b.clone().sub(a);
  if (direction.lengthSq() < 1e-10) return null;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, direction.clone().normalize());
  mesh.scale.set(radius, direction.length(), radius);
  if (pick) mesh.userData.pick = pick;
  group.add(mesh);
  return mesh;
}

function addMeasurement(group, ids, positions) {
  const points = ids.filter((id) => positions.has(id)).slice(0, 4).map((id) => positions.get(id));
  if (points.length < 2) return;
  const material = new THREE.LineDashedMaterial({ color: '#158e91', dashSize: .10, gapSize: .07, depthTest: false, transparent: true, opacity: .85 });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
  line.computeLineDistances(); line.renderOrder = 8; group.add(line);
  let text = '', at;
  if (points.length === 2) {
    text = `${points[0].distanceTo(points[1]).toFixed(3)} Å`;
    at = points[0].clone().add(points[1]).multiplyScalar(.5);
  } else if (points.length === 3) {
    const a = points[0].clone().sub(points[1]).normalize();
    const b = points[2].clone().sub(points[1]).normalize();
    const theta = a.angleTo(b);
    text = `${THREE.MathUtils.radToDeg(theta).toFixed(2)}°`;
    const radius = Math.min(points[0].distanceTo(points[1]), points[2].distanceTo(points[1])) * .36;
    const normal = new THREE.Vector3().crossVectors(a, b);
    const arcPoints = [];
    if (normal.lengthSq() > .000001) {
      normal.normalize();
      for (let i = 0; i <= 36; i++) arcPoints.push(a.clone().applyAxisAngle(normal, theta * i / 36).multiplyScalar(radius).add(points[1]));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPoints), new THREE.LineBasicMaterial({ color: '#158e91', depthTest: false })));
    }
    const bisector = a.clone().add(b);
    at = points[1].clone().add((bisector.lengthSq() > .000001 ? bisector.normalize() : safePerpendicular(a)).multiplyScalar(radius + .4));
  } else {
    const b0 = points[0].clone().sub(points[1]);
    const b1 = points[2].clone().sub(points[1]).normalize();
    const b2 = points[3].clone().sub(points[2]);
    const v = b0.clone().sub(b1.clone().multiplyScalar(b0.dot(b1)));
    const w = b2.clone().sub(b1.clone().multiplyScalar(b2.dot(b1)));
    text = v.lengthSq() < 1e-8 || w.lengthSq() < 1e-8 ? '共線：二面角未定義' : `${THREE.MathUtils.radToDeg(Math.atan2(new THREE.Vector3().crossVectors(b1, v).dot(w), v.dot(w))).toFixed(2)}°`;
    at = points[1].clone().add(points[2]).multiplyScalar(.5);
  }
  const label = labelSprite(text, { color: '#075d5b', fontSize: 18, pixelHeight: 34, selected: true });
  label.userData.pixelLabel.anchor = at.clone();
  label.userData.pixelLabel.gap = 10;
  label.userData.pixelLabel.priority = 100;
  label.position.copy(at); group.add(label);
}

const MoleculeScene = forwardRef(function MoleculeScene({
  model, selectedAtoms = [], selectedBond = null, onAtomClick, onBondClick, onBackgroundClick,
  interactionMode = 'select', buildElement = 'C',
  showHydrogens = true, showLonePairs = true, showLabels = false, showPi = false,
  electronicView = 'hybrid', lewisStateIndex = null,
  representation = 'ball-stick', measurementAtoms = [], onReady,
}, ref) {
  const hostRef = useRef(null), runtime = useRef(null), callbacks = useRef({}), axesRef = useRef(null), hoverRef = useRef(null);
  const lastFit = useRef(null), [error, setError] = useState('');
  callbacks.current = { onAtomClick, onBondClick, onBackgroundClick, onReady, interactionMode, buildElement, model };

  useImperativeHandle(ref, () => ({
    resetView() { runtime.current?.fit(); },
    setView(view) {
      const r = runtime.current; if (!r) return;
      const direction = view === 'top' ? new THREE.Vector3(0, 1, .001) : view === 'side' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      r.camera.position.copy(r.controls.target).add(direction.normalize().multiplyScalar(r.fitDistance || 8));
      r.camera.up.set(0, 1, 0); r.controls.update();
    },
    screenshot() {
      const r = runtime.current; if (!r) return null;
      r.positionLabels();
      r.renderer.setClearColor(0xf3f6f9, 1); r.renderer.render(r.scene, r.camera);
      const png = r.renderer.domElement.toDataURL('image/png');
      r.renderer.setClearColor(0xf1f5f8, 0); r.renderer.render(r.scene, r.camera);
      return png;
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      setError('目前的瀏覽器無法建立 WebGL。請啟用硬體加速後重新開啟。'); return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
    renderer.setClearColor(0xf1f5f8, 0);
    renderer.domElement.setAttribute('aria-label', '互動式分子三維模型：單指拖曳旋轉、雙指縮放與平移，滑鼠可用滾輪縮放；點選原子或化學鍵');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8294a8, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 3.0); key.position.set(-4, 7, 9); scene.add(key);
    const fill = new THREE.DirectionalLight(0xd6e7ff, 1.6); fill.position.set(6, 2, -5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, .9); rim.position.set(-6, -3, -4); scene.add(rim);
    const group = new THREE.Group(); scene.add(group);
    const camera = new THREE.PerspectiveCamera(34, 1, .05, 1000);
    camera.position.set(6, 4, 9);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .09;
    controls.minDistance = 1; controls.maxDistance = 160; controls.rotateSpeed = .65; controls.panSpeed = .7;
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    const r = { renderer, scene, group, camera, controls, bounds: new THREE.Box3(), fitDistance: 8, pickables: [], resources: [], pixelLabels: [], viewportHeight: 1, viewportWidth: 1, labelLayoutDirty: true };
    const cameraUp = new THREE.Vector3(), cameraRight = new THREE.Vector3(), labelInView = new THREE.Vector3(), anchorNdc = new THREE.Vector3(), preferredNdc = new THREE.Vector3();
    const lastLabelCamera = new THREE.Matrix4(), lastLabelProjection = new THREE.Matrix4();
    r.updateLabelScale = () => {
      // With sizeAttenuation=false the Sprite shader cancels camera depth.
      // screenHeight = spriteScaleY * projection[5] * viewportHeight / 2.
      const pixelToScale = 2 / (r.viewportHeight * camera.projectionMatrix.elements[5]);
      for (const sprite of r.pixelLabels) {
        const label = sprite.userData.pixelLabel;
        sprite.scale.set(label.width * pixelToScale, label.height * pixelToScale, 1);
      }
      r.labelLayoutDirty = true;
    };
    r.positionLabels = () => {
      if (!r.pixelLabels.length) return;
      camera.updateMatrixWorld();
      // Packing only changes with the camera, canvas size, or label set. A still
      // viewport reuses positions rather than testing hundreds of pairs per frame.
      if (!r.labelLayoutDirty && camera.matrixWorld.equals(lastLabelCamera) && camera.projectionMatrix.equals(lastLabelProjection)) return;
      lastLabelCamera.copy(camera.matrixWorld); lastLabelProjection.copy(camera.projectionMatrix); r.labelLayoutDirty = false;
      cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      const occupied = [];
      for (const sprite of r.pixelLabels) {
        const label = sprite.userData.pixelLabel;
        if (!label.anchor) continue;
        labelInView.copy(label.anchor).applyMatrix4(camera.matrixWorldInverse);
        if (labelInView.z >= -.01) { sprite.visible = false; if (label.leader) label.leader.visible = false; continue; }
        sprite.visible = true;
        const worldPerPixel = 2 * Math.max(.01, -labelInView.z) / (r.viewportHeight * camera.projectionMatrix.elements[5]);
        anchorNdc.copy(label.anchor).project(camera);
        const anchorX = (anchorNdc.x + 1) * r.viewportWidth / 2;
        const anchorY = (1 - anchorNdc.y) * r.viewportHeight / 2;
        let baseX = anchorX, baseY = anchorY - label.radius / worldPerPixel - label.height / 2 - label.gap;
        if (label.preferred) {
          preferredNdc.copy(label.preferred).project(camera);
          baseX = (preferredNdc.x + 1) * r.viewportWidth / 2;
          baseY = (1 - preferredNdc.y) * r.viewportHeight / 2;
          const dx = baseX - anchorX, dy = baseY - anchorY, length = Math.hypot(dx, dy);
          const minimum = label.radius / worldPerPixel + label.width / 2 + 9;
          if (length < minimum) {
            baseX = anchorX + (length > 2 ? dx / length : 0) * minimum;
            baseY = anchorY + (length > 2 ? dy / length : -1) * minimum;
          }
        }
        const halfW = label.width / 2, halfH = label.height / 2;
        const stepX = halfW + 10, stepY = label.height + 7;
        const offsets = [[0, 0], [-stepX, 0], [stepX, 0], [0, -stepY], [-stepX, -stepY], [stepX, -stepY], [-2 * stepX, 0], [2 * stepX, 0], [0, -2 * stepY], [-stepX, -2 * stepY], [stepX, -2 * stepY], [-2 * stepX, -stepY], [2 * stepX, -stepY], [0, -3 * stepY]];
        let best = null;
        for (const [dx, dy] of offsets) {
          const x = Math.max(halfW + 5, Math.min(r.viewportWidth - halfW - 5, baseX + dx));
          const y = Math.max(halfH + 5, Math.min(r.viewportHeight - halfH - 5, baseY + dy));
          const rect = { left: x - halfW - 3, right: x + halfW + 3, top: y - halfH - 3, bottom: y + halfH + 3 };
          let overlap = 0;
          for (const other of occupied) overlap += Math.max(0, Math.min(rect.right, other.right) - Math.max(rect.left, other.left)) * Math.max(0, Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top));
          const candidate = { x, y, rect, overlap, distance: Math.hypot(x - baseX, y - baseY) };
          if (!best || overlap < best.overlap || (overlap === best.overlap && candidate.distance < best.distance)) best = candidate;
          if (overlap === 0) break;
        }
        occupied.push(best.rect);
        sprite.position.copy(label.anchor).addScaledVector(cameraRight, (best.x - anchorX) * worldPerPixel).addScaledVector(cameraUp, (anchorY - best.y) * worldPerPixel);
        if (label.leader) {
          label.leader.visible = label.alwaysLeader || best.distance > 8;
          if (label.leader.visible) {
            const dx = best.x - anchorX, dy = best.y - anchorY, length = Math.max(.001, Math.hypot(dx, dy));
            const ux = dx / length, uy = dy / length;
            const edgeDistance = Math.min(halfW / Math.max(Math.abs(ux), .0001), halfH / Math.max(Math.abs(uy), .0001));
            const start = label.anchor.clone().addScaledVector(cameraRight, ux * label.radius).addScaledVector(cameraUp, -uy * label.radius);
            const end = label.anchor.clone().addScaledVector(cameraRight, (dx - ux * edgeDistance) * worldPerPixel).addScaledVector(cameraUp, -(dy - uy * edgeDistance) * worldPerPixel);
            const positions = label.leader.geometry.attributes.position;
            positions.setXYZ(0, start.x, start.y, start.z); positions.setXYZ(1, end.x, end.y, end.z); positions.needsUpdate = true;
          }
        }
      }
    };
    r.fit = () => {
      if (r.bounds.isEmpty()) return;
      const center = r.bounds.getCenter(new THREE.Vector3());
      const size = r.bounds.getSize(new THREE.Vector3());
      const radius = Math.max(size.length() * .48, 1.5);
      const fitV = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
      const fitH = radius / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
      r.fitDistance = Math.max(fitV, fitH) * .92;
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(.65, .38, 1).normalize().multiplyScalar(r.fitDistance));
      controls.maxDistance = Math.max(r.fitDistance * 5, 40); controls.update();
    };
    runtime.current = r;
    const resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height);
      r.viewportHeight = height; r.viewportWidth = width; r.updateLabelScale();
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const taps = createTapTracker();
    const hideHover = () => { if(hoverRef.current)hoverRef.current.style.display='none'; renderer.domElement.style.cursor='grab'; };
    const pickAt = (event) => {
      const rect=renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
      raycaster.setFromCamera(pointer,camera);
      return {rect,pick:raycaster.intersectObjects(r.pickables,false)[0]?.object.userData.pick};
    };
    const pointerMove = (event) => {
      taps.move(event);
      if(event.pointerType==='touch'||taps.isDown){hideHover();return;}
      const {rect,pick}=pickAt(event),hint=hoverRef.current, current=callbacks.current;
      if(!pick||!hint){hideHover();return;}
      const adding=pick.type==='atom'&&current.interactionMode==='build';
      renderer.domElement.style.cursor=adding?'copy':current.interactionMode==='select'||pick.type==='bond'?'pointer':'crosshair';
      const hovered=current.model?.atoms.find(a=>a.id===pick.id);
      hint.textContent=adding?`＋ ${current.buildElement}`:pick.type==='bond'?'編輯化學鍵':`${hovered?.element||''}${pick.id+1}`;
      hint.style.left=`${Math.max(8,Math.min(rect.width-100,event.clientX-rect.left+16))}px`;
      hint.style.top=`${Math.max(8,Math.min(rect.height-40,event.clientY-rect.top-35))}px`;
      hint.style.display='block';
    };
    const pointerDown = (event) => { taps.start(event); hideHover(); };
    const pointerCancel = (event) => { taps.cancel(event); hideHover(); };
    const pointerUp = (event) => {
      if (!taps.end(event)) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(r.pickables, false)[0];
      if (hit?.object.userData.pick?.type === 'atom') callbacks.current.onAtomClick?.(hit.object.userData.pick.id);
      else if (hit?.object.userData.pick?.type === 'bond') callbacks.current.onBondClick?.(hit.object.userData.pick.id);
      else callbacks.current.onBackgroundClick?.();
      hideHover();
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerCancel);
    renderer.domElement.addEventListener('lostpointercapture', pointerCancel);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerleave', hideHover);
    let frame;
    const axisQuaternion = new THREE.Quaternion(), axisVector = new THREE.Vector3();
    const animate = () => {
      frame = requestAnimationFrame(animate); controls.update(); r.positionLabels(); renderer.render(scene, camera);
      if (axesRef.current) {
        axisQuaternion.copy(camera.quaternion).invert();
        const worldAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (let i = 0; i < 3; i++) {
          axisVector.set(...worldAxes[i]).applyQuaternion(axisQuaternion);
          const x = 43 + axisVector.x * 27, y = 43 - axisVector.y * 27;
          const line = axesRef.current.querySelector(`[data-axis-line="${i}"]`);
          const label = axesRef.current.querySelector(`[data-axis-label="${i}"]`);
          line?.setAttribute('d', `M43 43L${x} ${y}`);
          label?.setAttribute('x', String(43 + axisVector.x * 35));
          label?.setAttribute('y', String(47 - axisVector.y * 35));
        }
      }
    };
    animate(); callbacks.current.onReady?.();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerCancel); renderer.domElement.removeEventListener('lostpointercapture', pointerCancel);
      renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerleave', hideHover);
      disposeGroup(group); r.resources.forEach((resource) => resource.dispose()); renderer.dispose(); renderer.forceContextLoss();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      runtime.current = null; lastFit.current = null;
    };
  }, []);

  useEffect(() => {
    const r = runtime.current; if (!r) return;
    disposeGroup(r.group); r.resources.forEach((resource) => resource.dispose()); r.resources = []; r.pickables = []; r.pixelLabels = [];
    if (!model?.atoms?.length) { for (const name of ['aria-description','data-electronic-view','data-lone-pair-count','data-p-orbital-count']) r.renderer.domElement.removeAttribute(name); r.bounds.makeEmpty(); lastFit.current = null; return; }
    const positions = new Map(model.atoms.map((a) => [a.id, V(a.position)]));
    const atoms = new Map(model.atoms.map((a) => [a.id, a]));
    const neighbors = new Map(model.atoms.map((a) => [a.id, []]));
    model.bonds.forEach((b) => { neighbors.get(b.a)?.push(b.b); neighbors.get(b.b)?.push(b.a); });
    const presentation = electronicPresentation(model, electronicView, lewisStateIndex);
    const conjugatedAtoms = new Set((model.resonance?.groups || []).flatMap(group => group.atomIds || []));
    const sphere = new THREE.SphereGeometry(1, 40, 28);
    const rod = new THREE.CylinderGeometry(1, 1, 1, 20, 1);
    r.resources.push(sphere, rod);
    const materialCache = new Map();
    function material(element) {
      if (!materialCache.has(element)) materialCache.set(element, new THREE.MeshPhysicalMaterial({ color: (ELEMENTS[element] || {}).color || '#a1a9b6', roughness: .31, metalness: .04, clearcoat: .32, clearcoatRoughness: .24 }));
      return materialCache.get(element);
    }
    const selected = new Set([...selectedAtoms, ...measurementAtoms]);
    const visible = (id) => showHydrogens || atoms.get(id)?.element !== 'H';
    for (const atom of model.atoms) {
      if (!visible(atom.id)) continue;
      const atomInfo = info(atom);
      const radius = representation === 'space-fill' ? atomInfo.vdw : representation === 'wire' ? atomInfo.radius * .40 : atomInfo.radius;
      const mesh = new THREE.Mesh(sphere, material(atom.element));
      mesh.position.copy(positions.get(atom.id)); mesh.scale.setScalar(radius);
      mesh.userData.pick = { type: 'atom', id: atom.id }; r.group.add(mesh); r.pickables.push(mesh);
      if (selected.has(atom.id)) {
        const outline = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: '#21b6ad', side: THREE.BackSide, transparent: true, opacity: .7 }));
        outline.position.copy(mesh.position); outline.scale.setScalar(radius + .065); r.group.add(outline);
        const halo = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: '#20c1b5', transparent: true, opacity: .08, depthWrite: false }));
        halo.position.copy(mesh.position); halo.scale.setScalar(radius + .15); r.group.add(halo);
      }
      const formalCharge = presentation.charges.get(atom.id) || 0;
      const displayCharge = electronicView === 'lewis' || !conjugatedAtoms.has(atom.id) ? chargeText(formalCharge) : '';
      if (showLabels || selected.has(atom.id) || (electronicView === 'lewis' && formalCharge)) {
        const text = showLabels || selected.has(atom.id) ? `${atom.element}${atom.id + 1}${displayCharge}` : `${atom.element}${displayCharge}`;
        const label = labelSprite(text, { color: selected.has(atom.id) ? '#075d5b' : '#263448', selected: selected.has(atom.id) });
        label.userData.pixelLabel.anchor = mesh.position.clone();
        label.userData.pixelLabel.radius = radius;
        label.position.copy(mesh.position); r.group.add(label);
      }
    }
    if (representation !== 'space-fill') for (const bond of model.bonds) {
      if (!visible(bond.a) || !visible(bond.b) || !positions.has(bond.a) || !positions.has(bond.b)) continue;
      const start = positions.get(bond.a), end = positions.get(bond.b);
      const axis = end.clone().sub(start).normalize();
      const normal = planeNormal(bond.a, bond.b, positions, neighbors);
      const sideways = new THREE.Vector3().crossVectors(axis, normal).normalize();
      const order = presentation.bondOrders.get(bond.id) || bond.order;
      const fractional = Math.abs(order - Math.round(order)) > 1e-6;
      const offsets = order > 2 ? [-.19, 0, .19] : order === 2 ? [-.13, .13] : fractional ? [-.10, .13] : [0];
      const radius = representation === 'wire' ? .035 : order > 1 ? .065 : .105;
      const pick = { type: 'bond', id: bond.id };
      for (let oi = 0; oi < offsets.length; oi++) {
        const offset = sideways.clone().multiplyScalar(offsets[oi]);
        const a = start.clone().add(offset), b = end.clone().add(offset), middle = a.clone().add(b).multiplyScalar(.5);
        if (fractional && oi === offsets.length - 1) {
          const count = Math.max(4, Math.round(a.distanceTo(b) / .23));
          for (let i = 0; i < count; i++) {
            const p = a.clone().lerp(b, (i + .12) / count), q = a.clone().lerp(b, (i + .70) / count);
            const segment = cylinderBetween(p, q, radius, material(atoms.get(i < count / 2 ? bond.a : bond.b).element), r.group, rod, pick);
            if (segment) r.pickables.push(segment);
          }
        } else {
          const m1 = cylinderBetween(a, middle, radius, material(atoms.get(bond.a).element), r.group, rod, pick);
          const m2 = cylinderBetween(middle, b, radius, material(atoms.get(bond.b).element), r.group, rod, pick);
          if (m1) r.pickables.push(m1); if (m2) r.pickables.push(m2);
        }
      }
      // Invisible cylinder makes slender multiple bonds comfortable to select.
      const hit = cylinderBetween(start, end, Math.max(.15, offsets.length > 1 ? .24 : .15), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), r.group, rod, pick);
      if (hit) r.pickables.push(hit);
      if (selectedBond === bond.id) cylinderBetween(start, end, offsets.length > 1 ? .29 : .18, new THREE.MeshBasicMaterial({ color: '#31bbae', transparent: true, opacity: .22, depthWrite: false }), r.group, rod);
    }
    const lpMaterial = new THREE.MeshPhysicalMaterial({ color: '#3cc9bd', transparent: true, opacity: .24, roughness: .4, depthWrite: false, side: THREE.DoubleSide });
    const dotMaterial = new THREE.MeshBasicMaterial({ color: '#168f89' });
    r.resources.push(lpMaterial, dotMaterial);
    let displayedPairs = 0;
    if (showLonePairs) for (const atom of model.atoms) {
      if (!visible(atom.id)) continue;
      for (const pair of displayedLonePairs(atom, presentation.pairCounts.get(atom.id), electronicView, positions, neighbors)) {
        const rawDirection = Array.isArray(pair) ? pair : pair.direction;
        if (!Array.isArray(rawDirection) || rawDirection.length !== 3) continue;
        const direction = V(rawDirection).normalize();
        if (!direction.lengthSq()) continue;
        displayedPairs++;
        // Lewis uses one consistent pair-of-dots notation. The hybrid view
        // separates local pairs from electrons counted across the pi system.
        if (electronicView !== 'lewis') {
          const lobe = new THREE.Mesh(sphere, lpMaterial);
          lobe.position.copy(positions.get(atom.id)).addScaledVector(direction, .72);
          lobe.quaternion.setFromUnitVectors(Y_AXIS, direction);
          lobe.scale.set(.28, .52, .28); lobe.renderOrder = 2; r.group.add(lobe);
        }
        if (electronicView === 'lewis') {
          const label = electronPairSprite();
          const anchor = positions.get(atom.id).clone();
          label.position.copy(anchor);
          label.userData.pixelLabel.anchor = anchor;
          label.userData.pixelLabel.radius = representation === 'space-fill' ? info(atom).vdw : info(atom).radius;
          label.userData.pixelLabel.preferred = anchor.clone().addScaledVector(direction, representation === 'space-fill' ? info(atom).vdw + .5 : .92);
          r.group.add(label);
        } else {
          const perpendicular = safePerpendicular(direction);
          for (const sign of [-1, 1]) {
            const dot = new THREE.Mesh(sphere, dotMaterial);
            dot.position.copy(positions.get(atom.id)).addScaledVector(direction, .87).addScaledVector(perpendicular, sign * .085);
            dot.scale.setScalar(.046); r.group.add(dot);
          }
        }
      }
    }
    const piOrbitals = showPi ? alignedPiOrbitals(model.bonds, positions, neighbors, model.atoms).filter(({atomId}) => visible(atomId)) : [];
    const piSystems = (model.resonance?.groups || []).filter(group => Number.isFinite(group.piElectrons));
    const systemDescription = piSystems.map((group, index) => `π 系統 ${index + 1} 共 ${group.piElectrons} 個電子`).join('；');
    r.renderer.domElement.setAttribute('data-electronic-view', electronicView);
    r.renderer.domElement.setAttribute('data-lone-pair-count', String(displayedPairs));
    r.renderer.domElement.setAttribute('data-p-orbital-count', String(piOrbitals.length));
    r.renderer.domElement.setAttribute('aria-description', `${electronicView === 'lewis' ? 'Lewis 共振式' : '離域示意'}；${electronicView === 'lewis' ? 'Lewis' : '局域'}孤電子對顯示 ${displayedPairs} 對；p 軌域顯示 ${piOrbitals.length} 個，每個有兩葉瓣。${systemDescription ? systemDescription + '。' : ''}電子點只表示計數，軌域形狀為示意。`);
    if (showPi) {
      const piPositive = new THREE.MeshPhysicalMaterial({ color: '#a59de0', transparent: true, opacity: .19, depthWrite: false, roughness: .5 });
      const piNegative = new THREE.MeshPhysicalMaterial({ color: '#6da8d9', transparent: true, opacity: .19, depthWrite: false, roughness: .5 });
      r.resources.push(piPositive, piNegative);
      for (const { atomId, direction } of piOrbitals) {
        if (!visible(atomId)) continue;
        for (const sign of [-1, 1]) {
          const lobe = new THREE.Mesh(sphere, sign > 0 ? piPositive : piNegative);
          lobe.position.copy(positions.get(atomId)).addScaledVector(direction, sign * .62);
          lobe.quaternion.setFromUnitVectors(Y_AXIS, direction);
          lobe.scale.set(.31, .48, .31); lobe.renderOrder = 1; r.group.add(lobe);
        }
      }
    }
    addMeasurement(r.group, measurementAtoms, positions);
    r.group.traverse(item => { if (item.userData.pixelLabel) r.pixelLabels.push(item); });
    // Stable priority: measurements, selected atoms, then the original atom IDs.
    r.pixelLabels.sort((a, b) => b.userData.pixelLabel.priority - a.userData.pixelLabel.priority);
    if (r.pixelLabels.length) {
      const leaderMaterials = new Map();
      for (const sprite of r.pixelLabels) {
        const color = sprite.userData.pixelLabel.leaderColor || '#526b7e';
        if (!leaderMaterials.has(color)) leaderMaterials.set(color, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .52, depthTest: false, depthWrite: false, toneMapped: false }));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(geometry, leaderMaterials.get(color));
        line.visible = false; line.frustumCulled = false; line.renderOrder = 9;
        sprite.userData.pixelLabel.leader = line; r.group.add(line);
      }
    }
    r.updateLabelScale();
    r.bounds.setFromPoints([...positions.values()]);
    r.bounds.expandByScalar(representation === 'space-fill' ? Math.max(...model.atoms.map((atom) => info(atom).vdw)) : showLonePairs || showPi ? 1.25 : .5);
    const signature = `${model.smiles || ''}|${model.atoms.length}|${model.bonds.length}`;
    if (lastFit.current !== signature) { lastFit.current = signature; r.fit(); }
  }, [model, selectedAtoms, selectedBond, showHydrogens, showLonePairs, showLabels, showPi, electronicView, lewisStateIndex, representation, measurementAtoms]);

  return <div className="molecule-scene" ref={hostRef}>
    <span className="scene-hover-hint" ref={hoverRef} aria-hidden="true"/>
    {model&&(showLonePairs||showPi)&&<div className="electron-legend" aria-label="電子對圖例">
      {showLonePairs&&<span><i className="electron-dots"/>{electronicView==='lewis'?'Lewis 計數 · 每組 1 對':'局域電子對'}</span>}
      {electronicView!=='lewis'&&!!model.resonance?.groups?.length&&<span className="pi-system-count"><svg viewBox="0 0 28 20" aria-hidden="true"><path d="M2 10h24"/><ellipse cx="6" cy="5" rx="3" ry="4"/><ellipse cx="14" cy="5" rx="3" ry="4"/><ellipse cx="22" cy="5" rx="3" ry="4"/><ellipse cx="6" cy="15" rx="3" ry="4"/><ellipse cx="14" cy="15" rx="3" ry="4"/><ellipse cx="22" cy="15" rx="3" ry="4"/></svg>{model.resonance.groups.length>1?model.resonance.groups.length+' 組 ':''}π 系統 · {model.resonance.groups.reduce((sum,group)=>sum+(Number.isFinite(group.piElectrons)?group.piElectrons:0),0)} e⁻</span>}
      {electronicView!=='lewis'&&!!model.resonance?.equivalentBondGroups?.length&&<span><i className="partial-bond-symbol"/>等價鍵</span>}
      {showPi&&<span className="orbital-caption">p 軌域示意 · 雙葉為同一軌域</span>}
    </div>}
    {error && <div className="scene-error" role="alert">{error}</div>}
    {!model?.atoms?.length && !error && <div className="scene-empty"><span className="scene-empty-symbol">＋</span><strong>從一個原子開始</strong><span>建立連接關係，計算真實的三維構形</span></div>}
    <div className="scene-axis" aria-hidden="true"><svg ref={axesRef} width="86" height="86" viewBox="0 0 86 86"><path data-axis-line="0" d="M43 43L70 43" stroke="#a63c3c"/><path data-axis-line="1" d="M43 43L43 16" stroke="#275d95"/><path data-axis-line="2" d="M43 43L25 61" stroke="#2e7147"/><circle cx="43" cy="43" r="2.8" fill="#45566a"/><text data-axis-label="0" x="78" y="47" fill="#a63c3c">X</text><text data-axis-label="1" x="43" y="12" fill="#275d95">Y</text><text data-axis-label="2" x="16" y="74" fill="#2e7147">Z</text></svg><span>3D</span></div>
  </div>;
});

export default MoleculeScene;
