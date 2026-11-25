import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Float, Lightformer, ContactShadows } from "@react-three/drei";
import * as THREE from "three";

/**
 * Original "engineering intelligence" object: a polished pearl-metal core, glass shell,
 * amber orbital rings, connected intelligence nodes and a light particle field.
 * Responds to the pointer; slows to a still pose under prefers-reduced-motion.
 */
const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function fibonacciSphere(n: number, r: number) {
  const pts: THREE.Vector3[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const t = phi * i;
    pts.push(new THREE.Vector3(Math.cos(t) * rad * r, y * r, Math.sin(t) * rad * r));
  }
  return pts;
}

function NeuralNetwork() {
  const group = useRef<THREE.Group>(null!);
  const nodes = useMemo(() => fibonacciSphere(46, 1.62), []);
  const lines = useMemo(() => {
    const pos: number[] = [];
    nodes.forEach((a, i) => {
      const near = nodes.map((b, j) => ({ j, d: a.distanceTo(b) })).filter((x) => x.j > i).sort((x, y) => x.d - y.d).slice(0, 2);
      for (const n of near) pos.push(a.x, a.y, a.z, nodes[n.j].x, nodes[n.j].y, nodes[n.j].z);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [nodes]);
  const accent = useMemo(() => new Set([3, 11, 19, 27, 34, 41]), []);
  useFrame((_, dt) => {
    if (!reduced) group.current.rotation.y += dt * 0.08;
  });
  return (
    <group ref={group}>
      <lineSegments geometry={lines}>
        <lineBasicMaterial color="#B9B5AA" transparent opacity={0.45} />
      </lineSegments>
      {nodes.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[accent.has(i) ? 0.055 : 0.032, 16, 16]} />
          <meshStandardMaterial color={accent.has(i) ? "#D99A28" : "#F2F0EA"} emissive={accent.has(i) ? "#D99A28" : "#000"} emissiveIntensity={accent.has(i) ? 0.6 : 0} metalness={0.6} roughness={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function Rings() {
  const a = useRef<THREE.Mesh>(null!);
  const b = useRef<THREE.Mesh>(null!);
  const c = useRef<THREE.Mesh>(null!);
  useFrame((_, dt) => {
    if (reduced) return;
    a.current.rotation.z += dt * 0.12;
    b.current.rotation.x += dt * 0.09;
    c.current.rotation.y -= dt * 0.07;
  });
  return (
    <>
      <mesh ref={a} rotation={[1.2, 0.2, 0]}>
        <torusGeometry args={[2.05, 0.012, 16, 220]} />
        <meshStandardMaterial color="#D99A28" metalness={0.9} roughness={0.2} emissive="#D99A28" emissiveIntensity={0.25} />
      </mesh>
      <mesh ref={b} rotation={[0.4, 1.1, 0.3]}>
        <torusGeometry args={[2.35, 0.008, 16, 220]} />
        <meshStandardMaterial color="#C9C6BD" metalness={1} roughness={0.15} />
      </mesh>
      <mesh ref={c} rotation={[1.9, -0.5, 0.8]}>
        <torusGeometry args={[2.62, 0.006, 16, 220]} />
        <meshStandardMaterial color="#E8D3A8" metalness={0.8} roughness={0.3} />
      </mesh>
    </>
  );
}

function Particles({ count = 260 }) {
  const ref = useRef<THREE.Points>(null!);
  const geo = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 2.8 + Math.random() * 2.6;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.6, r * Math.sin(p) * Math.sin(t)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, [count]);
  useFrame((_, dt) => {
    if (!reduced) ref.current.rotation.y -= dt * 0.02;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial size={0.025} color="#B98A35" transparent opacity={0.55} sizeAttenuation />
    </points>
  );
}

function Core() {
  return (
    <Float speed={reduced ? 0 : 1.2} rotationIntensity={0.25} floatIntensity={0.5}>
      {/* polished pearl-metal core */}
      <mesh>
        <icosahedronGeometry args={[0.95, 12]} />
        <meshPhysicalMaterial color="#F6F4EE" metalness={0.32} roughness={0.16} clearcoat={1} clearcoatRoughness={0.06} sheen={1} sheenColor="#F6E6C8" sheenRoughness={0.4} iridescence={0.25} iridescenceIOR={1.3} envMapIntensity={1.4} />
      </mesh>
      {/* glass shell */}
      <mesh>
        <sphereGeometry args={[1.28, 64, 64]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.16} roughness={0.02} metalness={0} clearcoat={1} clearcoatRoughness={0} envMapIntensity={2} depthWrite={false} />
      </mesh>
      <NeuralNetwork />
    </Float>
  );
}

function Rig() {
  const { camera, pointer } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (reduced) return;
    target.set(pointer.x * 0.8, pointer.y * 0.5 + 0.2, 7.2);
    camera.position.lerp(target, 0.035);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function Hero3D() {
  return (
    <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0.4, 9], fov: 38 }} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }} aria-label="Interactive 3D model of the DevForge intelligence core">
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 6, 5]} intensity={1.6} color="#fff6e6" />
      <pointLight position={[-4, -2, 3]} intensity={18} color="#D99A28" distance={12} />
      <group position={[0, 0.1, 0]}>
        <Core />
        <Rings />
        <Particles />
      </group>
      <ContactShadows position={[0, -2.55, 0]} opacity={0.28} scale={9} blur={2.6} far={4} color="#8a7a5c" />
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={2.5} color="#fff8ec" position={[0, 4, -6]} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={1.4} color="#f2d39a" position={[-6, 1, 2]} rotation-y={Math.PI / 2} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#ffffff" position={[6, 0, 2]} rotation-y={-Math.PI / 2} scale={[6, 3, 1]} />
        <Lightformer form="circle" intensity={1.8} color="#ffffff" position={[0, -5, 0]} rotation-x={Math.PI / 2} scale={4} />
      </Environment>
      <Rig />
    </Canvas>
  );
}
