import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html, Environment } from "@react-three/drei";
import * as THREE from "three";
import { forceSimulation, forceLink, forceManyBody, forceCenter } from "d3-force";
import { SEV_COLOR, LANG_COLOR } from "../../lib/format";

/** Navigable 3D repository constellation: files as nodes (size = LOC, colour = worst finding), imports as links. */
export default function RepoGraph3D({ nodes, edges }: { nodes: any[]; edges: any[] }) {
  const [hover, setHover] = useState<any>(null);
  const [sel, setSel] = useState<any>(null);
  const layout = useMemo(() => {
    const list = nodes.filter((n) => !n.is_test).slice(0, 600);
    const ids = new Set(list.map((n) => n.id));
    const sn = list.map((n) => ({ ...n, x: Math.random() * 10, y: Math.random() * 10, z: (Math.random() - 0.5) * 30 }));
    const sl = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
    const sim = forceSimulation(sn as any).force("link", forceLink(sl as any).id((d: any) => d.id).distance(4)).force("charge", forceManyBody().strength(-14)).force("center", forceCenter(0, 0)).stop();
    for (let i = 0; i < 200; i++) sim.tick();
    // z from directory depth for spatial layering
    const pos = new Map(sn.map((n: any) => [n.id, new THREE.Vector3(n.x * 0.5, n.y * 0.5, (n.path.split("/").length - 2) * 3)]));
    const center = new THREE.Vector3();
    pos.forEach((v) => center.add(v));
    center.divideScalar(Math.max(1, pos.size));
    pos.forEach((v) => v.sub(center));
    const lineGeo = new THREE.BufferGeometry();
    const arr: number[] = [];
    for (const l of sl) {
      const a = pos.get(typeof l.source === "object" ? (l.source as any).id : l.source);
      const b = pos.get(typeof l.target === "object" ? (l.target as any).id : l.target);
      if (a && b) arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return { list, pos, lineGeo };
  }, [nodes, edges]);
  const group = useRef<THREE.Group>(null!);
  return (
    <Canvas camera={{ position: [0, 0, 60], fov: 50 }} dpr={[1, 1.5]}>
      <color attach="background" args={["#F7F6F2"]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} />
      <Environment preset="studio" />
      <AutoRotate group={group} paused={!!hover || !!sel} />
      <group ref={group}>
        <lineSegments geometry={layout.lineGeo}><lineBasicMaterial color="#C9C6BD" transparent opacity={0.45} /></lineSegments>
        {layout.list.map((n) => {
          const p = layout.pos.get(n.id)!;
          const r = 0.25 + Math.min(1.2, Math.sqrt(n.loc) / 22);
          const color = n.worst ? SEV_COLOR[n.worst] : LANG_COLOR[n.language] ?? "#B5B1A6";
          return (
            <mesh key={n.id} position={p} onPointerOver={(e) => { e.stopPropagation(); setHover(n); document.body.style.cursor = "pointer"; }} onPointerOut={() => { setHover(null); document.body.style.cursor = ""; }} onClick={(e) => { e.stopPropagation(); setSel(sel?.id === n.id ? null : n); }}>
              <sphereGeometry args={[r, 20, 20]} />
              <meshStandardMaterial color={color} metalness={0.45} roughness={0.3} emissive={sel?.id === n.id ? "#D99A28" : "#000"} emissiveIntensity={sel?.id === n.id ? 0.5 : 0} />
              {(hover?.id === n.id || sel?.id === n.id) && (
                <Html distanceFactor={40} position={[0, r + 0.6, 0]} center>
                  <div className="pointer-events-none whitespace-nowrap rounded-lg border border-line bg-white/95 px-2.5 py-1.5 font-mono text-[11px] text-ink shadow-lg">
                    {n.path}<div className="font-sans text-[10px] text-muted">{n.loc} LOC · {n.findings} findings</div>
                  </div>
                </Html>
              )}
            </mesh>
          );
        })}
      </group>
      <OrbitControls enableDamping makeDefault />
    </Canvas>
  );
}

function AutoRotate({ group, paused }: { group: React.RefObject<THREE.Group>; paused: boolean }) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useFrame((_, dt) => {
    if (!paused && !reduced && group.current) group.current.rotation.y += dt * 0.05;
  });
  return null;
}
