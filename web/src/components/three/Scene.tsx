import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

/** Lazy-loads a WebGL scene only when visible and supported; renders a static 2D fallback otherwise. */
function webglSupported() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function PearlFallback() {
  return (
    <div className="relative grid h-full w-full place-items-center" aria-hidden>
      <div className="absolute size-[62%] max-w-[420px] rounded-full border border-amber/40" style={{ transform: "rotateX(70deg) rotateZ(-20deg)" }} />
      <div className="absolute size-[72%] max-w-[480px] rounded-full border border-silver/60" style={{ transform: "rotateX(60deg) rotateZ(35deg)" }} />
      <div className="size-[34%] max-w-[230px] rounded-full shadow-[0_40px_80px_-30px_rgba(90,80,60,.45)]" style={{ background: "radial-gradient(circle at 32% 28%, #ffffff 0%, #ece9e1 35%, #c9c5ba 70%, #9e998d 100%)" }} />
    </div>
  );
}

const Hero = lazy(() => import("./Hero3D"));

export function HeroScene() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ok] = useState(() => webglSupported());
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "200px" });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="h-full w-full">
      {ok && visible ? (
        <Boundary fallback={<PearlFallback />}>
          <Suspense fallback={<PearlFallback />}>
            <Hero />
          </Suspense>
        </Boundary>
      ) : (
        <PearlFallback />
      )}
    </div>
  );
}

export { Boundary as SceneBoundary, webglSupported };
