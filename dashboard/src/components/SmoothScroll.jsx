import { useEffect } from "react";
import Lenis from "lenis";

export let lenis;

export default function SmoothScroll() {
  useEffect(() => {
    lenis = new Lenis({
      duration: 2,
      smoothWheel: true,
      wheelMultiplier: 0.75,
      touchMultiplier: 1.5,
    });

    let rafId;

    function raf(time) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }

    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
    };
  }, []);

  return null;
}